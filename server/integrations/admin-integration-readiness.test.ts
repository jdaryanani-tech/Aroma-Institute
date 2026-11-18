import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { once } from "node:events";
import test from "node:test";
import { requireLmsRole, type LmsRole } from "../lms/auth";
import {
  ADMIN_INTEGRATION_READINESS_PATH,
  registerAdminIntegrationReadinessRoute,
} from "./admin-integration-readiness";

async function call(options: {
  roles?: string[];
  authenticated?: boolean;
  failLoad?: boolean;
}) {
  const app = express();
  let loaded = 0;
  const authenticate: RequestHandler = (req, res, next) => {
    if (options.authenticated === false) return void res.status(401).json({ code: "unauthorized" });
    req.lmsUser = {
      id: 10,
      phoneE164: "+919000000010",
      displayName: "Synthetic operator",
      roles: (options.roles ?? ["admin"]) as LmsRole[],
    };
    return next();
  };
  registerAdminIntegrationReadinessRoute(app, {
    authenticate,
    authorizeAdmin: requireLmsRole("admin"),
    load: async () => {
      loaded += 1;
      if (options.failLoad) throw new Error("private runtime details");
      return {
        crm: { ready: true },
        avni: { dispatchHardDisabled: true },
        meta: { pageIdentity: "not_checked" },
      };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${ADMIN_INTEGRATION_READINESS_PATH}`);
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.json(),
      loaded,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}

test("integrated readiness is admin-only and denies before loading diagnostics", async () => {
  const unauthenticated = await call({ authenticated: false });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.loaded, 0);
  const admissions = await call({ roles: ["admissions"] });
  assert.equal(admissions.status, 403);
  assert.equal(admissions.loaded, 0);
});

test("integrated readiness is no-store and returns only the aggregate loader contract", async () => {
  const result = await call({});
  assert.equal(result.status, 200);
  assert.equal(result.cacheControl, "private, no-store");
  assert.deepEqual(result.body, {
    crm: { ready: true },
    avni: { dispatchHardDisabled: true },
    meta: { pageIdentity: "not_checked" },
  });
  assert.equal(result.loaded, 1);
});

test("integrated readiness suppresses internal errors", async () => {
  const result = await call({ failLoad: true });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { code: "integrated_readiness_unavailable" });
});
