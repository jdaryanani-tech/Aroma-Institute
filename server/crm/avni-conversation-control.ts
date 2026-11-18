import type { Request } from "express";
import { z } from "zod";
import { canReadCanonicalLead, crmAccessLevel, type CrmPrincipal } from "./authorization";

type QueryResult<T> = { rows: T[] };
export type AvniControlClient = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};
export type AvniControlPool = { connect(): Promise<AvniControlClient> };

/**
 * Server-only capability. Implementations must resolve the exact
 * public.leads.replit_lead_id crosswalk and call the fixed control RPC; callers
 * must never supply a Supabase thread ID or actor/consent claims.
 */
export type AvniConversationControlWriter = {
  transitionForCanonicalLead(input: {
    replitLeadId: string;
    expectedControlVersion: number;
    action: "takeover" | "resume";
    actorRef: `replit_lms_user:${number}`;
    requestId: string;
    reason: string | null;
  }): Promise<{
    outcome:
      | "changed"
      | "duplicate"
      | "version_conflict"
      | "crosswalk_missing"
      | "crosswalk_ambiguous"
      | "conversation_missing"
      | "conversation_closed"
      | "ownership_conflict"
      | "request_id_conflict";
    controlVersion: number | null;
  }>;
};

export type AvniControlCode =
  | "authentication_required"
  | "actor_inactive"
  | "crm_role_required"
  | "canonical_lead_unavailable"
  | "lead_assignment_denied"
  | "whatsapp_opted_out"
  | "whatsapp_consent_not_granted"
  | "stale_control_version"
  | "control_changed"
  | "control_duplicate"
  | "control_request_conflict"
  | "crosswalk_missing"
  | "crosswalk_ambiguous"
  | "conversation_missing"
  | "conversation_closed"
  | "ownership_conflict"
  | "invalid_control_request"
  | "runtime_unavailable";

export type AvniControlResult = {
  status: "changed" | "duplicate" | "denied" | "unavailable";
  code: AvniControlCode;
  controlVersion: number | null;
  /** Ownership changes are not provider-send authorization. */
  sendAuthorized: false;
};

const leadIdSchema = z.string().uuid();
const requestIdSchema = z.string().uuid();

function result(
  status: AvniControlResult["status"],
  code: AvniControlCode,
  controlVersion: number | null = null,
): AvniControlResult {
  return { status, code, controlVersion, sendAuthorized: false };
}

/**
 * Performs authenticated CRM ownership transitions only. Resume is gated by a
 * fresh Replit consent/opt-out read held FOR UPDATE while the Supabase RPC is
 * called. This narrows the race but does not claim a distributed transaction.
 * No route is registered here and no send operation is reachable.
 */
