import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { MetaBackfillError } from "../meta/backfill";
import type { MetaBackfillService } from "../meta/backfill";
import { registerCrmRoutes } from "./routes";

const PRIVATE_MARKERS = [
  "PRIVATE_CONTACT_MARKER",
  "PRIVATE_PHONE_MARKER",
  "PRIVATE_EMAIL_MARKER",
  "PRIVATE_LEAD_ID_MARKER",
  "PRIVATE_PAGE_ID_MARKER",
  "PRIVATE_PAYLOAD_MARKER",
  "PRIVATE_TOKEN_MARKER",
];

function createHarness(options: { throwPrivateProgress?: boolean } = {}) {
  let auditWrites = 0;
  let serviceCalls = 0;
  const db = {
    async query(query: string) {
      if (/^\s*INSERT\b/i.test(query)) auditWrites++;
      return { rows: [] };
    },
  };
  const authenticate: RequestHandler = (req, _res, next) => {
    const role = req.header("x-test-role");
    if (role) req.lmsUser = {
      id: Number(req.header("x-test-user") ?? (role === "admin" ? 1 : 2)),
      roles: [role as "admin" | "admissions"],
    };
    next();
  };
  const service = {
    async listForms() {
      serviceCalls++;
      return {
        forms: [{
          id: "201",
          name: "Aroma course form",
          status: "ACTIVE",
          createdAt: "2026-01-01T00:00:00.000Z",
          leadsCount: 7,
          metaLeadId: PRIVATE_MARKERS[3],
          phone: PRIVATE_MARKERS[1],
          rawPayload: PRIVATE_MARKERS[5],
        }],
      };
    },
    async startPreview() {
      serviceCalls++;
      if (options.throwPrivateProgress) {
        const error = new MetaBackfillError("persistence_failed", 503);
        error.progress = {
          phase: "preview",
          state: "complete",
          continuationToken: "opaque-encrypted-continuation-token",
          expiresAt: "2026-01-01T08:00:00.000Z",
          window: {
            timezone: "Asia/Kolkata",
            startDate: "2025-10-01",
            endDate: "2025-12-29",
            startUtc: "2025-09-30T18:30:00.000Z",
            endUtcExclusive: "2025-12-29T18:30:00.000Z",
            maximumDays: 365,
            private: PRIVATE_MARKERS[5],
          },
          batchSize: 40,
          identityResolution: "determined_during_import",
          approvedImportCount: null,
          forms: [{
            formId: "201",
            name: "Aroma course form",
            status: "ACTIVE",
            fetched: 0,
            alreadyPresent: 0,
            eligibleNew: 0,
            validPhone: 0,
            phoneReview: 0,
            imported: 0,
            importReview: 0,
            failed: 0,
            metaLeadId: PRIVATE_MARKERS[3],
            rawPayload: PRIVATE_MARKERS[5],
          }],
          totals: {
            fetched: 0, alreadyPresent: 0, eligibleNew: 0, validPhone: 0, phoneReview: 0,
            imported: 0, importReview: 0, failed: 0, private: PRIVATE_MARKERS[0],
          },
          raw: PRIVATE_MARKERS.join("|"),
        } as unknown as NonNullable<typeof error.progress>;
        throw error;
      }
      return {
        phase: "preview",
        state: "complete",
        continuationToken: "opaque-encrypted-continuation-token",
        expiresAt: "2026-01-01T08:00:00.000Z",
        window: {
          timezone: "Asia/Kolkata",
          startDate: "2025-10-01",
          endDate: "2025-12-29",
          startUtc: "2025-09-30T18:30:00.000Z",
          endUtcExclusive: "2025-12-29T18:30:00.000Z",
          maximumDays: 365,
          raw: PRIVATE_MARKERS[5],
        },
        batchSize: 40,
        identityResolution: "determined_during_import",
        approvedImportCount: null,
        forms: [{
          formId: "201",
          name: "Aroma course form",
          status: "ACTIVE",
          fetched: 10,
          alreadyPresent: 2,
          eligibleNew: 8,
          validPhone: 6,
          phoneReview: 2,
          imported: 0,
          importReview: 0,
          failed: 0,
          metaLeadId: PRIVATE_MARKERS[3],
          contact: PRIVATE_MARKERS[0],
        }],
        totals: {
          fetched: 10,
          alreadyPresent: 2,
          eligibleNew: 8,
          validPhone: 6,
          phoneReview: 2,
          imported: 0,
          importReview: 0,
          failed: 0,
          payload: PRIVATE_MARKERS[5],
        },
        privateData: PRIVATE_MARKERS.join("|"),
      };
    },
    async continuePreview() { serviceCalls++; return this.startPreview(); },
    async startImport() { serviceCalls++; return this.startPreview(); },
    async continueImport() { serviceCalls++; return this.startPreview(); },
  };
  const app = express();
  app.use(express.json());
  registerCrmRoutes(app, {
    db,
    connectionPool: db,
    authenticate,
    metaBackfill: service as unknown as MetaBackfillService,
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  return {
    server,
    get auditWrites() { return auditWrites; },
    get serviceCalls() { return serviceCalls; },
    async start() {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

test("form inventory is administrator-only, no-store and strictly allowlisted", async (t) => {
  const harness = createHarness();
  const origin = await harness.start();
  t.after(() => harness.server.close());

  const anonymous = await fetch(`${origin}/api/admin/crm/meta-backfill/forms`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);

  const staff = await fetch(`${origin}/api/admin/crm/meta-backfill/forms`, {
    headers: { "x-test-role": "admissions", "x-test-user": "5" },
  });
  assert.equal(staff.status, 403);
  assert.match(staff.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(harness.serviceCalls, 0);

  const admin = await fetch(`${origin}/api/admin/crm/meta-backfill/forms`, {
    headers: { "x-test-role": "admin" },
  });
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get("cache-control") ?? "", /no-store/);
  const body = await admin.json() as { forms: Array<Record<string, unknown>>; correlationId: string };
  assert.match(body.correlationId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(Object.keys(body.forms[0]).sort(), ["createdAt", "id", "leadsCount", "name", "status"]);
  assert.equal(JSON.stringify(body).includes("PRIVATE_"), false);
  assert.equal(harness.auditWrites, 1);
});

test("admissions staff cannot preview or import, and writes require same-origin CSRF protection", async (t) => {
  const harness = createHarness();
  const origin = await harness.start();
  t.after(() => harness.server.close());
  const path = `${origin}/api/admin/crm/meta-backfill/preview/start`;
  const payload = JSON.stringify({ formIds: ["201"], startDate: "2025-10-01", endDate: "2025-12-29" });

  const staff = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "x-test-role": "admissions", "x-test-user": "5" },
    body: payload,
  });
  assert.equal(staff.status, 403);
  assert.match(staff.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(harness.serviceCalls, 0);

  const adminWithoutOrigin = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-role": "admin" },
    body: payload,
  });
  assert.equal(adminWithoutOrigin.status, 403);
  assert.equal(harness.serviceCalls, 0);
});

test("preview endpoint strips every non-allowlisted field and never includes lead or contact markers", async (t) => {
  const harness = createHarness();
  const origin = await harness.start();
  t.after(() => harness.server.close());
  const response = await fetch(`${origin}/api/admin/crm/meta-backfill/preview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "x-test-role": "admin" },
    body: JSON.stringify({ formIds: ["201"], startDate: "2025-10-01", endDate: "2025-12-29" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.json() as Record<string, any>;
  assert.deepEqual(Object.keys(body).sort(), [
    "approvedImportCount", "batchSize", "continuationToken", "correlationId", "expiresAt",
    "forms", "identityResolution", "phase", "state", "totals", "window",
  ]);
  assert.deepEqual(Object.keys(body.forms[0]).sort(), [
    "alreadyPresent", "eligibleNew", "failed", "fetched", "formId", "importReview",
    "imported", "name", "phoneReview", "status", "validPhone",
  ]);
  assert.deepEqual(Object.keys(body.window).sort(), [
    "endDate", "endUtcExclusive", "maximumDays", "startDate", "startUtc", "timezone",
  ]);
  const serialized = JSON.stringify(body);
  for (const marker of PRIVATE_MARKERS) assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("PRIVATE"), false);
});

test("error progress is also projected through the strict allowlist", async (t) => {
  const harness = createHarness({ throwPrivateProgress: true });
  const origin = await harness.start();
  t.after(() => harness.server.close());
  const response = await fetch(`${origin}/api/admin/crm/meta-backfill/preview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "x-test-role": "admin" },
    body: JSON.stringify({ formIds: ["201"], startDate: "2025-10-01", endDate: "2025-12-29" }),
  });
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.json() as Record<string, any>;
  assert.deepEqual(Object.keys(body).sort(), ["code", "correlationId", "message", "progress"]);
  assert.deepEqual(Object.keys(body.progress).sort(), [
    "approvedImportCount", "batchSize", "continuationToken", "expiresAt", "forms",
    "identityResolution", "phase", "state", "totals", "window",
  ]);
  const serialized = JSON.stringify(body);
  for (const marker of PRIVATE_MARKERS) assert.equal(serialized.includes(marker), false);
});
