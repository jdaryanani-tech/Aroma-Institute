import assert from "node:assert/strict";
import test from "node:test";
import {
  createMetaBackfillService,
  createMetaBackfillWindow,
  getDefaultMetaBackfillDates,
  MetaBackfillError,
  safeMetaBackfillError,
} from "./backfill";

const TEST_TOKEN = "PRIVATE_PAGE_TOKEN_MARKER";
const TEST_SECRET = "unit-test-only-session-signing-secret";
const BASE_ENV = {
  META_PAGE_ID: "101",
  META_PAGE_ACCESS_TOKEN: TEST_TOKEN,
  META_GRAPH_API_VERSION: "v99.0",
  SESSION_SECRET: TEST_SECRET,
};
const FORM = { id: "201", name: "Test course form", status: "ACTIVE", created_time: "2026-01-01T00:00:00+05:30", leads_count: 2 };

type MockPage = { body: unknown; expectedAfter?: string };
type HarnessOptions = {
  formPages?: MockPage[];
  leadPages?: Record<string, MockPage[]>;
  existingIds?: string[];
  env?: Record<string, string | undefined>;
  respond?: (url: URL) => Response | undefined;
  persist?: (input: Record<string, unknown>, existing: Set<string>) => Promise<{ duplicate?: boolean }>;
};

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

function makeHarness(options: HarnessOptions = {}) {
  const urls: URL[] = [];
  const logs: unknown[] = [];
  const persistCalls: Array<Record<string, unknown>> = [];
  const existing = new Set(options.existingIds ?? []);
  let schemaReady = true;
  let currentTime = new Date("2026-04-03T00:00:00.000Z");
  let sleepCalls: number[] = [];
  const formPages = options.formPages ?? [{
    body: { data: [FORM] },
    expectedAfter: "",
  }];
  const leadPages = options.leadPages ?? {
    "201:": [{
      expectedAfter: "",
      body: { data: [] },
    }],
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const override = options.respond?.(url);
    if (override) return override;
    const parts = url.pathname.split("/").filter(Boolean);
    assert.equal(url.hostname, "graph.facebook.com");
    assert.equal(url.searchParams.get("access_token"), TEST_TOKEN);
    assert.equal(parts[0], "v99.0");
    if (parts[1] === "me") return jsonResponse({ id: BASE_ENV.META_PAGE_ID });
    if (parts[2] === "leadgen_forms") {
      const after = url.searchParams.get("after") ?? "";
      const page = formPages.find((candidate) => candidate.expectedAfter === after);
      assert.ok(page, `unexpected form cursor ${after}`);
      return jsonResponse(page.body);
    }
    if (parts[2] === "leads") {
      const after = url.searchParams.get("after") ?? "";
      const page = leadPages[`${parts[1]}:${after}`]?.[0];
      assert.ok(page, `unexpected lead cursor ${after}`);
      return jsonResponse(page.body);
    }
    throw new Error("unexpected Graph route");
  };
  const service = createMetaBackfillService({
    env: options.env ?? BASE_ENV,
    fetcher,
    sleep: async (milliseconds) => { sleepCalls.push(milliseconds); },
    now: () => currentTime,
    isSchemaReady: async () => schemaReady,
    findExistingMetaLeadIds: async (ids) => new Set(ids.filter((id) => existing.has(id))),
    persistLead: async (input) => {
      persistCalls.push(input);
      if (options.persist) return options.persist(input, existing);
      if (existing.has(input.metaLeadId)) return { duplicate: true };
      existing.add(input.metaLeadId);
      return { duplicate: false };
    },
    log: (entry) => logs.push(entry),
  });
  return {
    service,
    urls,
    logs,
    persistCalls,
    setSchemaReady: (value: boolean) => { schemaReady = value; },
    setTime: (value: Date) => { currentTime = value; },
    getSleepCalls: () => sleepCalls,
    clearSleepCalls: () => { sleepCalls = []; },
  };
}

const RANGE = { startDate: "2026-04-01", endDate: "2026-04-02" };

test("form inventory paginates and reconstructs requests instead of following paging.next", async () => {
  const harness = makeHarness({
    formPages: [
      {
        expectedAfter: "",
        body: {
          data: [FORM],
          paging: { next: "https://attacker.invalid/?access_token=DO_NOT_FOLLOW", cursors: { after: "forms-cursor-2" } },
        },
      },
      {
        expectedAfter: "forms-cursor-2",
        body: { data: [{ ...FORM, id: "202", status: "ARCHIVED" }] },
      },
    ],
  });
  const result = await harness.service.listForms();
  assert.deepEqual(result.forms.map((form) => [form.id, form.status]), [["201", "ACTIVE"], ["202", "ARCHIVED"]]);
  assert.equal(harness.urls.length, 3);
  assert.ok(harness.urls.every((url) => url.hostname === "graph.facebook.com"));
  assert.equal(harness.urls[2].searchParams.get("after"), "forms-cursor-2");
  assert.equal(harness.urls.some((url) => url.hostname === "attacker.invalid"), false);
});

