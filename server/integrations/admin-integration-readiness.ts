import type { Express, RequestHandler } from "express";

export const ADMIN_INTEGRATION_READINESS_PATH = "/api/admin/integrations/readiness";

export function registerAdminIntegrationReadinessRoute(
  app: Express,
  dependencies: {
    authenticate: RequestHandler;
    authorizeAdmin: RequestHandler;
    load: () => Promise<Record<string, unknown>>;
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
}
