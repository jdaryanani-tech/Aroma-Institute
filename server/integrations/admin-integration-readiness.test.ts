import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { once } from "node:events";
import test from "node:test";
import { requireLmsRole, type LmsRole } from "../lms/auth";
import {
  ADMIN_INTEGRATION_READINESS_PATH,
  registerAdminIntegrationReadinessRoute,
} from "./admin-integration-readiness";
import {
  inspectApplicationDatabaseEndpointPolicy,
  inspectApplicationDatabaseStartupPreflight,
} from "../db/application-runtime-connection";

async function call(options: {
  roles?: string[];
  authenticated?: boolean;
  failLoad?: boolean;
  databaseEnvironment?: Record<string, string | undefined>;
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
        ...(options.databaseEnvironment
          ? {
              database: {
                ...inspectApplicationDatabaseEndpointPolicy(options.databaseEnvironment),
                preflight: inspectApplicationDatabaseStartupPreflight(
                  options.databaseEnvironment,
                  { checked: true, passed: false },
                ),
              },
            }
          : {}),
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

test("database endpoint diagnostics remain admin-only and expose booleans only", async () => {
  const host = "ep-admin-test.us-east-1.aws.neon.tech";
  const databaseEnvironment = {
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://fixture-platform:NEVER_RETURN@${host}:5432/neondb?sslmode=require`,
    AICHM_APP_DATABASE_URL: `postgresql://fixture-app:NEVER_RETURN@${host}:5432/neondb`,
  };

  const admin = await call({ databaseEnvironment });
  assert.equal(admin.status, 200);
  assert.equal(admin.cacheControl, "private, no-store");
  assert.deepEqual(admin.body.database, {
    hostPolicySatisfied: true,
    requiredTlsPolicySatisfied: false,
    preflight: {
      platform: {
        configured: true,
        parseable: true,
        hostClassification: "approved_replit_managed_neon",
        hostPolicyPassed: true,
        tlsEnabled: true,
        tlsPolicyPassed: true,
      },
      application: {
        configured: true,
        parseable: true,
        hostClassification: "approved_replit_managed_neon",
        hostPolicyPassed: true,
        tlsEnabled: false,
        tlsPolicyPassed: false,
      },
      endpointDatabaseOptionsMatch: false,
      distinctLoginConfigured: true,
      rolePreflightChecked: true,
      rolePreflightPassed: false,
    },
  });
  const responseText = JSON.stringify(admin.body);
  for (const sensitive of [host, "fixture-platform", "fixture-app", "NEVER_RETURN"]) {
    assert.equal(responseText.includes(sensitive), false);
  }

  const nonAdmin = await call({ authenticated: false, databaseEnvironment });
  assert.equal(nonAdmin.status, 401);
  assert.equal(nonAdmin.loaded, 0);
});
