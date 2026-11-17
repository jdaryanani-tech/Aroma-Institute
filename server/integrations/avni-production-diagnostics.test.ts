import assert from "node:assert/strict";
import { once } from "node:events";
import type { Pool } from "pg";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { requireLmsRole, type LmsRole } from "../lms/auth";
import { AVNI_PRODUCTION_DIAGNOSTICS_PATH, registerAvniProductionDiagnosticsRoute } from "./avni-production-diagnostics";

const SECRET = "session-secret-test-only";
const INPUT_PHONE = " +91 (90000) 00001 ";
const DATABASE_MARKERS = [
  "private-database-name",
  "10.20.30.40",
  "private-runtime-user",
  "private-session-user",
];

type ActorRow = { id: number; is_active: boolean; roles: string[] };
type AppOptions = {
  actorRows: ActorRow[];
  roles?: string[];
  authenticated?: boolean;
};

function createPool(actorRows: ActorRow[]) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("current_database()")) {
        return { rows: [{
          database_name: DATABASE_MARKERS[0],
          server_address: DATABASE_MARKERS[1],
          server_port: 5432,
          session_user_name: DATABASE_MARKERS[3],
          current_user_name: DATABASE_MARKERS[2],
        }] };
      }
      if (sql.includes("FROM lms_users")) return { rows: actorRows };
      throw new Error("Unexpected diagnostic SQL");
    },
  };
  return { pool: pool as unknown as Pick<Pool, "query">, calls };
}

async function requestDiagnostic(options: AppOptions) {
  const { pool, calls } = createPool(options.actorRows);
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
    sessionSecret: SECRET,
    runtimeEnvironment: "production",
    connectionMode: "legacy",
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
      body: JSON.stringify({ automationAccountPhone: INPUT_PHONE }),
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

function actorRow(overrides: Partial<ActorRow> = {}): ActorRow {
  return { id: 42, is_active: true, roles: ["admin"], ...overrides };
}

test("AVNI diagnostics deny non-admin users before querying the database", async () => {
  for (const roles of [["admissions"], ["student"]]) {
    const response = await requestDiagnostic({ actorRows: [actorRow()], roles });
    assert.equal(response.status, 403);
    assert.equal(response.calls.length, 0);
  }
});

test("AVNI diagnostics require an authenticated admin", async () => {
  const response = await requestDiagnostic({ actorRows: [actorRow()], authenticated: false });
  assert.equal(response.status, 401);
  assert.equal(response.calls.length, 0);
});

test("AVNI diagnostics use only SELECT queries and return no phone or database identity values", async () => {
  const response = await requestDiagnostic({ actorRows: [actorRow()] });
  assert.equal(response.status, 200);
  assert.equal(response.cacheControl, "no-store");
  assert.equal(response.calls.length, 2);
  assert.ok(response.calls.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
  assert.equal(response.calls[1].values?.[0], "+919000000001");

  assert.deepEqual(Object.keys(response.body).sort(), ["actor", "checkedAt", "database"]);
  assert.deepEqual(Object.keys(response.body.actor).sort(), [
    "active",
    "authorized",
    "matchCount",
    "roleNames",
  ]);
  assert.deepEqual(Object.keys(response.body.database).sort(), [
    "connectionMode",
    "fingerprint",
    "fingerprintAlgorithm",
    "runtimeEnvironment",
  ]);
  const serialized = JSON.stringify(response.body);
  for (const marker of [...DATABASE_MARKERS, INPUT_PHONE, "+919000000001", SECRET, "Test Administrator"]) {
    assert.equal(serialized.includes(marker), false);
  }
  assert.match(response.body.database.fingerprint, /^[a-f0-9]{64}$/);
});

test("no matching automation actor fails closed", async () => {
  const response = await requestDiagnostic({ actorRows: [] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.actor, {
    matchCount: 0,
    active: null,
    roleNames: [],
    authorized: false,
  });
});

test("duplicate phone matches fail closed without combining identities or roles", async () => {
  const response = await requestDiagnostic({
    actorRows: [actorRow({ id: 42 }), actorRow({ id: 43, roles: ["admissions"] })],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.actor, {
    matchCount: 2,
    active: null,
    roleNames: [],
    authorized: false,
  });
});

test("inactive actor fails closed while reporting its role names", async () => {
  const response = await requestDiagnostic({ actorRows: [actorRow({ is_active: false })] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.actor, {
    matchCount: 1,
    active: false,
    roleNames: ["admin"],
    authorized: false,
  });
});

test("active actor with a non-CRM role fails closed", async () => {
  const response = await requestDiagnostic({ actorRows: [actorRow({ roles: ["student"] })] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.actor, {
    matchCount: 1,
    active: true,
    roleNames: ["student"],
    authorized: false,
  });
});

test("unique active admin or admissions actor passes the existing CRM predicate", async () => {
  for (const role of ["admin", "admissions"]) {
    const response = await requestDiagnostic({ actorRows: [actorRow({ roles: [role] })] });
    assert.equal(response.status, 200);
    assert.equal(response.body.actor.matchCount, 1);
    assert.equal(response.body.actor.active, true);
    assert.deepEqual(response.body.actor.roleNames, [role]);
    assert.equal(response.body.actor.authorized, true);
  }
});

test("invalid phone returns a safe validation error without actor lookup", async () => {
  const { pool, calls } = createPool([actorRow()]);
  const app = express();
  app.use(express.json());
  registerAvniProductionDiagnosticsRoute(app, {
    pool,
    sessionSecret: SECRET,
    runtimeEnvironment: "production",
    connectionMode: "legacy",
    authenticate: (_req, _res, next) => next(),
    authorizeAdmin: (_req, _res, next) => next(),
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
      body: JSON.stringify({ automationAccountPhone: "not-a-phone" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: "invalid_diagnostic_request" });
    assert.equal(calls.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});

test("unavailable server endpoint identity fails closed without checking the actor", async () => {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: [{
        database_name: DATABASE_MARKERS[0],
        server_address: null,
        server_port: null,
        session_user_name: DATABASE_MARKERS[3],
        current_user_name: DATABASE_MARKERS[2],
      }] };
    },
  } as unknown as Pick<Pool, "query">;
  const app = express();
  app.use(express.json());
  registerAvniProductionDiagnosticsRoute(app, {
    pool,
    sessionSecret: SECRET,
    runtimeEnvironment: "production",
    connectionMode: "legacy",
    authenticate: (_req, _res, next) => next(),
    authorizeAdmin: (_req, _res, next) => next(),
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
      body: JSON.stringify({ automationAccountPhone: INPUT_PHONE }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "diagnostics_unavailable" });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\s*SELECT\b/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