export async function transitionAvniConversationControl(
  request: Pick<Request, "session" | "lmsUser">,
  input: {
    canonicalLeadId: string;
    expectedControlVersion: number;
    action: "takeover" | "resume";
    /** Stable caller-generated UUID for retries of this exact intent. */
    requestId: string;
    reason?: string | null;
  },
  dependencies: {
    pool: AvniControlPool;
    writer: AvniConversationControlWriter | null;
  },
): Promise<AvniControlResult> {
  const sessionUserId = request.session?.lmsUserId;
  const attachedUserId = request.lmsUser?.id;
  if (
    typeof sessionUserId !== "number" ||
    !Number.isSafeInteger(sessionUserId) ||
    typeof attachedUserId !== "number" ||
    !Number.isSafeInteger(attachedUserId) ||
    sessionUserId !== attachedUserId
  ) return result("denied", "authentication_required");
  if (!leadIdSchema.safeParse(input.canonicalLeadId).success ||
      !Number.isSafeInteger(input.expectedControlVersion) ||
      input.expectedControlVersion < 0 ||
      !requestIdSchema.safeParse(input.requestId).success ||
      (input.reason != null && (input.reason.trim().length < 3 || input.reason.trim().length > 500))) {
    return result("denied", "invalid_control_request");
  }
  if (!dependencies.writer) return result("unavailable", "runtime_unavailable");

  let client: AvniControlClient | undefined;
  let transactionOpen = false;
  try {
    client = await dependencies.pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;

    const { rows: actors } = await client.query<{ id: number; is_active: boolean }>(
      "SELECT id,is_active FROM lms_users WHERE id=$1::integer FOR SHARE",
      [sessionUserId],
    );
    if (actors.length !== 1 || actors[0].is_active !== true) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return result("denied", "actor_inactive");
    }
    const { rows: roleRows } = await client.query<{ role: string }>(
      "SELECT role FROM lms_user_roles WHERE user_id=$1::integer ORDER BY role FOR SHARE",
      [sessionUserId],
    );
    const principal: CrmPrincipal = { id: sessionUserId, roles: roleRows.map(row => row.role) };
    const accessLevel = crmAccessLevel(principal);
    if (accessLevel === "denied") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return result("denied", "crm_role_required");
    }
    const { rows: leads } = await client.query<{ id: string }>(
      "SELECT id FROM admissions_leads WHERE id=$1::uuid FOR SHARE",
      [input.canonicalLeadId],
    );
    if (leads.length !== 1) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return result("denied", "canonical_lead_unavailable");
    }
    const { rows: assignments } = await client.query<{
      assignee_user_id: number | null;
      version: number;
    }>(
      "SELECT assignee_user_id,version FROM admissions_lead_assignments WHERE lead_id=$1::uuid FOR SHARE",
      [input.canonicalLeadId],
    );
    if (assignments.length > 1) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return result("denied", "canonical_lead_unavailable");
    }
    const assignment = assignments[0];
    if (!canReadCanonicalLead(principal, input.canonicalLeadId, assignment?.assignee_user_id ?? null)) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return result("denied", "lead_assignment_denied");
    }

    if (input.action === "resume") {
      const { rows: preferences } = await client.query<{
        consent_status: string;
        opted_out_at: Date | string | null;
      }>(
        `SELECT consent_status,opted_out_at
         FROM admissions_lead_contact_preferences WHERE lead_id=$1::uuid FOR UPDATE`,
        [input.canonicalLeadId],
      );
      if (preferences.length !== 1 || preferences[0].consent_status === "opted_out" ||
          preferences[0].opted_out_at != null) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return result("denied", "whatsapp_opted_out");
      }
      if (preferences[0].consent_status !== "granted") {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return result("denied", "whatsapp_consent_not_granted");
      }
    }

    const rpcResult = await dependencies.writer.transitionForCanonicalLead({
      replitLeadId: input.canonicalLeadId,
      expectedControlVersion: input.expectedControlVersion,
      action: input.action,
      actorRef: `replit_lms_user:${sessionUserId}`,
      requestId: input.requestId,
      reason: input.reason?.trim() || null,
    });
    if (rpcResult.outcome === "changed" || rpcResult.outcome === "duplicate") {
      await client.query("COMMIT");
      transactionOpen = false;
      return result(
        rpcResult.outcome === "changed" ? "changed" : "duplicate",
        rpcResult.outcome === "changed" ? "control_changed" : "control_duplicate",
        rpcResult.controlVersion,
      );
    }
    await client.query("ROLLBACK");
    transactionOpen = false;
    const mapped: Record<string, AvniControlCode> = {
      version_conflict: "stale_control_version",
      crosswalk_missing: "crosswalk_missing",
      crosswalk_ambiguous: "crosswalk_ambiguous",
      conversation_missing: "conversation_missing",
      conversation_closed: "conversation_closed",
      ownership_conflict: "ownership_conflict",
      request_id_conflict: "control_request_conflict",
    };
    return result("denied", mapped[rpcResult.outcome] ?? "runtime_unavailable", rpcResult.controlVersion);
  } catch {
    if (transactionOpen) await client?.query("ROLLBACK").catch(() => undefined);
    return result("unavailable", "runtime_unavailable");
  } finally {
    client?.release();
  }
}