test("preview uses the inclusive Asia/Kolkata date selection as an exact UTC half-open filter", async () => {
  const lead = {
    id: "301",
    created_time: "2026-04-01T12:00:00+05:30",
    form_id: "201",
    field_data: [{ name: "whatsapp_number", values: ["9876543210"] }],
  };
  const harness = makeHarness({
    leadPages: {
      "201:": [{ expectedAfter: "", body: { data: [lead] } }],
    },
  });
  const result = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  assert.equal(result.state, "complete");
  assert.equal(result.window.timezone, "Asia/Kolkata");
  assert.equal(result.window.startUtc, "2026-03-31T18:30:00.000Z");
  assert.equal(result.window.endUtcExclusive, "2026-04-02T18:30:00.000Z");
  assert.equal(result.totals.fetched, 1);
  assert.equal(result.totals.validPhone, 1);
  assert.equal(result.totals.eligibleNew, 1);
  const leadRequest = harness.urls.find((url) => url.pathname.endsWith("/201/leads"));
  assert.ok(leadRequest);
  assert.deepEqual(JSON.parse(leadRequest.searchParams.get("filtering") ?? "[]"), [
    { field: "time_created", operator: "GREATER_THAN_OR_EQUAL", value: 1_774_981_800 },
    { field: "time_created", operator: "LESS_THAN", value: 1_775_154_600 },
  ]);
  assert.equal(leadRequest.searchParams.get("fields"), "created_time,id,ad_id,form_id,field_data");
  assert.equal(leadRequest.searchParams.has("custom_disclaimer_responses"), false);
  assert.equal(harness.persistCalls.length, 0);
});

test("preview paginates leads, exact-ID checks existing CRM links, and classifies phones without writes", async () => {
  const first = {
    id: "302",
    created_time: "2026-04-01T12:00:00+05:30",
    form_id: "201",
    field_data: [{ name: "phone_number", values: [""] }, { name: "whatsapp_number", values: ["9876543210"] }],
  };
  const second = {
    id: "303",
    created_time: "2026-04-01T13:00:00+05:30",
    form_id: "201",
    field_data: [{ name: "whatsapp_number", values: ["invalid"] }],
  };
  const third = {
    id: "304",
    created_time: "2026-04-01T14:00:00+05:30",
    form_id: "201",
    field_data: [],
  };
  const harness = makeHarness({
    existingIds: ["304"],
    leadPages: {
      "201:": [{
        expectedAfter: "",
        body: { data: [first, second], paging: { next: "https://ignored.invalid/?token=SECRET", cursors: { after: "leads-page-2" } } },
      }],
      "201:leads-page-2": [{ expectedAfter: "leads-page-2", body: { data: [third] } }],
    },
  });
  let progress = await harness.service.startPreview(9, { formIds: ["201"], ...RANGE });
  assert.equal(progress.state, "running");
  progress = await harness.service.continuePreview(9, progress.continuationToken);
  assert.equal(progress.state, "complete");
  assert.deepEqual(progress.totals, {
    fetched: 3, alreadyPresent: 1, eligibleNew: 2, validPhone: 1, phoneReview: 1,
    imported: 0, importReview: 0, failed: 0,
  });
  assert.equal(progress.forms[0].fetched, 3);
  assert.equal(harness.urls.filter((url) => url.hostname !== "graph.facebook.com").length, 0);
  assert.equal(harness.persistCalls.length, 0);
});

test("a duplicate ID repeated within one Graph page counts only once", async () => {
  const lead = {
    id: "305",
    created_time: "2026-04-01T12:00:00+05:30",
    form_id: "201",
    field_data: [],
  };
  const harness = makeHarness({
    leadPages: { "201:": [{ expectedAfter: "", body: { data: [lead, lead] } }] },
  });
  const result = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  assert.equal(result.totals.fetched, 1);
  assert.equal(result.totals.eligibleNew, 1);
});

