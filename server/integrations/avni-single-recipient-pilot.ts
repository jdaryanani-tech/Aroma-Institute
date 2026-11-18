import { createHash } from "node:crypto";
import type { Request } from "express";
import type { Pool } from "pg";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import {
  createAvniProviderReferenceAliases,
  signAvniProviderReference,
  type AvniHmacKeyProvider,
} from "./avni-provider-reference-hmac";
import {
  AVNI_PILOT_MESSAGE,
  type EvolutionPilotTransport,
} from "./evolution-pilot-transport";
import {
  type AvniPilotSupabaseWriterContract,
  type PilotHumanClaim,
  type PilotOutboxSnapshot,
} from "./avni-pilot-supabase-writer";
import type {
  AvniPilotDispatchHandler,
  AvniPilotStatusHandler,
} from "./avni-pilot-dispatch-route";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const e164Pattern = /^\+[1-9][0-9]{7,14}$/;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function pilotMessageIdempotencyKey(canonicalLeadId: string, requestKey: string): string {
  if (!uuidPattern.test(canonicalLeadId) || !uuidPattern.test(requestKey)) {
    throw new Error("AVNI_PILOT_IDEMPOTENCY_INPUT_INVALID");
  }
  return `message:v1:${digest(
    `avni-single-recipient-pilot-v1:${canonicalLeadId.toLowerCase()}`,
  )}`;
}

export function createAvniPilotStatusReader(
  store: {
    readStatus(idempotencyKey: string): Promise<{
      state: PilotOutboxSnapshot["state"];
      attemptNumber: number;
    } | null>;
  } | null,
): AvniPilotStatusHandler {
  return async (_request, input) => {
    if (!store) {
      return { state: "unavailable", attemptNumber: 0, safeCode: "status_reader_unavailable" };
    }
    try {
      const snapshot = await store.readStatus(
        pilotMessageIdempotencyKey(input.canonicalLeadId, input.idempotencyKey),
      );
      if (!snapshot) return { state: "not_found", attemptNumber: 0, safeCode: "pilot_not_found" };
      const safeCode = snapshot.state === "unknown" || snapshot.state === "sending"
        ? "manual_provider_reconciliation_required"
        : snapshot.state === "failed" || snapshot.state === "cancelled"
          ? "terminal_no_retry"
          : snapshot.state === "accepted" || snapshot.state === "delivered"
            ? "provider_accepted"
            : "dispatch_in_progress";
      return {
        state: snapshot.state,
        attemptNumber: snapshot.attemptNumber,
        safeCode,
      };
    } catch {
      return { state: "unavailable", attemptNumber: 0, safeCode: "status_reader_unavailable" };
    }
  };
}

type PilotAuthorization = {
  actorUserId: number;
  assignmentAssigneeUserId: number | null;
  assignmentVersion: number;
  consentEpoch: number;
};
type AuthorizationOutcome =
  | { ok: true; scope: PilotAuthorization }
  | { ok: false; code: "actor_unavailable" | "lead_unavailable" | "assignment_denied"
      | "recipient_mismatch" | "consent_not_granted" | "schema_unavailable" };
export type PilotDispatchBinding = {
  canonicalLeadId: string;
  supabaseThreadId: string;
  supabaseOutboxId: string;
  supabaseMessageId: string;
  supabaseAttemptId: string;
  messageIdempotencyKey: string;
  controlVersion: number;
  attemptNumber: number;
  leaseTokenHash: string;
  payloadHash: string;
};
export type PilotGrantEngine = {
  issue(
    request: Pick<Request, "session" | "lmsUser">,
    binding: PilotDispatchBinding,
  ): Promise<{ code: string; grant: { id: string; state: string } | null }>;
  begin(
    request: Pick<Request, "session" | "lmsUser">,
    grantId: string,
    beginSupabaseSend: () => Promise<"begun" | "denied" | "already_begun" | "unavailable">,
  ): Promise<{ code: string; providerCallAllowed: boolean }>;
  settle(grantId: string, outcome: "accepted" | "failed" | "unknown"): Promise<boolean>;
};

