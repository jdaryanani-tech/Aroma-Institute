import { createHmac } from "node:crypto";
import type { Express, RequestHandler } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { sameOriginCapture } from "../admissions/routes";
import { inspectCrmSchema } from "../crm/model";

export const AVNI_PRODUCTION_DIAGNOSTICS_PATH =
  "/api/admin/integrations/avni/production-diagnostics";

const requestSchema = z.object({}).strict();

type DiagnosticPool = Pick<Pool, "query">;
type ConnectionMode = "legacy" | "least_privilege" | "unknown";
type RuntimeEnvironment = "production" | "development" | "test" | "other";

type DatabaseIdentityRow = {
  database_name: string | null;
  server_address: string | null;
  server_port: number | string | null;
  session_user_name: string | null;
  current_user_name: string | null;
};

function safeRuntimeEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === "production" || value === "development" || value === "test") return value;
  return "other";
}

function safeConnectionMode(value: string | undefined): ConnectionMode {
  return value === "legacy" || value === "least_privilege" ? value : "unknown";
}

async function databaseFingerprint(
  pool: DiagnosticPool,
  sessionSecret: string,
  runtimeEnvironment: RuntimeEnvironment,
  connectionMode: ConnectionMode,
): Promise<string> {
  const { rows: [identity] } = await pool.query<DatabaseIdentityRow>(
    `SELECT current_database()::text AS database_name,
       inet_server_addr()::text AS server_address,
       inet_server_port() AS server_port,
       session_user::text AS session_user_name,
       current_user::text AS current_user_name`,
  );
  if (
    !identity?.database_name
    || !identity.server_address
    || identity.server_port === null
    || !identity.session_user_name
    || !identity.current_user_name
  ) {
    throw new Error("database_identity_unavailable");
  }

  // HMAC prevents the fingerprint from being used as an offline guess of
  // low-entropy database names/hosts. It is stable within an environment
  // until SESSION_SECRET rotates; no connection details or key are returned.
  const identityTuple = JSON.stringify([
    runtimeEnvironment,
    connectionMode,
    identity.database_name,
    identity.server_address,
    identity.server_port === null ? null : Number(identity.server_port),
    identity.session_user_name,
    identity.current_user_name,
  ]);
  return createHmac("sha256", sessionSecret).update(identityTuple).digest("hex");
}

async function followUpReadScopeReady(
  pool: DiagnosticPool,
  secretConfigured: boolean,
  credentialDistinct: boolean,
): Promise<boolean> {
  if (!secretConfigured || !credentialDistinct) return false;
  try {
    const capabilities = await inspectCrmSchema(pool);
    const { rows: [consent] } = await pool.query<{ ready: boolean }>(
      "SELECT to_regclass('admissions_lead_contact_preferences') IS NOT NULL AS ready",
    );
    return capabilities.crmPersistence
      && capabilities.identityTracking
      && capabilities.canonicalAssignments
      && consent?.ready === true;
  } catch {
    return false;
  }
}

export function registerAvniProductionDiagnosticsRoute(
  app: Express,
  dependencies: {
    pool: DiagnosticPool;
    sessionSecret: string | undefined;
    runtimeEnvironment: string | undefined;
    connectionMode: string | undefined;
    followUpReadSecretConfigured: boolean;
    followUpReadSecretDistinct: boolean;
    authenticate: RequestHandler;
    authorizeAdmin: RequestHandler;
  },
) {
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie, Origin");
    next();
  };

  app.post(
    AVNI_PRODUCTION_DIAGNOSTICS_PATH,
    noStore,
    sameOriginCapture,
    dependencies.authenticate,
    dependencies.authorizeAdmin,
    async (req, res) => {
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        return void res.status(400).json({ code: "invalid_diagnostic_request" });
      }
      if (!dependencies.sessionSecret?.trim()) {
        return void res.status(503).json({ code: "diagnostics_unavailable" });
      }

      try {
        const runtimeEnvironment = safeRuntimeEnvironment(dependencies.runtimeEnvironment);
        const connectionMode = safeConnectionMode(dependencies.connectionMode);
        const fingerprint = await databaseFingerprint(
          dependencies.pool,
          dependencies.sessionSecret,
          runtimeEnvironment,
          connectionMode,
        );
        const scopeReady = await followUpReadScopeReady(
          dependencies.pool,
          dependencies.followUpReadSecretConfigured,
          dependencies.followUpReadSecretDistinct,
        );
        return void res.json({
          checkedAt: new Date().toISOString(),
          database: {
            runtimeEnvironment,
            connectionMode,
            fingerprintAlgorithm: "HMAC-SHA-256",
            fingerprint,
          },
          serviceIdentity: {
            name: "avni-followup-reader",
            capability: "crm.followups.candidates.read",
            secretConfigured: dependencies.followUpReadSecretConfigured,
            credentialDistinct: dependencies.followUpReadSecretDistinct,
            scopeReady,
          },
        });
      } catch {
        // Do not log request bodies, connection details, or database errors.
        return void res.status(503).json({ code: "diagnostics_unavailable" });
      }
    },
  );
}
