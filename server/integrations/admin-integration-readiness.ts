import type { Express, RequestHandler } from "express";
import type { ApplicationDatabaseReadinessProbeReport } from "../db/application-runtime-readiness-probe";

export const ADMIN_INTEGRATION_READINESS_PATH = "/api/admin/integrations/readiness";
export const ADMIN_DATABASE_READINESS_PROBE_PATH =
  `${ADMIN_INTEGRATION_READINESS_PATH}/database-probe`;

const privateNoStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
};

export function registerAdminIntegrationReadinessRoute(
  app: Express,
  dependencies: {
    authenticate: RequestHandler;
    authorizeAdmin: RequestHandler;
    sameOriginWrite: RequestHandler;
    load: () => Promise<Record<string, unknown>>;
    probeDatabase: () => Promise<ApplicationDatabaseReadinessProbeReport>;
  },
) {
  app.get(
    ADMIN_INTEGRATION_READINESS_PATH,
    dependencies.authenticate,
    dependencies.authorizeAdmin,
    async (_req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      try {
        return void res.json(await dependencies.load());
      } catch {
        return void res.status(503).json({ code: "integrated_readiness_unavailable" });
      }
    },
  );
  app.post(
    ADMIN_DATABASE_READINESS_PROBE_PATH,
    privateNoStore,
    dependencies.authenticate,
    dependencies.authorizeAdmin,
    dependencies.sameOriginWrite,
    async (_req, res) => {
      try {
        return void res.json(await dependencies.probeDatabase());
      } catch {
        return void res.status(503).json({
          endpointPolicyPassed: false,
          tlsPolicyPassed: false,
          endpointsMatch: false,
          distinctApplicationLogin: false,
          tlsConnectionRequired: false,
          tlsActive: null,
          runtimeLoginVerified: false,
          effectiveMinimumGrantsVerified: false,
          schemaMarkersVerified: false,
          safeCode: "database_metadata_unavailable",
        } satisfies ApplicationDatabaseReadinessProbeReport);
      }
    },
  );
}
