import type { Express, Request, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sameOriginCapture } from "../admissions/routes";

export const AVNI_PILOT_DISPATCH_ROUTE = "/api/admin/integrations/avni/pilot-dispatch";
export const AVNI_PILOT_DISPATCH_GATE_ENV = "AVNI_SINGLE_RECIPIENT_DISPATCH_ENABLED";
export const AVNI_PILOT_RECIPIENT_ENV = "AVNI_PILOT_RECIPIENT_E164";

const inputSchema = z.object({
  canonicalLeadId: z.string().uuid(),
  recipientE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  expectedControlVersion: z.number().int().nonnegative().safe(),
}).strict();
const statusInputSchema = z.object({
  canonicalLeadId: z.string().uuid(),
}).strict();
const idempotencySchema = z.string().uuid();
const safeCodeSchema = z.enum([
  "already_processed", "already_terminal", "actor_role_changed", "actor_unavailable",
  "assignment_changed", "assignment_denied", "begin_send_started", "claim_binding_mismatch",
  "consent_not_granted", "conversation_ambiguous", "conversation_closed", "conversation_missing",
  "crosswalk_ambiguous", "crosswalk_missing", "definite_rejection", "dispatch_actor_unavailable",
  "dispatch_authorization_changed", "dispatch_authorization_unavailable", "dispatch_disabled",
  "dispatch_grant_invalid", "dispatch_in_progress", "dispatch_runtime_unavailable",
  "dispatch_schema_unavailable", "grant_binding_mismatch", "grant_duplicate", "grant_expired",
  "grant_idempotency_conflict", "grant_replayed", "grant_revoked", "grant_settlement_unavailable",
  "invalid_request", "invalid_status_request", "lead_unavailable",
  "manual_provider_reconciliation_required", "outbox_conflict", "outbox_denied",
  "outbox_unavailable", "pilot_not_found", "pilot_recipient_not_approved",
  "pilot_request_not_approved", "preflight_ready", "provider_accepted",
  "provider_outcome_unknown", "recipient_mismatch", "schema_unavailable",
  "send_begin_uncertain", "stale_control_version", "status_reader_unavailable",
  "supabase_begin_denied", "supabase_begin_uncertain", "supabase_runtime_unavailable",
]);
const safeCode = (value: string, fallback: string) =>
  safeCodeSchema.safeParse(value).success ? value : fallback;
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

export type AvniPilotHttpOutcome =
  | { status: "accepted" | "unknown" | "failed" | "in_progress"; safeCode: string };
export type AvniPilotDispatchHandler = (
  request: Pick<Request, "session" | "lmsUser">,
  input: z.infer<typeof inputSchema> & { idempotencyKey: string },
) => Promise<AvniPilotHttpOutcome>;
export type AvniPilotStatusHandler = (
  request: Pick<Request, "session" | "lmsUser">,
  input: { canonicalLeadId: string; idempotencyKey: string },
) => Promise<{
  state: "not_found" | "unavailable" | "pending" | "claimed" | "sending" |
    "accepted" | "delivered" | "failed" | "unknown" | "cancelled";
  attemptNumber: number;
  safeCode: string;
}>;

