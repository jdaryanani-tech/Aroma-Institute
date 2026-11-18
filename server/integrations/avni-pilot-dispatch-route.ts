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
const idempotencySchema = z.string().uuid();

export type AvniPilotHttpOutcome =
  | { status: "accepted" | "unknown" | "failed" | "in_progress"; safeCode: string };
export type AvniPilotDispatchHandler = (
  request: Pick<Request, "session" | "lmsUser">,
  input: z.infer<typeof inputSchema> & { idempotencyKey: string },
) => Promise<AvniPilotHttpOutcome>;

export function registerAvniPilotDispatchRoute(
  app: Express,
  dependencies: {
    authenticate: RequestHandler;
    authorizeAdmin: RequestHandler;
    enabled: boolean;
    approvedRecipientE164: string | null;
    dispatch: AvniPilotDispatchHandler | null;
    log?: (entry: {
      correlationId: string;
      outcome: string;
      safeCode: string;
    }) => void;
  },
) {
  app.post(
    AVNI_PILOT_DISPATCH_ROUTE,
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
        dependencies.log?.({
          correlationId,
          outcome: result.status,
          safeCode: result.safeCode,
        });
        return void res.status(
          result.status === "accepted" ? 200
            : result.status === "in_progress" ? 202
              : result.status === "failed" ? 409
                : 202,
        ).json({
          status: result.status,
          code: result.safeCode,
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
}
