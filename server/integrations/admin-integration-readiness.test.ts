import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { once } from "node:events";
import test from "node:test";
import { requireLmsRole, type LmsRole } from "../lms/auth";
import {
  ADMIN_INTEGRATION_READINESS_PATH,
  ADMIN_DATABASE_READINESS_PROBE_PATH,
  registerAdminIntegrationReadinessRoute,
} from "./admin-integration-readiness";
import { sameOriginCapture } from "../admissions/routes";
import {
  inspectApplicationDatabaseEndpointPolicy,
  inspectApplicationDatabaseStartupPreflight,
} from "../db/application-runtime-connection";

async function call(options: {
  roles?: string[];
  authenticated?: boolean;
  failLoad?: boolean;
  databaseEnvironment?: Record<string, string | undefined>;
  method?: "GET" | "POST";
  sameOrigin?: boolean;
  failProbe?: boolean;
}) {
  const app = express();
  let loaded = 0;
  let probed = 0;
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
    sameOriginWrite: sameOriginCapture,
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
    probeDatabase: async () => {
      probed += 1;
      if (options.failProbe) {
        throw new Error("synthetic-password host.internal private-query");
      }
      return {
        endpointPolicyPassed: true,
        tlsPolicyPassed: true,
        endpointsMatch: true,
        distinctApplicationLogin: true,
        tlsConnectionRequired: true,
        tlsActive: true,
        runtimeLoginVerified: true,
        effectiveMinimumGrantsVerified: true,
        schemaMarkersVerified: true,
        safeCode: "probe_passed",
      };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const method = options.method ?? "GET";
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(
      `http://127.0.0.1:${address.port}${method === "POST" ? ADMIN_DATABASE_READINESS_PROBE_PATH : ADMIN_INTEGRATION_READINESS_PATH}`,
      {
        method,
        headers: method === "POST" && options.sameOrigin !== false
          ? { origin, "sec-fetch-site": "same-origin" }
          : {},
      },
    );
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.json(),
      loaded,
      probed,
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

test("database role and schema probe runs only after an explicit same-origin admin POST", async () => {
  const ordinaryRead = await call({});
  assert.equal(ordinaryRead.status, 200);
  assert.equal(ordinaryRead.probed, 0);

  const explicitProbe = await call({ method: "POST" });
  assert.equal(explicitProbe.status, 200);
  assert.equal(explicitProbe.cacheControl, "private, no-store");
  assert.equal(explicitProbe.probed, 1);
  assert.deepEqual(explicitProbe.body, {
    endpointPolicyPassed: true,
    tlsPolicyPassed: true,
    endpointsMatch: true,
    distinctApplicationLogin: true,
    tlsConnectionRequired: true,
    tlsActive: true,
    runtimeLoginVerified: true,
    effectiveMinimumGrantsVerified: true,
    schemaMarkersVerified: true,
    safeCode: "probe_passed",
  });
});

test("database role and schema probe denies unauthenticated and non-admin callers before probing", async () => {
  const unauthenticated = await call({ method: "POST", authenticated: false });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.cacheControl, "private, no-store");
  assert.equal(unauthenticated.probed, 0);
  const admissions = await call({ method: "POST", roles: ["admissions"] });
  assert.equal(admissions.status, 403);
  assert.equal(admissions.cacheControl, "private, no-store");
  assert.equal(admissions.probed, 0);
});

test("database role and schema probe rejects cross-origin and missing-origin writes", async () => {
  const result = await call({ method: "POST", sameOrigin: false });
  assert.equal(result.status, 403);
  assert.equal(result.probed, 0);
});

test("database probe suppresses raw connection and catalog errors", async () => {
  const result = await call({ method: "POST", failProbe: true });
  assert.equal(result.status, 503);
  assert.equal(result.cacheControl, "private, no-store");
  assert.doesNotMatch(JSON.stringify(result.body), /synthetic-password|host\.internal|private-query/);
  assert.equal(result.body.safeCode, "database_metadata_unavailable");
});
