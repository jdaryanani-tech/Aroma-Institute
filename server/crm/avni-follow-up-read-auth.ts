import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import {
  N8N_INTEGRATION_SECRET_ENV,
  N8N_INTEGRATION_SECRET_HEADER,
  verifyN8nIntegrationSecret,
} from "../integrations/n8n-auth";

export const AVNI_FOLLOWUP_READ_SECRET_ENV = "N8N_AVNI_FOLLOWUP_READ_SECRET";
export const AVNI_FOLLOWUP_READ_PRINCIPAL = "avni-followup-reader";
export const AVNI_FOLLOWUP_READ_SCOPE = "crm.followups.candidates.read";

export function avniReadCredentialIsDedicated(
  readSecret: string | undefined,
  broadSecret: string | undefined,
): boolean {
  const read = readSecret?.trim();
  if (!read) return false;
  const broad = broadSecret?.trim();
  return !broad || read !== broad;
}

export type AvniFollowUpReadAuditOutcome =
  | "secret_not_configured"
  | "credential_not_dedicated"
  | "authentication_denied"
  | "invalid_request"
  | "schema_unavailable"
  | "query_failed"
  | "success";

type SafeAuditEntry = {
  event: "avni.followup.candidates.read";
  correlationId: string;
  servicePrincipal: typeof AVNI_FOLLOWUP_READ_PRINCIPAL;
  scope: typeof AVNI_FOLLOWUP_READ_SCOPE;
  outcome: AvniFollowUpReadAuditOutcome;
  candidateCount: number;
};

export type AvniFollowUpReadAuditLogger = (entry: SafeAuditEntry) => void;

type ReadIdentityContext = {
  correlationId: string;
  servicePrincipal: typeof AVNI_FOLLOWUP_READ_PRINCIPAL;
  scope: typeof AVNI_FOLLOWUP_READ_SCOPE;
  logger: AvniFollowUpReadAuditLogger;
};

const defaultAuditLogger: AvniFollowUpReadAuditLogger = entry => {
  console.info(JSON.stringify(entry));
};

export function createAvniFollowUpReadAuth(options: {
  getSecret?: () => string | undefined;
  getBroadSecret?: () => string | undefined;
  logger?: AvniFollowUpReadAuditLogger;
} = {}): RequestHandler {
  const getSecret = options.getSecret ?? (() => process.env[AVNI_FOLLOWUP_READ_SECRET_ENV]);
  const getBroadSecret = options.getBroadSecret ?? (() => process.env[N8N_INTEGRATION_SECRET_ENV]);
  const logger = options.logger ?? defaultAuditLogger;

  return (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Vary", N8N_INTEGRATION_SECRET_HEADER);

    const correlationId = randomUUID();
    const auditBase: Pick<SafeAuditEntry, "event" | "correlationId" | "servicePrincipal" | "scope"> = {
      event: "avni.followup.candidates.read",
      correlationId,
      servicePrincipal: AVNI_FOLLOWUP_READ_PRINCIPAL,
      scope: AVNI_FOLLOWUP_READ_SCOPE,
    };
    const secret = getSecret();

    if (!secret?.trim()) {
      logger({ ...auditBase, outcome: "secret_not_configured", candidateCount: 0 });
      return void res.status(503).json({ code: "follow_up_read_unavailable" });
    }
    if (!avniReadCredentialIsDedicated(secret, getBroadSecret())) {
      logger({ ...auditBase, outcome: "credential_not_dedicated", candidateCount: 0 });
      return void res.status(503).json({ code: "follow_up_read_unavailable" });
    }
    if (!verifyN8nIntegrationSecret(req.get(N8N_INTEGRATION_SECRET_HEADER) ?? "", secret)) {
      logger({ ...auditBase, outcome: "authentication_denied", candidateCount: 0 });
      return void res.status(401).json({ code: "integration_authentication_required" });
    }

    res.locals.avniFollowUpReadIdentity = {
      ...auditBase,
      logger,
    } satisfies ReadIdentityContext;
    return next();
  };
}

export function auditAvniFollowUpCandidateRead(
  res: Response,
  outcome: AvniFollowUpReadAuditOutcome,
  candidateCount = 0,
): void {
  const identity = res.locals.avniFollowUpReadIdentity as ReadIdentityContext | undefined;
  if (!identity) return;
  identity.logger({
    event: "avni.followup.candidates.read",
    correlationId: identity.correlationId,
    servicePrincipal: identity.servicePrincipal,
    scope: identity.scope,
    outcome,
    candidateCount,
  });
}
