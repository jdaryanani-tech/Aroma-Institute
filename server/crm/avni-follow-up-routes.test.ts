import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import test from "node:test";
import {
  createAvniFollowUpReadAuth,
  AVNI_FOLLOWUP_READ_PRINCIPAL,
  AVNI_FOLLOWUP_READ_SCOPE,
  avniReadCredentialIsDedicated,
  type AvniFollowUpReadAuditLogger,
} from "./avni-follow-up-read-auth";
import { registerAvniCrmFollowUpRoutes } from "./avni-follow-up-routes";
import { N8N_INTEGRATION_SECRET_HEADER, verifyN8nIntegrationSecret } from "../integrations/n8n-auth";

const READ_SECRET = "read-scope-test-secret";
const BROAD_SECRET = "legacy-broad-test-secret";
const PRIVATE_NAME = "Internal Test Name";
const PRIVATE_PHONE = "+919876543210";
const CANDIDATE_A = "f0453b63-40ae-4d34-a341-554ad9ec43c2";
const CANDIDATE_B = "288d0720-0e04-4da5-a9ee-d8a93162b3d3";

type PoolOptions = {
  schemaReady?: boolean;
  consentReady?: boolean;
  queryFailure?: boolean;
  candidates?: Record<string, unknown>[];
};

function createPool(options: PoolOptions = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("to_regclass('admissions_leads')")) {
        const ready = options.schemaReady !== false;
        return { rows: [{
          identity: ready,
          video: true,
          crm: ready,
          assignments: ready,
          attempts: true,
          marketing: true,
          calendar: true,
        }] };
      }
      if (sql.includes("to_regclass('admissions_lead_contact_preferences')")) {
        return { rows: [{ ready: options.consentReady !== false }] };
      }
      if (sql.includes("SELECT l.id AS candidate_ref")) {
        if (options.queryFailure) throw new Error("unavailable query details");
        return { rows: options.candidates ?? [] };
      }
      throw new Error("Unexpected candidate-read SQL");
    },
    async connect() {
      throw new Error("Candidate-read identity must not open a write transaction.");
    },
  };
  return { pool: pool as unknown as Pick<Pool, "query" | "connect">, calls };
}

function createApp(options: PoolOptions = {}, authOptions: {
  configuredSecret?: string;
  writeSecret?: string;
  logger?: AvniFollowUpReadAuditLogger;
} = {}) {
  const { pool, calls } = createPool(options);
  const audit: Parameters<AvniFollowUpReadAuditLogger>[0][] = [];
  const logger = authOptions.logger ?? (entry => audit.push(entry));
  const readAuth = createAvniFollowUpReadAuth({
    getSecret: () => authOptions.configuredSecret ?? READ_SECRET,
    getBroadSecret: () => authOptions.writeSecret ?? BROAD_SECRET,
    logger,
  });
  const writeAuth: RequestHandler = (req, res, next) => {
    if (!verifyN8nIntegrationSecret(
      req.get(N8N_INTEGRATION_SECRET_HEADER) ?? "",
      authOptions.writeSecret ?? BROAD_SECRET,
    )) {
      return void res.status(401).json({ code: "integration_authentication_required" });
    }
    return next();
  };
  const app = express();
  app.use(express.json());
  registerAvniCrmFollowUpRoutes(app, writeAuth, readAuth, pool);
  return { app, calls, audit };
}

async function request(
  context: ReturnType<typeof createApp>,
  path = "/api/integrations/n8n/crm/follow-ups/due",
  body: unknown = { limit: 10 },
  secret = READ_SECRET,
) {
  const server = context.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [N8N_INTEGRATION_SECRET_HEADER]: secret,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      cacheControl: response.headers.get("cache-control"),
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

function candidate(candidateRef: string, followUpAt: string) {
  return {
    candidate_ref: candidateRef,
    follow_up_at: followUpAt,
    version: 7,
    follow_up_kind: "routine",
    // Deliberately present in a mocked driver result: DTO mapping must exclude them.
    display_name: PRIVATE_NAME,
    phone: PRIVATE_PHONE,
    email: "private@example.test",
    message: "private message content",
  };
}

test("dedicated read secret is required and missing config fails closed", async () => {
  const context = createApp({}, { configuredSecret: "" });
  const response = await request(context);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { code: "follow_up_read_unavailable" });
  assert.equal(context.calls.length, 0);
  assert.equal(context.audit[0].outcome, "secret_not_configured");
});

test("dedicated read secret does not fall back to the broad shared integration secret", async () => {
  const context = createApp({}, { configuredSecret: READ_SECRET });
  const response = await request(context, undefined, { limit: 10 }, BROAD_SECRET);
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { code: "integration_authentication_required" });
  assert.equal(context.calls.length, 0);
  assert.equal(context.audit[0].outcome, "authentication_denied");
});

test("dedicated read secret must not equal the broad shared integration secret", async () => {
  const context = createApp({}, {
    configuredSecret: READ_SECRET,
    writeSecret: READ_SECRET,
  });
  const response = await request(context, undefined, { limit: 10 }, READ_SECRET);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { code: "follow_up_read_unavailable" });
  assert.equal(context.calls.length, 0);
  assert.equal(context.audit[0].outcome, "credential_not_dedicated");
});