async function authorizePilotRecipient(
  pool: Pick<Pool, "connect">,
  request: Pick<Request, "session" | "lmsUser">,
  leadId: string,
  recipientE164: string,
): Promise<AuthorizationOutcome> {
  const sessionId = request.session?.lmsUserId;
  if (!Number.isSafeInteger(sessionId) || typeof sessionId !== "number"
    || request.lmsUser?.id !== sessionId) return { ok: false, code: "actor_unavailable" };
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const actor = await client.query<{ id: number; is_active: boolean }>(
      "SELECT id,is_active FROM lms_users WHERE id=$1::integer FOR SHARE",
      [sessionId],
    );
    if (actor.rows.length !== 1 || actor.rows[0].is_active !== true) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "actor_unavailable" };
    }
    const roles = await client.query<{ role: string }>(
      "SELECT role FROM lms_user_roles WHERE user_id=$1::integer ORDER BY role FOR SHARE",
      [sessionId],
    );
    if (!roles.rows.some(row => row.role === "admin")) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "actor_unavailable" };
    }
    const lead = await client.query<{ id: string; canonical_phone: string }>(
      "SELECT id,canonical_phone FROM admissions_leads WHERE id=$1::uuid FOR SHARE",
      [leadId],
    );
    if (lead.rows.length !== 1) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "lead_unavailable" };
    }
    const assignment = await client.query<{
      assignee_user_id: number | null;
      version: number;
    }>(
      "SELECT assignee_user_id,version FROM admissions_lead_assignments WHERE lead_id=$1::uuid FOR SHARE",
      [leadId],
    );
    if (assignment.rows.length > 1) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "assignment_denied" };
    }
    const currentDigits = normalizeIndianMobile(`+${lead.rows[0].canonical_phone}`);
    const targetDigits = normalizeIndianMobile(recipientE164);
    if (!currentDigits || !targetDigits || currentDigits !== targetDigits) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "recipient_mismatch" };
    }
    const preferences = await client.query<{
      consent_status: string;
      opted_out_at: Date | string | null;
      consent_epoch: number | string;
    }>(
      `SELECT consent_status,opted_out_at,consent_epoch
       FROM admissions_lead_contact_preferences WHERE lead_id=$1::uuid FOR SHARE`,
      [leadId],
    );
    if (preferences.rows.length !== 1) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "consent_not_granted" };
    }
    const preference = preferences.rows[0];
    const epoch = Number(preference.consent_epoch);
    if (preference.consent_status !== "granted" || preference.opted_out_at !== null
      || !Number.isSafeInteger(epoch) || epoch < 0) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "consent_not_granted" };
    }
    const assignmentVersion = assignment.rows.length ? Number(assignment.rows[0].version) : 0;
    if (!Number.isSafeInteger(assignmentVersion) || assignmentVersion < 0) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { ok: false, code: "assignment_denied" };
    }
    await client.query("COMMIT");
    inTransaction = false;
    return {
      ok: true,
      scope: {
        actorUserId: sessionId,
        assignmentAssigneeUserId: assignment.rows[0]?.assignee_user_id ?? null,
        assignmentVersion,
        consentEpoch: epoch,
      },
    };
  } catch {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, code: "schema_unavailable" };
  } finally {
    client.release();
  }
}

function terminalSnapshot(snapshot: PilotOutboxSnapshot): {
  status: "accepted" | "unknown" | "failed" | "in_progress";
  safeCode: string;
} {
  if (snapshot.state === "accepted" || snapshot.state === "delivered") {
    return { status: "accepted", safeCode: "already_processed" };
  }
  if (snapshot.state === "failed" || snapshot.state === "cancelled") {
    return { status: "failed", safeCode: "already_terminal" };
  }
  if (snapshot.state === "unknown" || snapshot.state === "sending") {
    return { status: "unknown", safeCode: "provider_outcome_unknown" };
  }
  return { status: "in_progress", safeCode: "dispatch_in_progress" };
}

