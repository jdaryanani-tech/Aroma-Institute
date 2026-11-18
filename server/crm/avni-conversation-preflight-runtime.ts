import { pool } from "../db";
import {
  isSupabaseAvniReadConfigured,
  readSupabaseConversationPreflight,
} from "../db/supabase-avni-readonly";
import {
  preflightAvniConversationOperation,
  type AvniConversationPreflightResult,
} from "./avni-conversation-authorization";
import type { Request } from "express";

/**
 * Server entry point for an already-authenticated CRM handler. Call only after
 * its normal CRM record lookup has produced the canonical Replit lead UUID.
 * There is deliberately no route, writer pool, service identity, outbox call,
 * or provider sender behind this function.
 */
export function preflightAuthenticatedAvniConversation(
  request: Pick<Request, "session" | "lmsUser">,
  canonicalLeadId: string,
  expectedControlVersion: number,
): Promise<AvniConversationPreflightResult> {
  const supabase = isSupabaseAvniReadConfigured()
    ? { preflightConversation: readSupabaseConversationPreflight }
    : null;
  return preflightAvniConversationOperation(
    request,
    canonicalLeadId,
    expectedControlVersion,
    { pool, supabase },
  );
}
