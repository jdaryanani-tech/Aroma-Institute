import type { Request } from "express";
import { z } from "zod";
import {
  canReadCanonicalLead,
  crmAccessLevel,
  type CrmPrincipal,
} from "./authorization";
import type { SupabaseConversationPreflight } from "../db/supabase-avni-readonly";

type QueryResult<T> = { rows: T[] };
export type AvniAuthorizationClient = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};
export type AvniAuthorizationPool = {
  connect(): Promise<AvniAuthorizationClient>;
};
export type AvniConversationPreflightReader = {
  preflightConversation(
    replitLeadId: string,
    expectedControlVersion: number,
  ): Promise<SupabaseConversationPreflight>;
};
export type AvniConversationPreflightCode =
  | "authentication_required"
  | "actor_inactive"
  | "crm_role_required"
  | "canonical_lead_unavailable"
  | "lead_assignment_denied"
  | "whatsapp_opted_out"
  | "whatsapp_consent_not_granted"
  | "crosswalk_missing"
  | "crosswalk_ambiguous"
  | "conversation_missing"
  | "conversation_ambiguous"
  | "conversation_closed"
  | "stale_control_version"
  | "invalid_preflight"
  | "preflight_complete"
  | "runtime_unavailable";

export type AvniConversationPreflightResult = {
  status: "ready" | "denied" | "unavailable";
  code: AvniConversationPreflightCode;
  conversationMode: "ai" | "human" | null;
  controlVersion: number | null;
  /** This adapter is preflight only and can never authorize an enqueue or send. */
  sendAuthorized: false;
};

const uuidSchema = z.string().uuid();

function denied(
  code: AvniConversationPreflightCode,
  status: AvniConversationPreflightResult["status"] = "denied",
): AvniConversationPreflightResult {
  return {
    status,
    code,
    conversationMode: null,
    controlVersion: null,
    sendAuthorized: false,
  };
}

function mapSupabasePreflight(
  snapshot: SupabaseConversationPreflight,
  expectedControlVersion: number,
): AvniConversationPreflightResult {
  switch (snapshot.outcome) {
    case "crosswalk_missing":
      return denied("crosswalk_missing");
    case "crosswalk_ambiguous":
      return denied("crosswalk_ambiguous");
    case "conversation_missing":
      return denied("conversation_missing");
    case "conversation_ambiguous":
      return denied("conversation_ambiguous");
    case "conversation_closed":
      return denied("conversation_closed");
    case "stale_control_version":
      return denied("stale_control_version");
    case "invalid_request":
      return denied("invalid_preflight");
    case "preflight_ready":
      if (
        snapshot.controlVersion === null ||
        snapshot.controlVersion !== expectedControlVersion ||
        snapshot.lifecycle !== "open" ||
        snapshot.mode === null
      ) return denied("invalid_preflight");
      return {
        status: "ready",
        code: "preflight_complete",
        conversationMode: snapshot.mode,
        controlVersion: snapshot.controlVersion,
        sendAuthorized: false,
      };
  }
}

/**
 * Performs an authorization/readiness preflight for a canonical Replit lead.
 *
 * `canonicalLeadId` must come from an already-resolved server-side CRM record,
 * never directly from a browser/provider body. This module registers no route.
 * Actor identity is taken only from the authenticated request session and is
 * reloaded with current roles. Even a successful result is NOT send permission:
 * no outbox operation or provider call is reachable from this adapter.
 */
export async function preflightAvniConversationOperation(
  request: Pick<Request, "session" | "lmsUser">,
  canonicalLeadId: string,
  expectedControlVersion: number,
  dependencies: {
    pool: AvniAuthorizationPool;
    supabase: AvniConversationPreflightReader | null;
  },
): Promise<AvniConversationPreflightResult> {
  const sessionUserId = request.session?.lmsUserId;
  const attachedUserId = request.lmsUser?.id;
  if (
    typeof sessionUserId !== "number" ||
    !Number.isSafeInteger(sessionUserId) ||
    typeof attachedUserId !== "number" ||
    !Number.isSafeInteger(attachedUserId) ||
    sessionUserId !== attachedUserId
  ) return denied("authentication_required");
  if (!uuidSchema.safeParse(canonicalLeadId).success) {
    return denied("canonical_lead_unavailable");
  }
  if (
    !Number.isSafeInteger(expectedControlVersion) ||
    expectedControlVersion < 0
  ) return denied("invalid_preflight");
  if (!dependencies.supabase) return denied("runtime_unavailable", "unavailable");

  let client: AvniAuthorizationClient | undefined;
  let transactionOpen = false;
  try {
    client = await dependencies.pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;

    // Recheck active status and roles from the source of truth. Never trust the
    // role list attached earlier by middleware as a durable authorization claim.
    const { rows: actors } = await client.query<{ id: number; is_active: boolean }>(
      `SELECT id,is_active FROM lms_users WHERE id=$1::integer FOR SHARE`,
      [sessionUserId],
    );
    if (actors.length !== 1 || actors[0].is_active !== true) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("actor_inactive");
    }
    const { rows: roleRows } = await client.query<{ role: string }>(
      `SELECT role FROM lms_user_roles
       WHERE user_id=$1::integer ORDER BY role FOR SHARE`,
      [sessionUserId],
    );
    const principal: CrmPrincipal = {
      id: sessionUserId,
      roles: roleRows.map(row => row.role),
    };
    const access = crmAccessLevel(principal);
    if (access === "denied") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("crm_role_required");
    }

    const { rows: leads } = await client.query<{ id: string }>(
      `SELECT id FROM admissions_leads WHERE id=$1::uuid FOR SHARE`,
      [canonicalLeadId],
    );
    if (leads.length !== 1) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("canonical_lead_unavailable");
    }
    const { rows: assignmentRows } = await client.query<{ assignee_user_id: number | null }>(
      `SELECT assignee_user_id FROM admissions_lead_assignments
       WHERE lead_id=$1::uuid FOR SHARE`,
      [canonicalLeadId],
    );
    if (assignmentRows.length > 1) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("canonical_lead_unavailable");
    }
    const assigneeUserId = assignmentRows[0]?.assignee_user_id ?? null;
    if (!canReadCanonicalLead(principal, canonicalLeadId, assigneeUserId)) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("lead_assignment_denied");
    }

    const { rows: preferences } = await client.query<{
      consent_status: string;
      opted_out_at: Date | string | null;
    }>(
      `SELECT consent_status,opted_out_at
       FROM admissions_lead_contact_preferences
       WHERE lead_id=$1::uuid FOR SHARE`,
      [canonicalLeadId],
    );
    if (preferences.length > 1) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("canonical_lead_unavailable");
    }
    const preference = preferences[0];
    if (preference?.opted_out_at || preference?.consent_status === "opted_out") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("whatsapp_opted_out");
    }
    if (!preference || preference.consent_status !== "granted") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return denied("whatsapp_consent_not_granted");
    }

    // The read-only Supabase RPC resolves the exact replit_lead_id crosswalk
    // internally. It returns only a server-internal thread reference and state;
    // this adapter strips the reference from its result.
    const snapshot = await dependencies.supabase.preflightConversation(
      canonicalLeadId,
      expectedControlVersion,
    );
    const result = mapSupabasePreflight(snapshot, expectedControlVersion);
    if (result.status !== "ready") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return result;
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch {
    if (client && transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    return denied("runtime_unavailable", "unavailable");
  } finally {
    client?.release();
  }
}
