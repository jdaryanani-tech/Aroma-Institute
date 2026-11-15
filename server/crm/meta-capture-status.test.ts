import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { registerCrmRoutes } from "./routes";

const SAFE_STATUS_KEYS = [
  "canonicalPersonLinked",
  "metaLinkExists",
  "metaLinkStatus",
  "primarySourceLabel",
  "receivedAt",
  "reviewCode",
].sort();

function createHarness(options: { metaTable?: boolean; errorCode?: string; linkState?: string } = {}) {
  let writes = 0;
  const db = {
    async query(query: string, values: unknown[] = []) {
      if (query.includes("AS identity")) {
        return { rows: [{
          identity: true, video: true, crm: true, assignments: true,
          attempts: false, marketing: false, calendar: false,
        }] };
      }
      if (query.includes("SELECT * FROM model WHERE")) {
        const id = values[0];
        const admissionsUserId = values[1];
        const isAssignedRequest = query.includes("assignee_user_id=$2::integer");
        if (id === "inquiry:101" && (!isAssignedRequest || admissionsUserId === 5)) {
          return { rows: [{
            id: "inquiry:101",
            lead_id: isAssignedRequest ? "canonical-internal-id" : null,
            inquiry_ids: [101],
            assignee_user_id: isAssignedRequest ? 5 : null,
            name: "PRIVATE_NAME_MARKER",
            phone: "PRIVATE_PHONE_MARKER",
            email: "PRIVATE_EMAIL_MARKER",
          }] };
        }
        return { rows: [] };
      }
      if (query.includes("to_regclass('admissions_meta_lead_links')")) {
        return { rows: [{ available: options.metaTable !== false }] };
      }
      if (query.includes("to_jsonb(i)->>'submission_source'")) {
        return { rows: [{
          id: 101,
          submission_source: "meta_instant_form",
          inquiry_lead_id: null,
          name: "PRIVATE_NAME_MARKER",
          email: "PRIVATE_EMAIL_MARKER",
          phone: "PRIVATE_PHONE_MARKER",
          message: "PRIVATE_MESSAGE_MARKER",
          field_data: "PRIVATE_PAYLOAD_MARKER",
        }] };
      }
      if (query.includes("FROM admissions_meta_lead_links")) {
        return { rows: [{
          inquiry_id: 101,
          state: options.linkState ?? "review",
          error_code: options.errorCode ?? "phone_unavailable_for_identity_link",
          received_at: "2026-11-15T14:18:13.177Z",
          lead_id: null,
          meta_lead_id: "PRIVATE_META_ID_MARKER",
          page_id: "PRIVATE_PAGE_ID_MARKER",
          form_id: "PRIVATE_FORM_ID_MARKER",
          field_data: "PRIVATE_PAYLOAD_MARKER",
        }] };
      }
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)) writes++;
      throw new Error(`Unexpected diagnostic query: ${query}`);
    },
  };
  const authenticate: RequestHandler = (req, _res, next) => {
    const role = req.header("x-test-role");
    if (role) req.lmsUser = { id: role === "admin" ? 1 : Number(req.header("x-test-user") ?? 2), roles: [role] };
    next();
  };
  const app = express();
  registerCrmRoutes(app, { db, connectionPool: db, authenticate });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  return {
    app,
    server,
    get writes() { return writes; },
    async start() {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}/api/admin/crm-meta-status/`;
    },
  };
}

test("Meta status endpoint requires CRM authorization and sets no-store on denials", async (t) => {
  const harness = createHarness();
  const base = await harness.start();
  t.after(() => harness.server.close());

  const anonymous = await fetch(`${base}inquiry%3A101`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);

  const unrelatedStaff = await fetch(`${base}inquiry%3A101`, {
    headers: { "x-test-role": "student" },
  });
  assert.equal(unrelatedStaff.status, 403);
  assert.match(unrelatedStaff.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(harness.writes, 0);
});

test("assigned admissions staff can read only assigned status; out-of-scope status is hidden", async (t) => {
  const harness = createHarness();
  const base = await harness.start();
  t.after(() => harness.server.close());

  const assigned = await fetch(`${base}inquiry%3A101`, {
    headers: { "x-test-role": "admissions", "x-test-user": "5" },
  });
  assert.equal(assigned.status, 200);
  const assignedBody = await assigned.json() as unknown[];
  assert.equal(assignedBody.length, 1);

  const notAssigned = await fetch(`${base}inquiry%3A101`, {
    headers: { "x-test-role": "admissions", "x-test-user": "6" },
  });
  assert.equal(notAssigned.status, 404);
  assert.match(notAssigned.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(harness.writes, 0);
});

test("admin receives only allowlisted status fields and no contact, Meta ID, or payload data", async (t) => {
  const harness = createHarness();
  const base = await harness.start();
  t.after(() => harness.server.close());

  const response = await fetch(`${base}inquiry%3A101`, {
    headers: { "x-test-role": "admin" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("vary") ?? "", /Cookie/i);
  const body = await response.json() as Array<Record<string, unknown>>;
  assert.equal(body.length, 1);
  assert.deepEqual(Object.keys(body[0]).sort(), SAFE_STATUS_KEYS);
  assert.deepEqual(body[0], {
    metaLinkExists: true,
    metaLinkStatus: "review",
    reviewCode: "phone_unavailable_for_identity_link",
    receivedAt: "2026-11-15T14:18:13.177Z",
    primarySourceLabel: "Meta Lead Ads",
    canonicalPersonLinked: false,
  });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|"(?:metaLeadId|pageId|formId|fieldData|payload|name|email|phone)"/i);
  assert.equal(harness.writes, 0);
});

test("status remains available when the broader marketing tables are unavailable", async (t) => {
  const harness = createHarness({ metaTable: true });
  const base = await harness.start();
  t.after(() => harness.server.close());

  const response = await fetch(`${base}inquiry%3A101`, {
    headers: { "x-test-role": "admin" },
  });
  const body = await response.json() as Array<Record<string, unknown>>;
  assert.equal(response.status, 200);
  assert.equal(body[0].metaLinkStatus, "review");
  assert.equal(body[0].reviewCode, "phone_unavailable_for_identity_link");
  assert.equal(body[0].primarySourceLabel, "Meta Lead Ads");
});

test("missing Meta link table returns only a safe not-found status", async (t) => {
  const harness = createHarness({ metaTable: false });
  const base = await harness.start();
  t.after(() => harness.server.close());

  const response = await fetch(`${base}inquiry%3A101`, {
    headers: { "x-test-role": "admin" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    metaLinkExists: null,
    metaLinkStatus: null,
    reviewCode: null,
    receivedAt: null,
    primarySourceLabel: "Meta Lead Ads",
    canonicalPersonLinked: false,
  }]);
});

test("unknown stored status text is reduced to fixed safe values", async (t) => {
  const harness = createHarness({
    errorCode: "PRIVATE_RAW_ERROR_MARKER",
    linkState: "PRIVATE_RAW_STATE_MARKER",
  });
  const base = await harness.start();
  t.after(() => harness.server.close());

  const response = await fetch(`${base}inquiry%3A101`, {
    headers: { "x-test-role": "admin" },
  });
  const body = await response.json() as Array<Record<string, unknown>>;
  assert.equal(response.status, 200);
  assert.equal(body[0].metaLinkStatus, "unknown");
  assert.equal(body[0].reviewCode, "other");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_RAW/);
});
