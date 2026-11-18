import { and, eq, sql } from "drizzle-orm";
import { admissionsConversationDispatchGrants as grants,
  admissionsLeadContactPreferences as preferences } from "@shared/admissions-schema";
import { db } from "../db";
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
export type NewAvniDispatchGrantBinding = Omit<AvniDispatchGrantBinding, "consentEpoch">;

async function schemaReady(tx: Pick<Transaction, "execute">): Promise<boolean> {
  const result = await tx.execute<{ ready: boolean }>(sql`
    SELECT to_regclass('admissions_conversation_dispatch_grants') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema()
          AND table_name='admissions_lead_contact_preferences'
          AND column_name='consent_epoch') AS ready
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

function toModel(row: GrantRow): AvniDispatchGrant {
  return {
    id: row.id,
    idempotencyKey: row.grantIdempotencyKey,
    binding: {
      canonicalLeadId: row.leadId,
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

/**
 * Issues or idempotently returns a grant while locking the authoritative
 * Replit consent row. This is an internal building block only; no route or
 * provider dispatcher invokes it in this change.
 */
export async function issueAvniDispatchGrantInTransaction(
  tx: Transaction,
  input: {
    binding: NewAvniDispatchGrantBinding;
    now?: Date;
    ttlMs?: number;
  },
) {
  if (!await schemaReady(tx)) return { code: "dispatch_schema_unavailable" as const, grant: null };
  const now = await transactionTime(tx,input.now);
  const [preference] = await tx.select({
    consentStatus: preferences.consentStatus,
    optedOutAt: preferences.optedOutAt,
    consentEpoch: preferences.consentEpoch,
  }).from(preferences).where(eq(preferences.leadId, input.binding.canonicalLeadId)).for("update");
  if (!preference) return { code: "grant_revoked" as const, grant: null };

  const binding: AvniDispatchGrantBinding = {
    ...input.binding,
    consentEpoch: Number(preference.consentEpoch),
  };
  const [existingRow] = await tx.select().from(grants)
    .where(eq(grants.supabaseAttemptId, binding.supabaseAttemptId)).for("update");
  const existing = existingRow ? toModel(existingRow) : null;
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
  grantId: string;
  binding: AvniDispatchGrantBinding;
  now?: Date;
  beginSupabaseSend: (binding: AvniDispatchGrantBinding) => Promise<SupabaseBeginSendOutcome>;
}) {
  const { tx, binding } = input;
  if (!await schemaReady(tx)) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "dispatch_schema_unavailable" as const,
    grant: null,
  };
  const now=await transactionTime(tx,input.now);
  // Read the lead reference without locking, then lock in the same
  // preference-before-grant order used by every consent writer. Re-read the
  // grant under lock after the authoritative consent row is locked.
  const [initialRow] = await tx.select().from(grants).where(eq(grants.id, input.grantId));
  if (!initialRow) return {
    allowedToBeginSend: false as const,
    providerCallAllowed: false as const,
    code: "grant_replayed" as const,
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
  const grant = toModel(row);

  const validation = validateAvniDispatchGrantForBegin({
    grant, binding, consent, now,
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
    outcome = await input.beginSupabaseSend(binding);
  } catch {
    outcome = "unavailable";
  }
  const decision = beginAvniDispatchAttempt({
    grant, binding, consent, now, supabaseOutcome: outcome,
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