test("form and aggregate totals reconcile across selected forms", async () => {
  const secondForm = { ...FORM, id: "202", name: "Second form", status: "INACTIVE" };
  const harness = makeHarness({
    formPages: [{ expectedAfter: "", body: { data: [FORM, secondForm] } }],
    leadPages: {
      "201:": [{
        expectedAfter: "",
        body: { data: [{
          id: "310",
          created_time: "2026-04-01T12:00:00+05:30",
          form_id: "201",
          field_data: [{ name: "whatsapp_number", values: ["9876543210"] }],
        }] },
      }],
      "202:": [{
        expectedAfter: "",
        body: { data: [{
          id: "311",
          created_time: "2026-04-01T13:00:00+05:30",
          form_id: "202",
          field_data: [],
        }] },
      }],
    },
  });
  let progress = await harness.service.startPreview(7, { formIds: ["201", "202"], ...RANGE });
  while (progress.state === "running") {
    progress = await harness.service.continuePreview(7, progress.continuationToken);
  }
  assert.equal(progress.totals.fetched, 2);
  assert.equal(progress.totals.eligibleNew, 2);
  assert.equal(progress.forms.reduce((sum, form) => sum + form.fetched, 0), progress.totals.fetched);
  assert.equal(progress.forms.reduce((sum, form) => sum + form.eligibleNew, 0), progress.totals.eligibleNew);
  assert.deepEqual(progress.forms.map((form) => form.status), ["ACTIVE", "INACTIVE"]);
});

test("repeated lead cursors stop safely without advancing the run", async () => {
  const harness = makeHarness({
    leadPages: {
      "201:": [{
        expectedAfter: "",
        body: { data: [], paging: { next: "https://ignored.invalid", cursors: { after: "repeat-cursor" } } },
      }],
      "201:repeat-cursor": [{
        expectedAfter: "repeat-cursor",
        body: { data: [], paging: { next: "https://ignored.invalid", cursors: { after: "repeat-cursor" } } },
      }],
    },
  });
  const first = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  assert.equal(first.state, "running");
  await assert.rejects(
    harness.service.continuePreview(7, first.continuationToken),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "graph_cursor_repeated",
  );
});

test("preview token is admin-bound, expires, and cannot authorize an incomplete or changed-count import", async () => {
  const harness = makeHarness();
  const preview = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  await assert.rejects(
    harness.service.continuePreview(8, preview.continuationToken),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "continuation_wrong_admin",
  );
  await assert.rejects(
    harness.service.startImport(7, preview.continuationToken, { confirmed: true, count: 1 }),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "no_new_submissions",
  );
  harness.setTime(new Date("2026-04-04T01:00:01.000Z"));
  await assert.rejects(
    harness.service.continuePreview(7, preview.continuationToken),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "continuation_expired",
  );
});

test("an incomplete preview cannot be imported even when the caller supplies a plausible count", async () => {
  const lead = {
    id: "309",
    created_time: "2026-04-01T12:00:00+05:30",
    form_id: "201",
    field_data: [],
  };
  const harness = makeHarness({
    leadPages: {
      "201:": [{
        expectedAfter: "",
        body: { data: [lead], paging: { next: "https://ignored.invalid", cursors: { after: "page-2" } } },
      }],
      "201:page-2": [{ expectedAfter: "page-2", body: { data: [] } }],
    },
  });
  const preview = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  assert.equal(preview.state, "running");
  await assert.rejects(
    harness.service.startImport(7, preview.continuationToken, { confirmed: true, count: 1 }),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "preview_incomplete",
  );
  assert.equal(harness.persistCalls.length, 0);
});

test("import requires a completed preview and the exact confirmation count, then reuses idempotent persistence", async () => {
  const lead = {
    id: "306",
    created_time: "2026-04-01T12:00:00+05:30",
    form_id: "201",
    ad_id: "401",
    field_data: [{ name: "whatsapp_number", values: ["9876543210"] }],
  };
  const harness = makeHarness({
    leadPages: { "201:": [{ expectedAfter: "", body: { data: [lead] } }] },
  });
  const preview = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  await assert.rejects(
    harness.service.startImport(7, preview.continuationToken, { confirmed: true, count: 2 }),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "confirmation_count_mismatch",
  );
  const imported = await harness.service.startImport(7, preview.continuationToken, {
    confirmed: true,
    count: preview.totals.eligibleNew,
  });
  assert.equal(imported.phase, "import");
  assert.equal(imported.state, "complete");
  assert.equal(imported.totals.imported, 1);
  assert.equal(imported.totals.alreadyPresent, 0);
  assert.equal(harness.persistCalls.length, 1);
  assert.equal(harness.persistCalls[0].metaLeadId, "306");
  assert.equal(harness.persistCalls[0].pageId, "101");
  assert.equal(harness.persistCalls[0].formId, "201");
  assert.deepEqual(harness.persistCalls[0].fieldData, lead.field_data);
});

