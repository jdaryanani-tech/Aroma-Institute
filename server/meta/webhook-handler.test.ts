import test from "node:test";
import assert from "node:assert/strict";
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import {
  createMetaLeadgenHandler,
  type MetaLeadgenHandlerDependencies,
} from "./webhook-handler";
import { createMetaGraphHttpError } from "./graph-error";
import {
  isMetaLeadgenWebhookRequest,
  logMetaWebhookUnhandledError,
  META_LEADGEN_WEBHOOK_PATH,
  metaWebhookBodyParserDiagnostic,
  metaWebhookRequestIdMiddleware,
  type MetaWebhookDiagnostic,
  type MetaWebhookDiagnosticLogger,
} from "./webhook-diagnostics";

const TEST_SIGNATURE = `sha256=${"a".repeat(64)}`;
const GOOD_BODY = {
  object: "page",
  entry: [{
    id: "111",
    changes: [{
      field: "leadgen",
      value: { leadgen_id: "222", page_id: "111", form_id: "333" },
    }],
  }],
};

type TestState = {
  events: MetaWebhookDiagnostic[];
  status: number | null;
  body: unknown;
  calls: { fetch: number; persist: number; schema: number };
  persistedFormIds: Array<string | null>;
};

function testDependencies(
  state: TestState,
  overrides: Partial<MetaLeadgenHandlerDependencies> = {},
): MetaLeadgenHandlerDependencies {
  const logger: MetaWebhookDiagnosticLogger = (entry) => state.events.push(entry);
  return {
    isConfigured: () => true,
    verifySignature: () => true,
    isSchemaReady: async () => {
      state.calls.schema++;
      return true;
    },
    expectedPageId: () => "111",
    allowedFormIds: () => new Set(["333"]),
    fetchLead: async (leadId) => {
      state.calls.fetch++;
      return { id: leadId, form_id: "333", field_data: [] };
    },
    persistLead: async (input) => {
      state.calls.persist++;
      state.persistedFormIds.push(input.formId);
    },
    logger,
    ...overrides,
  };
}

function testState(): TestState {
  return {
    events: [],
    status: null,
    body: undefined,
    calls: { fetch: 0, persist: 0, schema: 0 },
    persistedFormIds: [],
  };
}

function createTestApp(
  state: TestState,
  overrides: Partial<MetaLeadgenHandlerDependencies> = {},
  rawBodyOverride?: string,
) {
  const logger: MetaWebhookDiagnosticLogger = (entry) => state.events.push(entry);
  const app = express();
  app.use(metaWebhookRequestIdMiddleware);
  app.use(express.json({
    verify: (req, _res, buffer) => {
      req.rawBody = buffer;
    },
  }));
  app.use(metaWebhookBodyParserDiagnostic(logger));
  if (rawBodyOverride !== undefined) {
    app.use((req, _res, next) => {
      req.rawBody = Buffer.from(rawBodyOverride);
      next();
    });
  }
  app.post(META_LEADGEN_WEBHOOK_PATH, createMetaLeadgenHandler(
    testDependencies(state, { logger, ...overrides }),
  ));
  app.use((error: any, req: Request, res: Response, _next: (error?: unknown) => void) => {
    logMetaWebhookUnhandledError(req, error, logger);
    const status = error.status || error.statusCode || 500;
    state.status = status;
    state.body = { message: error.message || "Internal Server Error" };
    return res.status(status).json(state.body);
  });
  return app;
}

