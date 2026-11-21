import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express, { type RequestHandler } from "express";
import test from "node:test";
import type { AvniConversationControlWriter } from "./avni-conversation-control";
import { registerCrmRoutes } from "./routes";

const LEAD_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000002";

type Options = {
  role?: string;
  userId?: number;
  actorActive?: boolean;
  currentRoles?: string[];
  assigneeUserId?: number | null;
  consentStatus?: string | null;
  optedOutAt?: string | null;
  writerOutcome?: "changed" | "duplicate" | "version_conflict";
  writer?: AvniConversationControlWriter | null;
};

function createHarness(options: Options = {}) {
  let connectCalls = 0;
  let writerCalls = 0;
  let mockTransitionApplied = false;
  let auditWrites = 0;
  const statements: string[] = [];

  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push(normalized);
      if (/^INSERT\b/i.test(normalized)) auditWrites++;
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (normalized.includes("FROM lms_users")) {
        return { rows: options.actorActive === false ? [] : [{ id: 7, is_active: true }] };
      }
      if (normalized.includes("FROM lms_user_roles")) {
        return { rows: (options.currentRoles ?? ["admissions"]).map((role) => ({ role })) };
      }
      if (normalized.includes("FROM admissions_leads")) return { rows: [{ id: LEAD_ID }] };
      if (normalized.includes("FROM admissions_lead_assignments")) {
        return { rows: [{ assignee_user_id: options.assigneeUserId ?? 7 }] };
      }
      if (normalized.includes("FROM admissions_lead_contact_preferences")) {
        return {
          rows: options.consentStatus === null
            ? []
            : [{
              consent_status: options.consentStatus ?? "granted",
              opted_out_at: options.optedOutAt ?? null,
            }],
        };
      }
      throw new Error("unexpected_test_query");
    },
    release() {},
  };

  const pool = {
    async query(sql: string, values?: unknown[]) {
      return client.query(sql, values);
    },
    async connect() {
      connectCalls++;
      return client;
    },
  };
  const db = {
    async query(sql: string) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (/^\s*INSERT\b/i.test(sql)) auditWrites++;
      return { rows: [] };
    },
  };
  const writer: AvniConversationControlWriter | null = options.writer === undefined
    ? options.writerOutcome
      ? {
        async transitionForCanonicalLead(input) {
          writerCalls++;
          assert.equal(input.replitLeadId, LEAD_ID);
          assert.equal(input.actorRef, "replit_lms_user:7");
          if (options.writerOutcome === "changed") mockTransitionApplied = true;
          return {
            outcome: options.writerOutcome!,
            controlVersion: options.writerOutcome === "changed" ? 5 : 4,
          };
        },
      }
      : null
    : options.writer;

  const authenticate: RequestHandler = (req, _res, next) => {
    const role = req.header("x-test-role") ?? options.role;
    if (role) {
      const userId = Number(req.header("x-test-user") ?? options.userId ?? 7);
      req.lmsUser = { id: userId, roles: [role] } as NonNullable<typeof req.lmsUser>;
      req.session = { lmsUserId: userId } as typeof req.session;
    }
    next();
  };
  const app = express();
  app.use(express.json());
  registerCrmRoutes(app, {
    db,
    connectionPool: pool,
    authenticate,
    avniConversationControlWriter: writer,
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");

  return {
    server,
    statements,
    get connectCalls() { return connectCalls; },
    get writerCalls() { return writerCalls; },
    get mockTransitionApplied() { return mockTransitionApplied; },
    get auditWrites() { return auditWrites; },
    async start() {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

async function postControl(
  origin: string,
  body: Record<string, unknown>,
  options: { role?: string; userId?: number } = {},
) {
  const headers: Record<string, string> = {
    Origin: origin,
    "Content-Type": "application/json",
  };
  if (options.role) headers["x-test-role"] = options.role;
  if (options.userId !== undefined) headers["x-test-user"] = String(options.userId);
  return fetch(`${origin}/api/admin/crm/leads/${LEAD_ID}/conversation-control`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validBody = {
  action: "takeover",
  expectedControlVersion: 4,
  requestId: REQUEST_ID,
  reason: "Admissions staff taking over.",
};

test("control route denies unauthenticated requests and rejects non-CRM roles", async (t) => {
  const harness = createHarness();
  const origin = await harness.start();
  t.after(() => harness.server.close());

  const anonymous = await postControl(origin, validBody);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);

  const unauthorized = await postControl(origin, validBody, { role: "trainer" });
  assert.equal(unauthorized.status, 403);
  assert.equal(harness.connectCalls, 0);
  assert.equal(harness.writerCalls, 0);
});

test("admissions staff cannot control an unassigned lead", async (t) => {
  const harness = createHarness({ role: "admissions", assigneeUserId: 8, writerOutcome: "changed" });
  const origin = await harness.start();
  t.after(() => harness.server.close());

  const response = await postControl(origin, validBody, { role: "admissions" });
  const body = await response.json() as { code: string; sendAuthorized: boolean };
  assert.equal(response.status, 403);
  assert.equal(body.code, "lead_assignment_denied");
  assert.equal(body.sendAuthorized, false);
  assert.equal(harness.writerCalls, 0);
  assert.equal(harness.mockTransitionApplied, false);
  assert.ok(harness.statements.includes("ROLLBACK"));
});

test("stale control versions return a conflict without applying the transition", async (t) => {
  const harness = createHarness({ role: "admin", writerOutcome: "version_conflict" });
  const origin = await harness.start();
  t.after(() => harness.server.close());

  const response = await postControl(origin, validBody, { role: "admin" });
  const body = await response.json() as { code: string; sendAuthorized: boolean };
  assert.equal(response.status, 409);
  assert.equal(body.code, "stale_control_version");
  assert.equal(body.sendAuthorized, false);
  assert.equal(harness.writerCalls, 1);
  assert.equal(harness.mockTransitionApplied, false);
});

test("missing conversation writer fails closed without connecting or changing state", async (t) => {
  const harness = createHarness({ role: "admin", writer: null });
  const origin = await harness.start();
  t.after(() => harness.server.close());

  const response = await postControl(origin, validBody, { role: "admin" });
  const body = await response.json() as {
    status: string;
    code: string;
    controlVersion: number | null;
    sendAuthorized: boolean;
  };
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    status: "unavailable",
    code: "runtime_unavailable",
    controlVersion: null,
    sendAuthorized: false,
  });
  assert.equal(harness.connectCalls, 0);
  assert.equal(harness.writerCalls, 0);
  assert.equal(harness.mockTransitionApplied, false);
});

test("mock-only authorized control transition remains explicitly unable to authorize sending", async (t) => {
  const harness = createHarness({
    role: "admissions",
    currentRoles: ["admissions"],
    assigneeUserId: 7,
    writerOutcome: "changed",
  });
  const origin = await harness.start();
  t.after(() => harness.server.close());

  const response = await postControl(origin, validBody, { role: "admissions" });
  const body = await response.json() as {
    status: string;
    code: string;
    controlVersion: number | null;
    sendAuthorized: boolean;
  };
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    status: "changed",
    code: "control_changed",
    controlVersion: 5,
    sendAuthorized: false,
  });
  assert.equal(harness.writerCalls, 1);
  assert.equal(harness.mockTransitionApplied, true);
  assert.equal(harness.statements.includes("COMMIT"), true);
  assert.equal(harness.statements.some((sql) => /send|provider/i.test(sql)), false);
});

test("control route rejects caller-supplied actor, lead, consent, or Supabase claims", async (t) => {
  const harness = createHarness({ role: "admin", writerOutcome: "changed" });
  const origin = await harness.start();
  t.after(() => harness.server.close());

  const response = await postControl(origin, {
    ...validBody,
    canonicalLeadId: "30000000-0000-4000-8000-000000000003",
    actorId: 999,
    whatsappConsentGranted: true,
    threadId: "40000000-0000-4000-8000-000000000004",
  }, { role: "admin" });
  const body = await response.json() as { code: string; sendAuthorized: boolean };
  assert.equal(response.status, 400);
  assert.equal(body.code, "invalid_control_request");
  assert.equal(body.sendAuthorized, false);
  assert.equal(harness.connectCalls, 0);
  assert.equal(harness.writerCalls, 0);
});

test("resume still requires current consent and rejects an opt-out", async (t) => {
  for (const fixture of [
    { consentStatus: "not_provided" },
    { consentStatus: "granted", optedOutAt: "2026-11-18T00:00:00.000Z" },
  ]) {
    const harness = createHarness({ role: "admin", writerOutcome: "changed", ...fixture });
    const origin = await harness.start();
    t.after(() => harness.server.close());

    const response = await postControl(origin, { ...validBody, action: "resume" }, { role: "admin" });
    const body = await response.json() as { code: string; sendAuthorized: boolean };
    assert.equal(response.status, 403);
    assert.equal(body.code, fixture.consentStatus === "not_provided"
      ? "whatsapp_consent_not_granted"
      : "whatsapp_opted_out");
    assert.equal(body.sendAuthorized, false);
    assert.equal(harness.writerCalls, 0);
  }
});