test("a second import from the same completed preview safely skips the now-existing Meta ID", async () => {
  const lead = {
    id: "307",
    created_time: "2026-04-01T12:00:00+05:30",
    form_id: "201",
    field_data: [],
  };
  const harness = makeHarness({
    leadPages: { "201:": [{ expectedAfter: "", body: { data: [lead] } }] },
  });
  const preview = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  const first = await harness.service.startImport(7, preview.continuationToken, {
    confirmed: true, count: preview.totals.eligibleNew,
  });
  const second = await harness.service.startImport(7, preview.continuationToken, {
    confirmed: true, count: preview.totals.eligibleNew,
  });
  assert.equal(first.totals.imported, 1);
  assert.equal(second.totals.imported, 0);
  assert.equal(second.totals.alreadyPresent, 1);
  assert.equal(harness.persistCalls.length, 1);
});

test("a failed import batch resumes with the same cursor and remains idempotent", async () => {
  const lead = {
    id: "308",
    created_time: "2026-04-01T12:00:00+05:30",
    form_id: "201",
    field_data: [{ name: "whatsapp_number", values: ["invalid"] }],
  };
  let failuresRemaining = 1;
  const harness = makeHarness({
    leadPages: { "201:": [{ expectedAfter: "", body: { data: [lead] } }] },
    persist: async (input, existing) => {
      if (failuresRemaining-- > 0) throw new Error("PRIVATE_DATABASE_ERROR");
      existing.add(String(input.metaLeadId));
      return { duplicate: false };
    },
  });
  const preview = await harness.service.startPreview(7, { formIds: ["201"], ...RANGE });
  let safeError: ReturnType<typeof safeMetaBackfillError> | undefined;
  await assert.rejects(
    harness.service.startImport(7, preview.continuationToken, {
      confirmed: true,
      count: preview.totals.eligibleNew,
    }),
    (error: unknown) => {
      safeError = safeMetaBackfillError(error);
      return error instanceof MetaBackfillError && error.code === "persistence_failed";
    },
  );
  assert.equal(safeError?.body.progress?.totals.failed, 1);
  assert.equal(JSON.stringify(safeError).includes("PRIVATE_DATABASE_ERROR"), false);
  const token = safeError?.body.progress?.continuationToken;
  assert.ok(token);
  const resumed = await harness.service.continueImport(7, token);
  assert.equal(resumed.state, "complete");
  assert.equal(resumed.totals.imported, 1);
  assert.equal(resumed.totals.importReview, 1);
  assert.equal(resumed.totals.failed, 0);
  assert.equal(resumed.totals.fetched, 1);
  assert.equal(harness.persistCalls.length, 2);
});

test("Page identity mismatch blocks form enumeration without exposing the returned identity", async () => {
  const harness = makeHarness({
    respond: (url) => url.pathname.endsWith("/me") ? jsonResponse({ id: "999" }) : undefined,
  });
  await assert.rejects(
    harness.service.listForms(),
    (error: unknown) => error instanceof MetaBackfillError
      && error.code === "page_identity_mismatch"
      && !error.message.includes("999"),
  );
  assert.equal(harness.urls.length, 1);
});

test("missing configuration and missing schema fail closed with safe categories", async () => {
  const missing = makeHarness({ env: { ...BASE_ENV, META_PAGE_ACCESS_TOKEN: "" } });
  await assert.rejects(
    missing.service.listForms(),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "meta_configuration_unavailable",
  );

  const noSchema = makeHarness();
  noSchema.setSchemaReady(false);
  await assert.rejects(
    noSchema.service.startPreview(7, { formIds: ["201"], ...RANGE }),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "meta_schema_unavailable",
  );
});