async function post(app: express.Express, body: string, signature?: string, contentType = "application/json") {
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${META_LEADGEN_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
      },
      body,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function code(state: TestState) {
  const latest = state.events.at(-1);
  assert.ok(latest && "reasonCode" in latest);
  return latest.reasonCode;
}

test("malformed JSON before the request logger gets a correlated safe diagnostic and preserves 400", async () => {
  const state = testState();
  const app = createTestApp(state);
  const response = await post(app, '{"private":"SENTINEL_PERSONAL_PAYLOAD');
  assert.equal(response.status, 400);
  assert.equal(code(state), "body_parser_invalid_json");
  assert.equal(state.calls.schema, 0);
  assert.match(state.events[0].requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(state.events).includes("SENTINEL_PERSONAL_PAYLOAD"), false);
});

test("invalid raw-body JSON returns the existing 400 with a safe reason", async () => {
  const state = testState();
  const app = createTestApp(state, {}, "{invalid raw body");
  const response = await post(app, JSON.stringify(GOOD_BODY), TEST_SIGNATURE);
  assert.equal(response.status, 400);
  assert.equal(code(state), "raw_body_invalid_json");
});

test("notification shape and identifier failures retain 400 and use stable reason codes", async (t) => {
  const cases: Array<[string, unknown, string]> = [
    ["missing envelope", {}, "notification_envelope_invalid"],
    ["empty entries", { entry: [] }, "notification_entry_invalid"],
    ["invalid entry", { entry: [null] }, "notification_entry_invalid"],
    ["missing changes", { entry: [{ id: "111" }] }, "notification_changes_invalid"],
    ["empty changes", { entry: [{ id: "111", changes: [] }] }, "notification_changes_invalid"],
    ["non-leadgen field", { entry: [{ id: "111", changes: [{ field: "other", value: {} }] }] }, "notification_not_leadgen"],
    ["invalid leadgen value", { entry: [{ id: "111", changes: [{ field: "leadgen", value: null }] }] }, "notification_value_invalid"],
    ["invalid lead ID", { entry: [{ id: "111", changes: [{ field: "leadgen", value: { leadgen_id: "bad", page_id: "111" } }] }] }, "notification_lead_id_invalid"],
    ["invalid page ID", { entry: [{ id: "111", changes: [{ field: "leadgen", value: { leadgen_id: "222", page_id: "bad" } }] }] }, "notification_page_id_invalid"],
  ];

  for (const [label, body, expectedCode] of cases) {
    await t.test(label, async () => {
      const state = testState();
      const response = await post(createTestApp(state), JSON.stringify(body), TEST_SIGNATURE);
      assert.equal(response.status, 400);
      assert.equal(code(state), expectedCode);
      assert.equal(state.calls.fetch, 0);
    });
  }
});

test("signature absence, malformed value, and mismatch remain 401 with safe diagnostics", async (t) => {
  const cases: Array<[string, string | undefined, boolean, string]> = [
    ["absent", undefined, false, "signature_header_absent"],
    ["malformed", "not-a-signature", false, "signature_header_malformed"],
    ["mismatch", TEST_SIGNATURE, false, "signature_mismatch"],
  ];
  for (const [label, signature, verification, expectedCode] of cases) {
    await t.test(label, async () => {
      const state = testState();
      const response = await post(
        createTestApp(state, { verifySignature: () => verification }),
        JSON.stringify(GOOD_BODY),
        signature,
      );
      assert.equal(response.status, 401);
      assert.equal(code(state), expectedCode);
      assert.equal(state.calls.schema, 0);
      assert.equal(state.calls.fetch, 0);
      assert.equal(state.calls.persist, 0);
    });
  }
});

test("signature validation still requires the captured raw JSON body", async () => {
  const state = testState();
  const response = await post(
    createTestApp(state),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
    "text/plain",
  );
  assert.equal(response.status, 401);
  assert.equal(code(state), "signature_raw_body_unavailable");
});

test("configuration and schema failures remain 503", async (t) => {
  const cases: Array<[string, Partial<MetaLeadgenHandlerDependencies>, string]> = [
    ["configuration missing", { isConfigured: () => false }, "lead_ads_configuration_missing"],
    ["schema not ready", { isSchemaReady: async () => false }, "meta_schema_not_ready"],
    ["schema query failed", { isSchemaReady: async () => { throw new Error("SENTINEL_DB_ERROR"); } }, "meta_schema_check_failed"],
  ];
  for (const [label, overrides, expectedCode] of cases) {
    await t.test(label, async () => {
      const state = testState();
      const response = await post(createTestApp(state, overrides), JSON.stringify(GOOD_BODY), TEST_SIGNATURE);
      assert.equal(response.status, 503);
      assert.equal(code(state), expectedCode);
      assert.equal(JSON.stringify(state.events).includes("SENTINEL_DB_ERROR"), false);
    });
  }
});

test("configured Page mismatch remains 403 and does not fetch the lead", async () => {
  const state = testState();
  const response = await post(
    createTestApp(state, { expectedPageId: () => "999" }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );
  assert.equal(response.status, 403);
  assert.equal(code(state), "configured_page_id_mismatch");
  assert.equal(state.calls.fetch, 0);
  assert.equal(state.calls.persist, 0);
});

test("missing or empty form allowlist fails closed before fetching or persisting", async (t) => {
  for (const [label, allowedFormIds] of [
    ["missing", null],
    ["empty", new Set<string>()],
  ] as const) {
    await t.test(label, async () => {
      const state = testState();
      const response = await post(
        createTestApp(state, { allowedFormIds: () => allowedFormIds }),
        JSON.stringify(GOOD_BODY),
        TEST_SIGNATURE,
      );
      assert.equal(response.status, 503);
      assert.equal(code(state), "form_allowlist_missing");
      assert.equal(state.calls.fetch, 0);
      assert.equal(state.calls.persist, 0);
    });
  }
});

test("same-Page notification from a form outside the allowlist is rejected before fetch", async () => {
  const state = testState();
  const unapprovedBody = JSON.stringify({
    entry: [{
      id: "111",
      changes: [{ field: "leadgen", value: { leadgen_id: "222", page_id: "111", form_id: "444" } }],
    }],
  });
  const response = await post(createTestApp(state), unapprovedBody, TEST_SIGNATURE);
  assert.equal(response.status, 403);
  assert.equal(code(state), "form_id_not_allowed");
  assert.equal(state.calls.fetch, 0);
  assert.equal(state.calls.persist, 0);
  assert.doesNotMatch(`${JSON.stringify(state.events)}${response.text}`, /444/);
});

test("matching notification and fetched form IDs persist the lead", async () => {
  const state = testState();
  const response = await post(
    createTestApp(state, {
      fetchLead: async (leadId) => ({ id: leadId, form_id: "333", field_data: [] }),
    }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );

  assert.equal(response.status, 200);
  assert.equal(state.calls.persist, 1);
  assert.deepEqual(state.persistedFormIds, ["333"]);
  assert.equal(state.events.at(-1)?.event, "meta_webhook");
  assert.equal(
    state.events.at(-1) && "outcome" in state.events.at(-1)! && state.events.at(-1)!.outcome,
    "success",
  );
});

test("mismatched notification and fetched form IDs are rejected before persistence without logging IDs", async () => {
  const state = testState();
  const response = await post(
    createTestApp(state, {
      fetchLead: async (leadId) => {
        state.calls.fetch++;
        return { id: leadId, form_id: "444", field_data: [] };
      },
    }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );

  assert.equal(response.status, 403);
  assert.equal(state.calls.fetch, 1);
  assert.equal(state.calls.persist, 0);
  assert.equal(code(state), "notification_form_id_mismatch");
  const diagnostic = JSON.stringify(state.events);
  assert.equal(diagnostic.includes("333"), false);
  assert.equal(diagnostic.includes("444"), false);
  assert.equal(response.text.includes("333"), false);
  assert.equal(response.text.includes("444"), false);
});

test("a later form mismatch prevents writes for earlier valid notifications in the same request", async () => {
  const state = testState();
  const batchedBody = {
    entry: [{
      id: "111",
      changes: [
        { field: "leadgen", value: { leadgen_id: "222", page_id: "111", form_id: "333" } },
        { field: "leadgen", value: { leadgen_id: "223", page_id: "111", form_id: "333" } },
      ],
    }],
  };
  const response = await post(
    createTestApp(state, {
      fetchLead: async (leadId) => {
        state.calls.fetch++;
        return {
          id: leadId,
          form_id: leadId === "222" ? "333" : "444",
          field_data: [],
        };
      },
    }),
    JSON.stringify(batchedBody),
    TEST_SIGNATURE,
  );

  assert.equal(response.status, 403);
  assert.equal(state.calls.fetch, 2);
  assert.equal(state.calls.persist, 0);
  assert.equal(code(state), "notification_form_id_mismatch");
  const safeOutput = `${JSON.stringify(state.events)}${response.text}`;
  for (const id of ["111", "222", "223", "333", "444"]) {
    assert.equal(safeOutput.includes(id), false);
  }
});

test("missing form ID on either side is rejected without persistence", async () => {
  const notificationWithoutFormId = JSON.stringify({
    entry: [{
      id: "111",
      changes: [{ field: "leadgen", value: { leadgen_id: "222", page_id: "111" } }],
    }],
  });
  const fetchedWithoutFormIdState = testState();
  const fetchedWithoutFormIdResponse = await post(
    createTestApp(fetchedWithoutFormIdState, {
      fetchLead: async (leadId) => ({ id: leadId, field_data: [] }),
    }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );
  assert.equal(fetchedWithoutFormIdResponse.status, 403);
  assert.equal(code(fetchedWithoutFormIdState), "graph_form_id_missing");
  assert.equal(fetchedWithoutFormIdState.calls.persist, 0);

  const notificationWithoutFormIdState = testState();
  const notificationWithoutFormIdResponse = await post(
    createTestApp(notificationWithoutFormIdState, {
      fetchLead: async (leadId) => ({ id: leadId, form_id: "333", field_data: [] }),
    }),
    notificationWithoutFormId,
    TEST_SIGNATURE,
  );
  assert.equal(notificationWithoutFormIdResponse.status, 403);
  assert.equal(code(notificationWithoutFormIdState), "notification_form_id_missing");
  assert.equal(notificationWithoutFormIdState.calls.fetch, 0);
  assert.equal(notificationWithoutFormIdState.calls.persist, 0);

  const blankNotificationState = testState();
  const blankNotificationBody = JSON.stringify({
    entry: [{
      id: "111",
      changes: [{ field: "leadgen", value: { leadgen_id: "222", page_id: "111", form_id: "  " } }],
    }],
  });
  const blankNotificationResponse = await post(
    createTestApp(blankNotificationState),
    blankNotificationBody,
    TEST_SIGNATURE,
  );
  assert.equal(blankNotificationResponse.status, 403);
  assert.equal(code(blankNotificationState), "notification_form_id_missing");
  assert.equal(blankNotificationState.calls.fetch, 0);
  assert.equal(blankNotificationState.calls.persist, 0);

  const blankGraphState = testState();
  const blankGraphResponse = await post(
    createTestApp(blankGraphState, {
      fetchLead: async (leadId) => ({ id: leadId, form_id: "  ", field_data: [] }),
    }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );
  assert.equal(blankGraphResponse.status, 403);
  assert.equal(code(blankGraphState), "graph_form_id_missing");
  assert.equal(blankGraphState.calls.persist, 0);
});

test("Graph HTTP errors retain their status but log only allowlisted status/category", async () => {
  const state = testState();
  const response = await post(
    createTestApp(state, { fetchLead: async () => { throw new Error("meta_graph_http_400"); } }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );
  assert.equal(response.status, 400);
  assert.equal(code(state), "graph_lead_fetch_http_failure");
  assert.deepEqual(state.events[0], {
    event: "meta_webhook",
    requestId: state.events[0].requestId,
    stage: "graph_fetch",
    reasonCode: "graph_lead_fetch_http_failure",
    httpStatus: 400,
    upstreamHttpStatus: 400,
    errorCategory: "graph_http_4xx",
  });
  assert.equal(response.text.includes("meta_graph_http_400"), false);
});

test("Graph error diagnostics include only safe upstream metadata and preserve webhook response", async () => {
  const state = testState();
  const graphError = await createMetaGraphHttpError(400, async () => ({
    error: {
      type: "OAuthException",
      code: 190,
      error_subcode: 463,
      is_transient: false,
      message: "SENTINEL_RAW_MESSAGE SENTINEL_TOKEN",
      fbtrace_id: "SENTINEL_TRACE",
      url: "SENTINEL_URL",
      access_token: "SENTINEL_PAGE_TOKEN",
      lead_id: "SENTINEL_LEAD_ID",
      form_id: "SENTINEL_FORM_ID",
      page_id: "SENTINEL_PAGE_ID",
      field_data: { email: "SENTINEL_PERSON_EMAIL" },
    },
  }));
  const response = await post(
    createTestApp(state, { fetchLead: async () => { throw graphError; } }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(response.text, '{"message":"Meta lead notification could not be processed. It is safe for Meta to retry."}');
  assert.deepEqual(state.events[0], {
    event: "meta_webhook",
    requestId: state.events[0].requestId,
    stage: "graph_fetch",
    reasonCode: "graph_lead_fetch_http_failure",
    httpStatus: 400,
    upstreamHttpStatus: 400,
    errorCategory: "graph_authentication_rejected",
    upstreamErrorType: "OAuthException",
    upstreamErrorCode: 190,
    upstreamErrorSubcode: 463,
    upstreamIsTransient: false,
  });
  const serialized = JSON.stringify({ events: state.events, response: response.text });
  for (const value of [
    "SENTINEL_RAW_MESSAGE",
    "SENTINEL_TOKEN",
    "SENTINEL_PAGE_TOKEN",
    "SENTINEL_URL",
    "SENTINEL_LEAD_ID",
    "SENTINEL_FORM_ID",
    "SENTINEL_PAGE_ID",
    "SENTINEL_FIELD_DATA",
    "SENTINEL_PERSON_EMAIL",
    "SENTINEL_TRACE",
  ]) {
    assert.equal(serialized.includes(value), false, `${value} must not be logged or returned`);
  }
});

test("persistence failures retain 503 and never log database error text", async () => {
  const state = testState();
  const response = await post(
    createTestApp(state, { persistLead: async () => { throw new Error("SENTINEL_DATABASE_PII_TOKEN"); } }),
    JSON.stringify(GOOD_BODY),
    TEST_SIGNATURE,
  );
  assert.equal(response.status, 503);
  assert.equal(code(state), "database_persistence_failed");
  assert.equal(JSON.stringify(state.events).includes("SENTINEL_DATABASE_PII_TOKEN"), false);
  assert.equal(response.text.includes("SENTINEL_DATABASE_PII_TOKEN"), false);
});

test("success emits only a success event and a server-generated correlation ID", async () => {
  const state = testState();
  const privateBody = {
    object: "page",
    entry: [{
      id: "111",
      changes: [{
        field: "leadgen",
        value: {
          leadgen_id: "222",
          page_id: "111",
          form_id: "333",
          name: "SENTINEL_PERSON_NAME",
          email: "SENTINEL_PERSON_EMAIL",
          phone: "SENTINEL_PERSON_PHONE",
        },
      }],
    }],
  };
  const response = await post(createTestApp(state), JSON.stringify(privateBody), TEST_SIGNATURE);
  assert.equal(response.status, 200);
  assert.deepEqual(state.events[0], {
    event: "meta_webhook",
    requestId: state.events[0].requestId,
    outcome: "success",
  });
  assert.equal(JSON.stringify(state.events).includes("SENTINEL_PERSON"), false);
  assert.equal(state.calls.persist, 1);
});

test("diagnostics never include signatures, payload fields, identifiers, or arbitrary exception text", async () => {
  const state = testState();
  const response = await post(
    createTestApp(state, {
      fetchLead: async () => {
        throw new Error("https://example.invalid/path?access_token=SENTINEL_TOKEN email=SENTINEL_EMAIL id=SENTINEL_LEAD");
      },
    }),
    JSON.stringify({
      entry: [{
        id: "111",
        changes: [{
          field: "leadgen",
          value: {
            leadgen_id: "222", page_id: "111", form_id: "333",
            email: "SENTINEL_EMAIL", phone: "SENTINEL_PHONE",
          },
        }],
      }],
    }),
    `sha256=${"b".repeat(64)}`,
  );
  assert.equal(response.status, 503);
  const serialized = JSON.stringify(state.events);
  for (const sentinel of ["SENTINEL_TOKEN", "SENTINEL_EMAIL", "SENTINEL_LEAD", "SENTINEL_PHONE", "example.invalid"]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("webhook path detection ignores query strings and does not capture unrelated routes", () => {
  const webhook = { method: "POST", path: META_LEADGEN_WEBHOOK_PATH } as Request;
  const other = { method: "POST", path: "/api/other" } as Request;
  assert.equal(isMetaLeadgenWebhookRequest(webhook), true);
  assert.equal(isMetaLeadgenWebhookRequest(other), false);
});