test("read-only request cannot supply a phone, principal, or scope", async () => {
  const context = createApp();
  const response = await request(context, undefined, {
    limit: 10,
    automationAccountPhone: PRIVATE_PHONE,
    servicePrincipal: "admin",
    scope: "crm.write",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { code: "invalid_follow_up_request" });
  assert.equal(context.calls.length, 0);
  assert.equal(context.audit[0].outcome, "invalid_request");
});

test("candidate page size above the fixed cap is rejected before database access", async () => {
  const context = createApp();
  const response = await request(context, undefined, { limit: 101 });
  assert.equal(response.status, 400);
  assert.equal(context.calls.length, 0);
  assert.equal(context.audit[0].candidateCount, 0);
});

test("candidate read is bounded, parameterized, SELECT-only, assigned to active admissions, and redacted", async () => {
  const context = createApp({
    candidates: [
      candidate(CANDIDATE_A, "2026-11-15T03:30:00.000Z"),
      candidate(CANDIDATE_B, "2026-11-15T04:00:00.000Z"),
    ],
  });
  const response = await request(context, undefined, { limit: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.cacheControl, "private, no-store, max-age=0");
  assert.deepEqual(response.body, {
    items: [{
      candidateRef: CANDIDATE_A,
      followUpAt: "2026-11-15T03:30:00.000Z",
      expectedVersion: 7,
      followUpKind: "routine",
    }],
    nextCursor: {
      followUpAt: "2026-11-15T03:30:00.000Z",
      candidateRef: CANDIDATE_A,
    },
  });
  const serialized = JSON.stringify(response.body);
  const auditSerialized = JSON.stringify(context.audit);
  for (const marker of [PRIVATE_NAME, PRIVATE_PHONE, "private@example.test", "private message content"]) {
    assert.equal(serialized.includes(marker), false);
    assert.equal(auditSerialized.includes(marker), false);
  }
  assert.equal(auditSerialized.includes(CANDIDATE_A), false);
  assert.deepEqual(Object.keys(context.audit[0]).sort(), [
    "candidateCount",
    "correlationId",
    "event",
    "outcome",
    "scope",
    "servicePrincipal",
  ]);
  assert.equal(context.calls.length, 3);
  assert.ok(context.calls.every(({ sql }) => /^\s*(SELECT|WITH)\b/i.test(sql)));
  assert.equal(context.calls.some(({ sql }) => /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)), false);

  const selection = context.calls[2];
  assert.match(selection.sql, /latest\.follow_up_at IS NOT NULL AND latest\.follow_up_at<=now\(\)/);
  assert.match(selection.sql, /inquiry\.lead_id=l\.id/);
  assert.match(selection.sql, /latest\.stage NOT IN \('lost','enrolled'\)/);
  assert.match(selection.sql, /l\.canonical_phone IS NOT NULL/);
  assert.match(selection.sql, /JOIN admissions_lead_assignments assignment ON assignment\.lead_id=l\.id/);
  assert.match(selection.sql, /assignee\.is_active=true/);
  assert.match(selection.sql, /assigned_role\.role::text='admissions'/);
  assert.match(selection.sql, /consent\.consent_status='granted' AND consent\.opted_out_at IS NULL/);
  assert.match(selection.sql, /LIMIT \$\d+/);
  assert.deepEqual(selection.values, [2]);
  assert.doesNotMatch(selection.sql, /phone_e164\s*=\s*\$/);

  assert.deepEqual(context.audit, [{
    event: "avni.followup.candidates.read",
    correlationId: context.audit[0].correlationId,
    servicePrincipal: AVNI_FOLLOWUP_READ_PRINCIPAL,
    scope: AVNI_FOLLOWUP_READ_SCOPE,
    outcome: "success",
    candidateCount: 1,
  }]);
  assert.match(context.audit[0].correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(serialized.includes(context.audit[0].correlationId), false);
});

test("candidate pagination is parameterized and cursor fields are strictly validated", async () => {
  const context = createApp();
  const response = await request(context, undefined, {
    limit: 20,
    cursor: { followUpAt: "2026-11-15T03:30:00.000Z", candidateRef: CANDIDATE_A },
  });
  assert.equal(response.status, 200);
  const selection = context.calls[2];
  assert.match(selection.sql, /\(latest\.follow_up_at,l\.id\) > \(\$\d+::timestamptz,\$\d+::uuid\)/);
  assert.deepEqual(selection.values, ["2026-11-15T03:30:00.000Z", CANDIDATE_A, 21]);
});

test("missing consent or assignment schema fails closed before candidate selection", async () => {
  const noConsent = createApp({ consentReady: false });
  assert.equal((await request(noConsent)).status, 503);
  assert.equal(noConsent.calls.length, 2);
  assert.equal(noConsent.audit[0].outcome, "schema_unavailable");

  const noAssignments = createApp({ schemaReady: false });
  assert.equal((await request(noAssignments)).status, 503);
  assert.equal(noAssignments.calls.length, 1);
  assert.equal(noAssignments.audit[0].outcome, "schema_unavailable");
});

test("query failures return a safe response and redacted audit category", async () => {
  const context = createApp({ queryFailure: true });
  const response = await request(context);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { code: "follow_up_read_unavailable" });
  assert.equal(context.audit[0].outcome, "query_failed");
  assert.deepEqual(Object.keys(context.audit[0]).sort(), [
    "candidateCount",
    "correlationId",
    "event",
    "outcome",
    "scope",
    "servicePrincipal",
  ]);
});

test("dedicated read identity cannot access pause or delivery write routes", async () => {
  for (const path of [
    "/api/integrations/n8n/crm/follow-ups/pause",
    "/api/integrations/n8n/crm/follow-ups/delivered",
  ]) {
    const context = createApp();
    const response = await request(context, path, {}, READ_SECRET);
    assert.equal(response.status, 401);
    assert.equal(context.calls.length, 0);
  }
  assert.equal(verifyN8nIntegrationSecret(READ_SECRET, BROAD_SECRET), false);
  assert.equal(avniReadCredentialIsDedicated(READ_SECRET, BROAD_SECRET), true);
  assert.equal(avniReadCredentialIsDedicated(READ_SECRET, READ_SECRET), false);
});