export function createAvniSingleRecipientPilotDispatcher(dependencies: {
  pool: Pick<Pool, "connect">;
  supabaseWriter: AvniPilotSupabaseWriterContract | null;
  hmacKeyProvider: AvniHmacKeyProvider | null;
  transport: EvolutionPilotTransport | null;
  grantEngine: PilotGrantEngine | null;
  enabled: boolean;
  approvedRecipientE164: string | null;
  logger?: (entry: { outcome: string; safeCode: string }) => void;
}): AvniPilotDispatchHandler {
  return async (request, input) => {
    const unavailable = (safeCode: string) => ({ status: "unknown" as const, safeCode });
    if (!dependencies.enabled) return { status: "unknown", safeCode: "dispatch_disabled" };
    if (!dependencies.approvedRecipientE164
      || !e164Pattern.test(dependencies.approvedRecipientE164)
      || dependencies.approvedRecipientE164 !== input.recipientE164
      || !e164Pattern.test(input.recipientE164)
      || !uuidPattern.test(input.canonicalLeadId)
      || !Number.isSafeInteger(input.expectedControlVersion)
      || !uuidPattern.test(input.idempotencyKey)) {
      return { status: "failed", safeCode: "pilot_request_not_approved" };
    }
    // Fail closed before queueing. These are server-only dependencies and are
    // intentionally not wired by the current application registration.
    if (!dependencies.supabaseWriter || !dependencies.hmacKeyProvider || !dependencies.grantEngine
      || !dependencies.transport?.configured) {
      return unavailable("dispatch_runtime_unavailable");
    }

    const authorization = await authorizePilotRecipient(
      dependencies.pool,
      request,
      input.canonicalLeadId,
      input.recipientE164,
    );
    if (!authorization.ok) return { status: "failed", safeCode: authorization.code };

    const messageIdempotencyKey = pilotMessageIdempotencyKey(
      input.canonicalLeadId,
      input.idempotencyKey,
    );

    let snapshot: PilotOutboxSnapshot | null;
    try {
      snapshot = await dependencies.supabaseWriter.findByIdempotencyKey(messageIdempotencyKey);
    } catch {
      return unavailable("supabase_runtime_unavailable");
    }
    if (snapshot && snapshot.state !== "pending") return terminalSnapshot(snapshot);

    let preflight;
    try {
      preflight = await dependencies.supabaseWriter.preflight(
        input.canonicalLeadId,
        input.expectedControlVersion,
      );
    } catch {
      return unavailable("supabase_runtime_unavailable");
    }
    if (preflight.outcome !== "preflight_ready" || !preflight.threadId
      || !preflight.provider
      || preflight.mode !== "human" || preflight.lifecycle !== "open"
      || preflight.controlVersion !== input.expectedControlVersion) {
      return { status: "failed", safeCode: preflight.outcome };
    }

    let payloadHash: string;
    try {
      const payloadReference = signAvniProviderReference({
        provider: preflight.provider,
        kind: "message",
        rawReference: JSON.stringify([
          "avni-single-recipient-pilot-v1",
          input.canonicalLeadId,
          input.idempotencyKey,
          input.recipientE164,
          AVNI_PILOT_MESSAGE,
        ]),
      }, dependencies.hmacKeyProvider).token;
      payloadHash = digest(payloadReference);
    } catch {
      return unavailable("hmac_key_unavailable");
    }

    let outboxId = snapshot?.outboxId ?? null;
    let messageId = snapshot?.messageId ?? null;
    if (!snapshot) {
      try {
        const enqueue = await dependencies.supabaseWriter.enqueueHumanMessage({
          threadId: preflight.threadId,
          expectedControlVersion: input.expectedControlVersion,
          actorRef: `replit_lms_user:${authorization.scope.actorUserId}`,
          idempotencyKey: messageIdempotencyKey,
          messageFingerprint: payloadHash,
          text: AVNI_PILOT_MESSAGE,
        });
        if (enqueue.outcome !== "queued" && enqueue.outcome !== "duplicate") {
          return { status: "failed", safeCode: `outbox_${enqueue.outcome}` };
        }
        outboxId = enqueue.outboxId;
        messageId = enqueue.messageId;
      } catch {
        return unavailable("supabase_runtime_unavailable");
      }
    }
    if (!outboxId || !messageId) return unavailable("supabase_runtime_unavailable");

    let claim: PilotHumanClaim | null;
    try {
      claim = await dependencies.supabaseWriter.claimHumanOutbox(outboxId, 30);
    } catch {
      return unavailable("supabase_runtime_unavailable");
    }
    if (!claim) {
      const latest = await dependencies.supabaseWriter.findByIdempotencyKey(messageIdempotencyKey)
        .catch(() => null);
      return latest ? terminalSnapshot(latest) : { status: "in_progress", safeCode: "dispatch_in_progress" };
    }
    if (claim.threadId !== preflight.threadId || claim.messageId !== messageId
      || claim.controlVersion !== input.expectedControlVersion
      || claim.attemptNumber < 1 || claim.attemptNumber > 8) {
      return { status: "failed", safeCode: "claim_binding_mismatch" };
    }

    const binding = {
      canonicalLeadId: input.canonicalLeadId,
      supabaseThreadId: claim.threadId,
      supabaseOutboxId: claim.outboxId,
      supabaseMessageId: claim.messageId,
      supabaseAttemptId: claim.attemptId,
      messageIdempotencyKey,
      controlVersion: claim.controlVersion,
      attemptNumber: claim.attemptNumber,
      leaseTokenHash: digest(claim.leaseToken),
      payloadHash,
    };
    let issued;
    try {
      issued = await dependencies.grantEngine.issue(request, binding);
    } catch {
      return unavailable("dispatch_authorization_unavailable");
    }
    if (!issued.grant || issued.grant.state !== "issued"
      || !["grant_issued", "grant_duplicate"].includes(issued.code)) {
      return { status: "failed", safeCode: issued.code };
    }

    let begin;
    try {
      begin = await dependencies.grantEngine.begin(
        request,
        issued.grant.id,
        async () => dependencies.supabaseWriter!.beginHumanSend({
          claim: claim!,
          expectedControlVersion: binding.controlVersion,
          actorRef: `replit_lms_user:${authorization.scope.actorUserId}`,
          payloadHash,
        }),
      );
    } catch {
      return unavailable("dispatch_authorization_unavailable");
    }
    if (!begin.providerCallAllowed || begin.code !== "begin_send_started") {
      if (begin.code === "supabase_begin_uncertain") {
        return { status: "unknown", safeCode: "send_begin_uncertain" };
      }
      return { status: "failed", safeCode: begin.code };
    }

    const providerResult = await dependencies.transport.sendText({
      recipientE164: input.recipientE164,
      text: AVNI_PILOT_MESSAGE,
      idempotencyKey: input.idempotencyKey,
    });
    let recordResult: "sent" | "failed" | "unknown" = "unknown";
    let aliases: string[] = [];
    if (providerResult.state === "accepted") {
      try {
        aliases = createAvniProviderReferenceAliases({
          provider: preflight.provider!,
          kind: "message",
          rawReference: providerResult.providerMessageId,
        }, dependencies.hmacKeyProvider).map(alias => alias.token);
        recordResult = "sent";
      } catch {
        recordResult = "unknown";
      }
    } else if (providerResult.state === "failed") {
      recordResult = "failed";
    }

    let persisted: string | null = null;
    try {
      persisted = await dependencies.supabaseWriter.recordResult({
        claim,
        result: recordResult,
        providerReferenceAliases: recordResult === "sent" ? aliases : [],
      });
    } catch {
      // The external call may have been accepted. Preserve at-most-once
      // behavior and report unknown; an expired sending lease is terminal.
      persisted = null;
    }
    const finalOutcome: "accepted" | "failed" | "unknown" =
      recordResult === "sent" && persisted === "sent" ? "accepted"
        : recordResult === "failed" && persisted === "failed" ? "failed"
          : "unknown";
    try {
      await dependencies.grantEngine.settle(issued.grant.id, finalOutcome);
    } catch {
      dependencies.logger?.({ outcome: "unknown", safeCode: "grant_settlement_unavailable" });
      return { status: "unknown", safeCode: "grant_settlement_unavailable" };
    }
    if (finalOutcome === "accepted") {
      return { status: "accepted", safeCode: "provider_accepted" };
    }
    if (finalOutcome === "failed") return { status: "failed", safeCode: "definite_rejection" };
    return { status: "unknown", safeCode: "provider_outcome_unknown" };
  };
}

export const isStrictPilotE164 = (value: string) => e164Pattern.test(value);
