import assert from "node:assert/strict";
import { once } from "node:events";
import type { Pool } from "pg";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { requireLmsRole, type LmsRole } from "../lms/auth";
import { AVNI_PRODUCTION_DIAGNOSTICS_PATH, registerAvniProductionDiagnosticsRoute } from "./avni-production-diagnostics";

const SESSION_SECRET = "session-secret-test-only";
const DATABASE_MARKERS = ["private-database-name", "10.20.30.40", "private-runtime-user", "private-session-user"];

type AppOptions = {
  roles?: string[];
  authenticated?: boolean;
  secretConfigured?: boolean;
  credentialDistinct?: boolean;
  schemaReady?: boolean;
};

function createPool(options: AppOptions) {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes("current_database()")) {
        return { rows: [{
          database_name: DATABASE_MARKERS[0],
          server_address: DATABASE_MARKERS[1],
          server_port: 5432,
          session_user_name: DATABASE_MARKERS[3],
          current_user_name: DATABASE_MARKERS[2],
        }] };
      }
      if (sql.includes("to_regclass('admissions_lead_contact_preferences')")) {
        return { rows: [{ ready: options.schemaReady !== false }] };
      }
      if (sql.includes("to_regclass('admissions_leads')")) {
        return { rows: [{
          identity: options.schemaReady !== false,
          video: true,
          crm: options.schemaReady !== false,
          assignments: options.schemaReady !== false,
          attempts: true,
          marketing: true,
          calendar: true,
        }] };
      }
      throw new Error("Unexpected diagnostic SQL");
    },
  };
  return { pool: pool as unknown as Pick<Pool, "query">, calls };
}

async function requestDiagnostic(options: AppOptions, body: unknown = {}) {
  const { pool, calls } = createPool(options);
  const app = express();
  app.use(express.json());
  const authenticate: RequestHandler = (req, res, next) => {
    if (options.authenticated === false) return void res.status(401).json({ code: "unauthorized" });
    req.lmsUser = {
      id: 90,
      phoneE164: "+919000000099",
      displayName: "Test Administrator",
      roles: (options.roles ?? ["admin"]) as LmsRole[],
    };
    return next();
  };
  registerAvniProductionDiagnosticsRoute(app, {
    pool,
    sessionSecret: SESSION_SECRET,
    runtimeEnvironment: "production",
    connectionMode: "legacy",
    runtimeDatabaseVerified: false,
    followUpReadSecretConfigured: options.secretConfigured === true,
    followUpReadSecretDistinct: options.credentialDistinct ?? options.secretConfigured === true,
    authenticate,
    authorizeAdmin: requireLmsRole("admin"),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${AVNI_PRODUCTION_DIAGNOSTICS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${address.port}`,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      cacheControl: response.headers.get("cache-control"),
      calls,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test("AVNI diagnostics deny non-admin users before querying the database", async () => {
  for (const roles of [["admissions"], ["student"]]) {
    const response = await requestDiagnostic({ roles, secretConfigured: true });
    assert.equal(response.status, 403);
    assert.equal(response.calls.length, 0);
  }
});

test("AVNI diagnostics require an authenticated admin", async () => {
  const response = await requestDiagnostic({ authenticated: false, secretConfigured: true });
  assert.equal(response.status, 401);
  assert.equal(response.calls.length, 0);
});

test("AVNI diagnostics return only database fingerprint and read-scope readiness", async () => {
  const response = await requestDiagnostic({ secretConfigured: true });
  assert.equal(response.status, 200);
  assert.equal(response.cacheControl, "no-store");
  assert.deepEqual(Object.keys(response.body).sort(), ["checkedAt", "database", "serviceIdentity"]);
  assert.deepEqual(response.body.serviceIdentity, {
    name: "avni-followup-reader",
    capability: "crm.followups.candidates.read",
    secretConfigured: true,
    credentialDistinct: true,
    scopeReady: true,
  });
  assert.deepEqual(Object.keys(response.body.database).sort(), [
    "connectionMode",
    "fingerprint",
    "fingerprintAlgorithm",
    "leastPrivilegeVerified",
    "runtimeEnvironment",
  ]);
  assert.equal(response.body.database.leastPrivilegeVerified, false);
  const serialized = JSON.stringify(response.body);
  for (const marker of [...DATABASE_MARKERS, SESSION_SECRET, "phone", "lms_users", "leadId"]) {
    assert.equal(serialized.includes(marker), false);
  }
  assert.match(response.body.database.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(response.calls.every(sql => /^\s*SELECT\b/i.test(sql)));
  assert.equal(response.calls.some(sql => /lms_users|lms_user_roles/i.test(sql)), false);
});

test("diagnostics report a missing dedicated secret without revealing it", async () => {
  const response = await requestDiagnostic({ secretConfigured: false });
  assert.equal(response.status, 200);
  assert.equal(response.body.serviceIdentity.secretConfigured, false);
  assert.equal(response.body.serviceIdentity.scopeReady, false);
});

test("diagnostics fail readiness when the dedicated key equals the broad shared key", async () => {
  const response = await requestDiagnostic({
    secretConfigured: true,
    credentialDistinct: false,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.serviceIdentity.secretConfigured, true);
  assert.equal(response.body.serviceIdentity.credentialDistinct, false);
  assert.equal(response.body.serviceIdentity.scopeReady, false);
});

test("diagnostics fail read-scope readiness closed when assignment or CRM schema is unavailable", async () => {
  const response = await requestDiagnostic({ secretConfigured: true, schemaReady: false });
  assert.equal(response.status, 200);
  assert.equal(response.body.serviceIdentity.secretConfigured, true);
  assert.equal(response.body.serviceIdentity.scopeReady, false);
});

test("diagnostics reject request-supplied identity or scope fields", async () => {
  const response = await requestDiagnostic({ secretConfigured: true }, {
    servicePrincipal: "admin",
    scope: "crm.write",
  });
  assert.equal(response.status, 400);
  assert.equal(response.calls.length, 0);
});