export function registerAvniPilotDispatchRoute(
  app: Express,
  dependencies: {
    authenticate: RequestHandler;
    authorizeAdmin: RequestHandler;
    enabled: boolean;
    approvedRecipientE164: string | null;
    dispatch: AvniPilotDispatchHandler | null;
    readStatus?: AvniPilotStatusHandler | null;
    log?: (entry: {
      correlationId: string;
      outcome: string;
      safeCode: string;
    }) => void;
  },
) {
  app.post(
    AVNI_PILOT_DISPATCH_ROUTE,
    noStore,
    dependencies.authenticate,
    dependencies.authorizeAdmin,
    sameOriginCapture,
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const correlationId = randomUUID();
      const body = inputSchema.safeParse(req.body);
      const idempotencyKey = idempotencySchema.safeParse(req.get("Idempotency-Key") ?? "");
      if (!body.success || !idempotencyKey.success) {
        dependencies.log?.({
          correlationId,
          outcome: "denied",
          safeCode: "invalid_request",
        });
        return void res.status(400).json({
          status: "denied",
          code: "invalid_request",
          correlationId,
        });
      }
      if (!dependencies.enabled) {
        dependencies.log?.({
          correlationId,
          outcome: "unavailable",
          safeCode: "dispatch_disabled",
        });
        return void res.status(503).json({
          status: "unavailable",
          code: "dispatch_disabled",
          correlationId,
        });
      }
      if (!dependencies.approvedRecipientE164
        || !/^\+[1-9][0-9]{7,14}$/.test(dependencies.approvedRecipientE164)
        || body.data.recipientE164 !== dependencies.approvedRecipientE164) {
        dependencies.log?.({
          correlationId,
          outcome: "denied",
          safeCode: "pilot_recipient_not_approved",
        });
        return void res.status(403).json({
          status: "denied",
          code: "pilot_recipient_not_approved",
          correlationId,
        });
      }
      if (!dependencies.dispatch) {
        dependencies.log?.({
          correlationId,
          outcome: "unavailable",
          safeCode: "dispatch_runtime_unavailable",
        });
        return void res.status(503).json({
          status: "unavailable",
          code: "dispatch_runtime_unavailable",
          correlationId,
        });
      }
      try {
        const result = await dependencies.dispatch(req, {
          ...body.data,
          canonicalLeadId: body.data.canonicalLeadId.toLowerCase(),
          idempotencyKey: idempotencyKey.data.toLowerCase(),
        });
        const responseCode = safeCode(result.safeCode, "dispatch_runtime_unavailable");
        const responseStatus = ["accepted", "unknown", "failed", "in_progress"].includes(result.status)
          ? result.status
          : "unknown";
        dependencies.log?.({
          correlationId,
          outcome: responseStatus,
          safeCode: responseCode,
        });
        return void res.status(
          responseStatus === "accepted" ? 200
            : responseStatus === "in_progress" ? 202
              : responseStatus === "failed" ? 409
                : 202,
        ).json({
          status: responseStatus,
          code: responseCode,
          correlationId,
        });
      } catch {
        dependencies.log?.({
          correlationId,
          outcome: "unavailable",
          safeCode: "dispatch_runtime_unavailable",
        });
        return void res.status(503).json({
          status: "unavailable",
          code: "dispatch_runtime_unavailable",
          correlationId,
        });
      }
    },
  );

  // This read-only endpoint is the safe reconciliation surface for an
  // ambiguous/unknown result. It never retries or queries the provider.
  app.post(
    `${AVNI_PILOT_DISPATCH_ROUTE}/status`,
    noStore,
    dependencies.authenticate,
    dependencies.authorizeAdmin,
    sameOriginCapture,
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const correlationId = randomUUID();
      const canonicalLeadId = statusInputSchema.safeParse(req.body);
      const idempotencyKey = idempotencySchema.safeParse(req.get("Idempotency-Key") ?? "");
      if (!canonicalLeadId.success || !idempotencyKey.success) {
        dependencies.log?.({ correlationId, outcome: "denied", safeCode: "invalid_status_request" });
        return void res.status(400).json({
          status: "denied", code: "invalid_status_request", correlationId,
        });
      }
      if (!dependencies.readStatus) {
        dependencies.log?.({ correlationId, outcome: "unavailable", safeCode: "status_reader_unavailable" });
        return void res.status(503).json({
          status: "unavailable", code: "status_reader_unavailable", correlationId,
        });
      }
      try {
        const result = await dependencies.readStatus(req, {
          canonicalLeadId: canonicalLeadId.data.canonicalLeadId.toLowerCase(),
          idempotencyKey: idempotencyKey.data.toLowerCase(),
        });
        const responseCode = safeCode(result.safeCode, "status_reader_unavailable");
        const responseState = [
          "not_found", "unavailable", "pending", "claimed", "sending", "accepted",
          "delivered", "failed", "unknown", "cancelled",
        ].includes(result.state) ? result.state : "unavailable";
        const attemptNumber = Number.isSafeInteger(result.attemptNumber)
          && result.attemptNumber >= 0 && result.attemptNumber <= 8
          ? result.attemptNumber : 0;
        dependencies.log?.({
          correlationId,
          outcome: responseState,
          safeCode: responseCode,
        });
        return void res.status(responseState === "not_found" ? 404
          : responseState === "unavailable" ? 503 : 200).json({
          status: responseState,
          attemptNumber,
          code: responseCode,
          correlationId,
        });
      } catch {
        dependencies.log?.({ correlationId, outcome: "unavailable", safeCode: "status_reader_unavailable" });
        return void res.status(503).json({
          status: "unavailable", code: "status_reader_unavailable", correlationId,
        });
      }
    },
  );
}
