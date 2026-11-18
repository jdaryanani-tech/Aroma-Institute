import { and, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import { admissionsConversationDispatchGrants as grants,
  admissionsLeads,
  admissionsLeadContactPreferences as preferences } from "@shared/admissions-schema";
import { admissionsLeadAssignments } from "@shared/schema";
import { lmsUserRoles, lmsUsers } from "@shared/lms-schema";
import { db } from "../db";
import { canReadCanonicalLead, crmAccessLevel, type CrmPrincipal } from "../crm/authorization";
import {
  beginAvniDispatchAttempt,
  issueAvniDispatchGrant,
  validateAvniDispatchGrantForBegin,
  type AvniDispatchGrant,
  type AvniDispatchGrantBinding,
  type DispatchConsentSnapshot,
  type SupabaseBeginSendOutcome,
} from "../integrations/avni-dispatch-protocol";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type GrantRow = typeof grants.$inferSelect;
export type NewAvniDispatchGrantBinding = Omit<
  AvniDispatchGrantBinding,
  "consentEpoch" | "actorUserId" | "actorAccessLevel" | "assignmentAssigneeUserId" | "assignmentVersion"
>;

async function schemaReady(tx: Pick<Transaction, "execute">): Promise<boolean> {
  const result = await tx.execute<{ ready: boolean }>(sql`
    SELECT (
      to_regclass('public.admissions_conversation_dispatch_grants') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='admissions_lead_contact_preferences'
          AND column_name='consent_epoch')
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='admissions_conversation_dispatch_grants'
          AND column_name='actor_user_id')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgname='admissions_consent_epoch_guard'
          AND tgrelid='public.admissions_lead_contact_preferences'::regclass
          AND tgenabled IN ('O','A') AND NOT tgisinternal)
    ) AS ready
  `);
  return result.rows[0]?.ready === true;
}

async function transactionTime(tx: Pick<Transaction, "execute">, explicit?: Date): Promise<Date> {
  if (explicit) return explicit;
  const result = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  const value = result.rows[0]?.now;
  if (!value) throw new Error("AVNI_DISPATCH_DATABASE_TIME_UNAVAILABLE");
  return value instanceof Date ? value : new Date(value);
}

function toModel(row: GrantRow): AvniDispatchGrant | null {
  if (
    row.actorUserId === null ||
    (row.actorAccessLevel !== "admin" && row.actorAccessLevel !== "admissions") ||
    row.assignmentVersion === null
  ) return null;
  return {
    id: row.id,
    idempotencyKey: row.grantIdempotencyKey,
    binding: {
      canonicalLeadId: row.leadId,
      actorUserId: row.actorUserId,
      actorAccessLevel: row.actorAccessLevel,
      assignmentAssigneeUserId: row.assignmentAssigneeUserId,
      assignmentVersion: row.assignmentVersion,
      supabaseThreadId: row.supabaseThreadId,
      supabaseOutboxId: row.supabaseOutboxId,
      supabaseMessageId: row.supabaseMessageId,
      supabaseAttemptId: row.supabaseAttemptId,
      messageIdempotencyKey: row.messageIdempotencyKey,
      consentEpoch: Number(row.consentEpoch),
      controlVersion: Number(row.controlVersion),
      attemptNumber: row.attemptNumber,
      leaseTokenHash: row.leaseTokenHash,
      payloadHash: row.payloadHash,
    },
    state: row.state as AvniDispatchGrant["state"],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    redeemedAt: row.redeemedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    safeOutcome: row.safeOutcome as AvniDispatchGrant["safeOutcome"],
  };
}

type TrustedActorScope = {
  actorUserId: number;
  actorAccessLevel: "admin" | "admissions";
  assignmentAssigneeUserId: number | null;
  assignmentVersion: number;
};

async function resolveTrustedActorScope(
  tx: Transaction,
  request: Pick<Request, "session" | "lmsUser">,
  leadId: string,
): Promise<TrustedActorScope | null> {
  const sessionUserId = request.session?.lmsUserId;
  const attachedUserId = request.lmsUser?.id;
  if (
    typeof sessionUserId !== "number" ||
    !Number.isSafeInteger(sessionUserId) ||
    typeof attachedUserId !== "number" ||
    !Number.isSafeInteger(attachedUserId) ||
    sessionUserId !== attachedUserId
  ) return null;

  const [actor] = await tx.select({ id: lmsUsers.id, isActive: lmsUsers.isActive })
    .from(lmsUsers).where(eq(lmsUsers.id, sessionUserId)).for("share");
  if (!actor || !actor.isActive) return null;
  const roleRows = await tx.select({ role: lmsUserRoles.role })
    .from(lmsUserRoles).where(eq(lmsUserRoles.userId, sessionUserId))
    .orderBy(lmsUserRoles.role).for("share");
  const principal: CrmPrincipal = {
    id: sessionUserId,
    roles: roleRows.map(row => String(row.role)),
  };
  const accessLevel = crmAccessLevel(principal);
  if (accessLevel !== "admin" && accessLevel !== "admissions") return null;

  const [lead] = await tx.select({ id: admissionsLeads.id })
    .from(admissionsLeads).where(eq(admissionsLeads.id, leadId)).for("share");
  if (!lead) return null;
  const assignmentRows = await tx.select({
    assigneeUserId: admissionsLeadAssignments.assigneeUserId,
    version: admissionsLeadAssignments.version,
  }).from(admissionsLeadAssignments)
    .where(eq(admissionsLeadAssignments.leadId, leadId)).for("share");
  if (assignmentRows.length > 1) return null;
  const assignment = assignmentRows[0];
  const assigneeUserId = assignment?.assigneeUserId ?? null;
  if (!canReadCanonicalLead(principal, leadId, assigneeUserId)) return null;
  const assignmentVersion = assignment?.version ?? 0;
  if (!Number.isSafeInteger(assignmentVersion) || assignmentVersion < 0) return null;
  return {
    actorUserId: actor.id,
    actorAccessLevel: accessLevel,
    assignmentAssigneeUserId: assigneeUserId,
    assignmentVersion,
  };
}

function scopeMatchesBinding(scope: TrustedActorScope, binding: AvniDispatchGrantBinding): boolean {
  return scope.actorUserId === binding.actorUserId
    && scope.actorAccessLevel === binding.actorAccessLevel
    && scope.assignmentAssigneeUserId === binding.assignmentAssigneeUserId
    && scope.assignmentVersion === binding.assignmentVersion;
}

/**
 * Issues or idempotently returns a grant while locking the authoritative
 * Replit consent row. This is an internal building block only; no route or
 * provider dispatcher invokes it in this change.
 */
export async function issueAvniDispatchGrantInTransaction(
  tx: Transaction,
  input: {
    request: Pick<Request, "session" | "lmsUser">;
    binding: NewAvniDispatchGrantBinding;
    now?: Date;
    ttlMs?: number;
  },
) {
  if (!await schemaReady(tx)) return { code: "dispatch_schema_unavailable" as const, grant: null };
  const actorScope = await resolveTrustedActorScope(tx, input.request, input.binding.canonicalLeadId);
  if (!actorScope) return { code: "dispatch_actor_unavailable" as const, grant: null };
  const [preference] = await tx.select({
    consentStatus: preferences.consentStatus,
    optedOutAt: preferences.optedOutAt,
    consentEpoch: preferences.consentEpoch,
  }).from(preferences).where(eq(preferences.leadId, input.binding.canonicalLeadId)).for("update");
  if (!preference) return { code: "grant_revoked" as const, grant: null };

  const binding: AvniDispatchGrantBinding = {
    ...input.binding,
    ...actorScope,
    consentEpoch: Number(preference.consentEpoch),
  };
  const [existingRow] = await tx.select().from(grants)
    .where(eq(grants.supabaseAttemptId, binding.supabaseAttemptId)).for("update");
  const now = await transactionTime(tx, input.now);
  const existing = existingRow ? toModel(existingRow) : null;
  if (existingRow && !existing) return { code: "dispatch_authorization_changed" as const, grant: null };
  const decision = issueAvniDispatchGrant({
    binding,
    consent: {
      consentEpoch: Number(preference.consentEpoch),
      consentStatus: preference.consentStatus as DispatchConsentSnapshot["consentStatus"],
      optedOutAt: preference.optedOutAt?.toISOString() ?? null,
    },
    now,
    ttlMs: input.ttlMs,
    existing,
  });
  if (decision.code !== "grant_issued" || !decision.grant) return decision;

  const grant = decision.grant;
  await tx.insert(grants).values({
    id: grant.id,
    leadId: binding.canonicalLeadId,
    actorUserId: binding.actorUserId,
    actorAccessLevel: binding.actorAccessLevel,
    assignmentAssigneeUserId: binding.assignmentAssigneeUserId,
    assignmentVersion: binding.assignmentVersion,
    supabaseThreadId: binding.supabaseThreadId,
    supabaseOutboxId: binding.supabaseOutboxId,
    supabaseMessageId: binding.supabaseMessageId,
    supabaseAttemptId: binding.supabaseAttemptId,
    messageIdempotencyKey: binding.messageIdempotencyKey,
    grantIdempotencyKey: grant.idempotencyKey,
    consentEpoch: binding.consentEpoch,
    controlVersion: binding.controlVersion,
    attemptNumber: binding.attemptNumber,
    leaseTokenHash: binding.leaseTokenHash,
    payloadHash: binding.payloadHash,
    state: grant.state,
    createdAt: new Date(grant.createdAt),
    expiresAt: new Date(grant.expiresAt),
  });
  return decision;
}

/**
 * Performs the last Replit consent check and calls the supplied Supabase
 * begin_send adapter while the Replit consent and grant rows remain locked.
 * The callback must be a bounded, fixed RPC call. This function never invokes
 * a provider or turns its result into permission to send.
 */
export async function beginAvniDispatchInTransaction(input: {
  tx: Transaction;
  request: Pick<Request, "session" | "lmsUser">;
  grantId: string;
  now?: Date;
  beginSupabaseSend: (binding: AvniDispatchGrantBinding) => Promise<SupabaseBeginSendOutcome>;
}) {
  const { tx } = input;
  if (!await schemaReady(tx)) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "dispatch_schema_unavailable" as const,
    grant: null,
  };
  // Read the lead reference without locking, then lock in the same
  // actor/assignment -> preference -> grant order used by consent and CRM
  // writers. Re-read the grant under lock after authoritative rows are locked.
  const [initialRow] = await tx.select().from(grants).where(eq(grants.id, input.grantId));
  if (!initialRow) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "grant_replayed" as const,
    grant: null,
  };
  const actorScope = await resolveTrustedActorScope(tx, input.request, initialRow.leadId);
  if (!actorScope) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "dispatch_actor_unavailable" as const,
    grant: null,
  };
  const [preference] = await tx.select({
    consentStatus: preferences.consentStatus,
    optedOutAt: preferences.optedOutAt,
    consentEpoch: preferences.consentEpoch,
  }).from(preferences).where(eq(preferences.leadId, initialRow.leadId)).for("update");
  const consent: DispatchConsentSnapshot | null = preference ? {
    consentEpoch: Number(preference.consentEpoch),
    consentStatus: preference.consentStatus as DispatchConsentSnapshot["consentStatus"],
    optedOutAt: preference.optedOutAt?.toISOString() ?? null,
  } : null;
  if (!consent) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "grant_revoked" as const,
    grant: toModel(initialRow),
  };
  const [row] = await tx.select().from(grants).where(eq(grants.id, input.grantId)).for("update");
  if (!row) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "grant_replayed" as const,
    grant: null,
  };
  if (row.leadId !== initialRow.leadId) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "dispatch_authorization_changed" as const,
    grant: null,
  };
  const grant = toModel(row);
  if (!grant) {
    await tx.update(grants).set({ state: "revoked", safeOutcome: "send_denied" })
      .where(and(eq(grants.id, row.id), eq(grants.state, "issued")));
    return {
      allowedToBeginSend: false as const,
      providerCallAllowed: false as const,
      code: "dispatch_authorization_changed" as const,
      grant: null,
    };
  }
  if (!scopeMatchesBinding(actorScope, grant.binding)) {
    const revoked: AvniDispatchGrant = {
      ...grant,
      state: "revoked",
      completedAt: (await transactionTime(tx, input.now)).toISOString(),
      safeOutcome: "send_denied",
    };
    await tx.update(grants).set({
      state: revoked.state,
      completedAt: new Date(revoked.completedAt!),
      safeOutcome: revoked.safeOutcome,
    }).where(and(eq(grants.id, grant.id), eq(grants.state, "issued")));
    return {
      allowedToBeginSend: false as const,
      providerCallAllowed: false as const,
      code: "dispatch_authorization_changed" as const,
      grant: revoked,
    };
  }

  // Use database time only after all Replit locks are held. A grant that
  // expired while waiting for any lock is never passed to the Supabase fence.
  const lockedAt = await transactionTime(tx, input.now);

  const validation = validateAvniDispatchGrantForBegin({
    grant, binding: grant.binding, consent, now: lockedAt,
  });
  if (!validation.allowedToBeginSend) {
    if (validation.grant && validation.grant.state !== grant.state) {
      await tx.update(grants).set({
        state: validation.grant.state,
        completedAt: validation.grant.completedAt ? new Date(validation.grant.completedAt) : null,
        safeOutcome: validation.grant.safeOutcome,
      }).where(eq(grants.id, grant.id));
    }
    return validation;
  }

  let outcome: SupabaseBeginSendOutcome;
  try {
    outcome = await input.beginSupabaseSend(grant.binding);
  } catch {
    outcome = "unavailable";
  }
  // The Supabase RPC checks its own clock after acquiring thread, outbox,
  // attempt and message locks. Refresh Replit's clock after that bounded RPC
  // too: if the grant expired while Supabase was waiting, no provider call is
  // permitted and a possibly committed begin is recorded as unknown.
  const afterSupabase = await transactionTime(tx, input.now);
  const expiredDuringRpc = new Date(grant.expiresAt).getTime() <= afterSupabase.getTime();
  const decision = expiredDuringRpc && outcome !== "denied"
    ? {
      allowedToBeginSend: false as const,
      providerCallAllowed: false as const,
      code: "supabase_begin_uncertain" as const,
      grant: {
        ...grant,
        state: "unknown" as const,
        completedAt: afterSupabase.toISOString(),
        safeOutcome: "ambiguous_result" as const,
      },
    }
    : beginAvniDispatchAttempt({
      grant,
      binding: grant.binding,
      consent,
      now: afterSupabase,
      supabaseOutcome: outcome,
    });
  if (decision.grant && decision.grant.state !== grant.state) {
    await tx.update(grants).set({
      state: decision.grant.state,
      redeemedAt: decision.grant.redeemedAt ? new Date(decision.grant.redeemedAt) : null,
      completedAt: decision.grant.completedAt ? new Date(decision.grant.completedAt) : null,
      safeOutcome: decision.grant.safeOutcome,
    }).where(and(eq(grants.id, grant.id), eq(grants.state, "issued")));
  }
  return decision;
}