test("rate limits honor Retry-After and diagnostics never include token, URL, response body or PII", async () => {
  const logs: unknown[] = [];
  const urls: string[] = [];
  const service = createMetaBackfillService({
    env: BASE_ENV,
    fetcher: async (input) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname.endsWith("/me")) return jsonResponse({ id: BASE_ENV.META_PAGE_ID });
      return jsonResponse({
        error: {
          type: "RateLimitException",
          code: 4,
          error_subcode: 88,
          is_transient: true,
          message: "PRIVATE_RAW_MESSAGE PRIVATE_PHONE TOKEN_MARKER",
          private_payload: "PRIVATE_PAYLOAD",
        },
      }, 429, { "Retry-After": "60" });
    },
    sleep: async () => { throw new Error("429 must not retry before Retry-After"); },
    now: () => new Date("2026-04-03T00:00:00Z"),
    isSchemaReady: async () => true,
    findExistingMetaLeadIds: async () => new Set(),
    persistLead: async () => ({ duplicate: false }),
    log: (entry) => logs.push(entry),
  });
  let safe: ReturnType<typeof safeMetaBackfillError> | undefined;
  await assert.rejects(service.listForms(), (error: unknown) => {
    safe = safeMetaBackfillError(error);
    return error instanceof MetaBackfillError && error.code === "graph_rate_limited";
  });
  assert.equal(urls.length, 2);
  assert.equal(safe?.body.code, "graph_rate_limited");
  assert.equal(safe?.body.retryAfterSeconds, 60);
  assert.deepEqual(safe?.body.graph, {
    httpStatus: 429,
    errorType: "RateLimitException",
    errorCode: 4,
    errorSubcode: 88,
    isTransient: true,
  });
  const serialized = JSON.stringify({ safe, logs });
  for (const marker of [TEST_TOKEN, "PRIVATE_RAW_MESSAGE", "PRIVATE_PHONE", "PRIVATE_PAYLOAD", "TOKEN_MARKER", "graph.facebook.com"]) {
    assert.equal(serialized.includes(marker), false);
  }
});

test("a rate-limited preview preserves its encrypted progress and blocks resume until Retry-After", async () => {
  let now = new Date("2026-04-03T00:00:00.000Z");
  let leadRequests = 0;
  // Keep the test clock under control while retaining the normal service behavior.
  const service = createMetaBackfillService({
    env: BASE_ENV,
    fetcher: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/201/leads") && leadRequests++ === 0) {
        return jsonResponse({ error: { type: "RateLimitException", code: 4, is_transient: true } }, 429, { "Retry-After": "60" });
      }
      if (url.pathname.endsWith("/me")) return jsonResponse({ id: BASE_ENV.META_PAGE_ID });
      if (url.pathname.endsWith("/leadgen_forms")) return jsonResponse({ data: [FORM] });
      return jsonResponse({ data: [] });
    },
    sleep: async () => undefined,
    now: () => now,
    isSchemaReady: async () => true,
    findExistingMetaLeadIds: async () => new Set(),
    persistLead: async () => ({ duplicate: false }),
    log: () => undefined,
  });
  let safeError: ReturnType<typeof safeMetaBackfillError> | undefined;
  await assert.rejects(
    service.startPreview(7, { formIds: ["201"], ...RANGE }),
    (error: unknown) => {
      safeError = safeMetaBackfillError(error);
      return error instanceof MetaBackfillError && error.code === "graph_rate_limited";
    },
  );
  assert.equal(safeError?.body.retryAfterSeconds, 60);
  const continuation = safeError?.body.progress?.continuationToken;
  assert.ok(continuation);
  const callsAfterLimit = leadRequests;
  await assert.rejects(
    service.continuePreview(7, continuation),
    (error: unknown) => error instanceof MetaBackfillError
      && error.code === "graph_rate_limited"
      && error.retryAfterSeconds === 60,
  );
  assert.equal(leadRequests, callsAfterLimit);
  now = new Date(now.getTime() + 60_000);
  const resumed = await service.continuePreview(7, continuation);
  assert.equal(resumed.state, "complete");
});

test("only explicitly transient Graph failures retry, and Retry-After is honored within a small bound", async () => {
  let pageAttempts = 0;
  const harness = makeHarness({
    respond: (url) => {
      if (url.pathname.endsWith("/me")) return undefined;
      if (url.pathname.endsWith("/leadgen_forms") && pageAttempts++ === 0) {
        return jsonResponse({ error: { type: "ServerException", code: 1, is_transient: true, message: "PRIVATE" } }, 503, { "Retry-After": "1" });
      }
      return undefined;
    },
  });
  const result = await harness.service.listForms();
  assert.equal(result.forms.length, 1);
  assert.deepEqual(harness.getSleepCalls(), [1_000]);
});

test("date ranges are strict and default to 90 calendar days in Asia/Kolkata", () => {
  assert.throws(() => createMetaBackfillWindow("2026-04-02", "2026-04-01"),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "date_range_invalid");
  assert.throws(() => createMetaBackfillWindow("2025-01-01", "2026-01-01"),
    (error: unknown) => error instanceof MetaBackfillError && error.code === "date_range_too_large");
  const defaults = getDefaultMetaBackfillDates(new Date("2026-11-15T10:00:00.000Z"));
  assert.deepEqual(defaults, { startDate: "2026-08-18", endDate: "2026-11-15" });
  const window = createMetaBackfillWindow(defaults.startDate, defaults.endDate);
  assert.equal((Date.parse(window.endUtcExclusive) - Date.parse(window.startUtc)) / 86_400_000, 90);
});
