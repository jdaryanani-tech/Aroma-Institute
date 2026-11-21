import assert from "node:assert/strict";
import test from "node:test";
import {
  runMetaLeadAdsReadinessDiagnostic,
  VERIFIED_AICHM_META_PAGE_ID,
  type MetaLeadAdsReadinessEnvironment,
} from "./lead-ads-readiness";
import type { MetaGraphFetch } from "./page-subscription";

const APP_ID = "222222222222222";
const APP_SECRET = "synthetic-app-secret";
const PAGE_TOKEN = "synthetic-page-token";
const FORM_ONE = "333333333333333";
const FORM_TWO = "444444444444444";
const NOW = new Date("2026-11-21T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

const BASE_ENV: MetaLeadAdsReadinessEnvironment = {
  META_PAGE_ID: VERIFIED_AICHM_META_PAGE_ID,
  META_APP_ID: APP_ID,
  META_APP_SECRET: APP_SECRET,
  META_PAGE_ACCESS_TOKEN: PAGE_TOKEN,
  META_GRAPH_API_VERSION: "v99.0",
  META_ALLOWED_FORM_IDS: `${FORM_ONE},${FORM_TWO}`,
};

type Fixture = {
  debug?: Record<string, unknown>;
  pageId?: string;
  subscription?: unknown;
  formPages?: Array<{ data: unknown[]; paging?: unknown }>;
  failingPath?: string;
};

function createFetcher(fixture: Fixture = {}) {
  const calls: Array<{ path: string; method: string; url: URL }> = [];
  let formPageIndex = 0;
  const fetcher: MetaGraphFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ path: url.pathname, method: init?.method ?? "GET", url });
    if (fixture.failingPath && url.pathname.endsWith(fixture.failingPath)) {
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: { message: `${APP_SECRET} ${PAGE_TOKEN}` } }),
      };
    }
    let body: unknown;
    if (url.pathname.endsWith("/debug_token")) {
      body = {
        data: fixture.debug ?? {
          is_valid: true,
          app_id: APP_ID,
          type: "PAGE",
          expires_at: NOW_SECONDS + 3_600,
          data_access_expires_at: NOW_SECONDS + 7_200,
          scopes: ["leads_retrieval", "pages_manage_metadata"],
          granular_scopes: [
            { scope: "leads_retrieval", target_ids: [VERIFIED_AICHM_META_PAGE_ID] },
            { scope: "pages_manage_metadata", target_ids: [VERIFIED_AICHM_META_PAGE_ID] },
          ],
        },
      };
    } else if (url.pathname.endsWith("/me")) {
      body = { id: fixture.pageId ?? VERIFIED_AICHM_META_PAGE_ID };
    } else if (url.pathname.endsWith("/subscribed_apps")) {
      body = fixture.subscription ?? {
        data: [{ id: APP_ID, subscribed_fields: ["leadgen"] }],
      };
    } else if (url.pathname.endsWith("/leadgen_forms")) {
      const pages = fixture.formPages ?? [{ data: [{ id: FORM_ONE }, { id: FORM_TWO }] }];
      const response = pages[Math.min(formPageIndex, pages.length - 1)];
      formPageIndex += 1;
      body = response;
    } else {
      throw new Error("unexpected_graph_request");
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetcher, calls };
}

async function inspect(
  fixture: Fixture = {},
  environment: MetaLeadAdsReadinessEnvironment = BASE_ENV,
) {
  const mock = createFetcher(fixture);
  const report = await runMetaLeadAdsReadinessDiagnostic(environment, {
    fetcher: mock.fetcher,
    now: () => NOW,
  });
  return { report, calls: mock.calls };
}

function validDebug(overrides: Record<string, unknown> = {}) {
  return {
    is_valid: true,
    app_id: APP_ID,
    type: "PAGE",
    expires_at: NOW_SECONDS + 3_600,
    data_access_expires_at: NOW_SECONDS + 7_200,
    scopes: ["leads_retrieval", "pages_manage_metadata"],
    granular_scopes: [
      { scope: "leads_retrieval", target_ids: [VERIFIED_AICHM_META_PAGE_ID] },
      { scope: "pages_manage_metadata", target_ids: [VERIFIED_AICHM_META_PAGE_ID] },
    ],
    ...overrides,
  };
}

test("Meta Lead Ads readiness verifies approved Page, app-bound token, permissions, subscription and each approved form", async () => {
  const { report, calls } = await inspect();
  assert.equal(report.configuredPageStatus, "approved");
  assert.equal(report.configuredPageIsAichmPage, true);
  assert.equal(report.tokenDebugChecked, true);
  assert.equal(report.tokenValid, true);
  assert.equal(report.tokenBelongsToConfiguredApp, true);
  assert.equal(report.tokenExpiryStatus, "valid");
  assert.equal(report.dataAccessExpiryStatus, "valid");
  assert.equal(report.leadRetrievalPermission, true);
  assert.equal(report.pageSubscriptionPermission, true);
  assert.equal(report.pageIdentityMatches, true);
  assert.equal(report.leadgenSubscribed, true);
  assert.equal(report.approvedFormAllowlistStatus, "configured");
  assert.equal(report.approvedFormCount, 2);
  assert.equal(report.formCheckStatus, "complete");
  assert.equal(report.accessibleApprovedFormCount, 2);
  assert.equal(report.inaccessibleApprovedFormCount, 0);
  assert.equal(report.allApprovedFormsAccessible, true);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(calls.some((call) => /\/leads(?:\/|$)/.test(call.path)), false);
  assert.deepEqual(calls.map((call) => call.path.split("/").at(-1)), [
    "debug_token", "me", "subscribed_apps", "leadgen_forms",
  ]);
  const serialized = JSON.stringify(report);
  for (const privateValue of [APP_ID, APP_SECRET, PAGE_TOKEN, FORM_ONE, FORM_TWO, VERIFIED_AICHM_META_PAGE_ID]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.equal(/access_token|input_token|granular_scopes|form_id/i.test(serialized), false);
});

test("missing Page token fails closed without a Graph request", async () => {
  const { report, calls } = await inspect({}, { ...BASE_ENV, META_PAGE_ACCESS_TOKEN: "" });
  assert.equal(report.tokenDebugChecked, false);
  assert.equal(report.safeCode, "missing_configuration");
  assert.equal(calls.length, 0);
});

test("invalid Page token is reported without continuing to Page checks", async () => {
  const { report, calls } = await inspect({ debug: validDebug({ is_valid: false }) });
  assert.equal(report.tokenDebugChecked, true);
  assert.equal(report.tokenValid, false);
  assert.equal(report.safeCode, "authentication_rejected");
  assert.equal(report.pageIdentityChecked, false);
  assert.equal(calls.length, 1);
});

test("expired token and expired data access both fail closed", async () => {
  const tokenExpired = await inspect({
    debug: validDebug({ expires_at: NOW_SECONDS - 1 }),
  });
  assert.equal(tokenExpired.report.tokenExpiryStatus, "expired");
  assert.equal(tokenExpired.report.safeCode, "authentication_rejected");
  assert.equal(tokenExpired.calls.length, 1);

  const dataExpired = await inspect({
    debug: validDebug({ data_access_expires_at: NOW_SECONDS - 1 }),
  });
  assert.equal(dataExpired.report.dataAccessExpiryStatus, "expired");
  assert.equal(dataExpired.report.safeCode, "authentication_rejected");
  assert.equal(dataExpired.calls.length, 1);
});

test("non-expiring token fields are represented safely", async () => {
  const { report } = await inspect({
    debug: validDebug({ expires_at: 0, data_access_expires_at: 0 }),
  });
  assert.equal(report.tokenExpiryStatus, "never_expires");
  assert.equal(report.dataAccessExpiryStatus, "never_expires");
  assert.equal(report.tokenExpiresAt, null);
  assert.equal(report.dataAccessExpiresAt, null);
});

test("wrong configured Page or Page-token identity is blocked", async () => {
  const configuredMismatch = await inspect({}, { ...BASE_ENV, META_PAGE_ID: "123456789" });
  assert.equal(configuredMismatch.report.configuredPageStatus, "mismatch");
  assert.equal(configuredMismatch.report.safeCode, "configured_page_mismatch");
  assert.equal(configuredMismatch.calls.length, 0);

  const graphMismatch = await inspect({ pageId: "123456789" });
  assert.equal(graphMismatch.report.pageIdentityChecked, true);
  assert.equal(graphMismatch.report.pageIdentityMatches, false);
  assert.equal(graphMismatch.report.subscriptionChecked, false);
  assert.equal(graphMismatch.calls.length, 2);
});

test("token issued to a different app is blocked before Page requests", async () => {
  const { report, calls } = await inspect({
    debug: validDebug({ app_id: "999999999999999" }),
  });
  assert.equal(report.tokenValid, true);
  assert.equal(report.tokenBelongsToConfiguredApp, false);
  assert.equal(report.safeCode, "authentication_rejected");
  assert.equal(calls.length, 1);
});

test("a valid non-Page token is not accepted as the configured Page token", async () => {
  const { report, calls } = await inspect({
    debug: validDebug({ type: "USER" }),
  });
  assert.equal(report.tokenValid, true);
  assert.equal(report.tokenTypeIsPage, false);
  assert.equal(report.safeCode, "authentication_rejected");
  assert.equal(report.pageIdentityChecked, false);
  assert.equal(calls.length, 1);
});

test("required permissions are checked, including Page-scoped granular grants", async () => {
  const missingScope = await inspect({
    debug: validDebug({ scopes: ["leads_retrieval"] }),
  });
  assert.equal(missingScope.report.leadRetrievalPermission, true);
  assert.equal(missingScope.report.pageSubscriptionPermission, false);

  const wrongTarget = await inspect({
    debug: validDebug({
      granular_scopes: [
        { scope: "leads_retrieval", target_ids: ["123456789"] },
        { scope: "pages_manage_metadata", target_ids: [VERIFIED_AICHM_META_PAGE_ID] },
      ],
    }),
  });
  assert.equal(wrongTarget.report.leadRetrievalPermission, false);
  assert.equal(wrongTarget.report.pageSubscriptionPermission, true);
});

test("missing app leadgen subscription is reported as a safe failure", async () => {
  const { report } = await inspect({
    subscription: { data: [{ id: APP_ID, subscribed_fields: ["feed"] }] },
  });
  assert.equal(report.subscriptionChecked, true);
  assert.equal(report.appInstalled, true);
  assert.equal(report.leadgenSubscribed, false);
  assert.equal(report.safeCode, "leadgen_subscription_missing");
});

test("missing, empty and invalid allowlists approve no forms and make no form request", async () => {
  const cases: Array<[string | undefined, "missing" | "empty" | "invalid"]> = [
    [undefined, "missing"],
    ["   ", "empty"],
    [`${FORM_ONE},not-an-id`, "invalid"],
  ];
  for (const [value, expectedStatus] of cases) {
    const env = { ...BASE_ENV, META_ALLOWED_FORM_IDS: value };
    const { report, calls } = await inspect({}, env);
    assert.equal(report.approvedFormAllowlistStatus, expectedStatus);
    assert.equal(report.approvedFormCount, 0);
    assert.equal(report.formCheckStatus, "not_checked");
    assert.equal(report.allApprovedFormsAccessible, null);
    assert.equal(calls.some((call) => call.path.endsWith("/leadgen_forms")), false);
  }
});

test("configured but inaccessible approved forms are counted without exposing IDs", async () => {
  const { report } = await inspect({
    formPages: [{ data: [{ id: FORM_ONE }] }],
  });
  assert.equal(report.approvedFormCount, 2);
  assert.equal(report.formCheckStatus, "complete");
  assert.equal(report.accessibleApprovedFormCount, 1);
  assert.equal(report.inaccessibleApprovedFormCount, 1);
  assert.equal(report.allApprovedFormsAccessible, false);
  assert.equal(JSON.stringify(report).includes(FORM_ONE), false);
});

test("form inventory pagination is bounded and only reports aggregate counts", async () => {
  const { report, calls } = await inspect({
    formPages: [
      { data: [{ id: "555555555555555" }], paging: { next: "redacted-next", cursors: { after: "synthetic-cursor" } } },
      { data: [{ id: FORM_ONE }, { id: FORM_TWO }] },
    ],
  });
  assert.equal(report.formCheckStatus, "complete");
  assert.equal(report.accessibleApprovedFormCount, 2);
  const formCalls = calls.filter((call) => call.path.endsWith("/leadgen_forms"));
  assert.equal(formCalls.length, 2);
  assert.equal(formCalls[1].url.searchParams.get("after"), "synthetic-cursor");
  assert.equal(JSON.stringify(report).includes("synthetic-cursor"), false);
});

test("form inventory stops after the configured page bound and fails closed", async () => {
  const pages = Array.from({ length: 6 }, (_, index) => ({
    data: [{ id: `5555555555555${index}` }],
    paging: { next: `next-${index}`, cursors: { after: `cursor-${index}` } },
  }));
  const { report, calls } = await inspect({ formPages: pages });
  assert.equal(report.formCheckStatus, "incomplete");
  assert.equal(report.allApprovedFormsAccessible, false);
  assert.equal(calls.filter((call) => call.path.endsWith("/leadgen_forms")).length, 5);
  assert.equal(report.safeCode, "form_list_incomplete");
});

test("Graph permission errors are reduced to a safe code", async () => {
  const { report } = await inspect({ failingPath: "/leadgen_forms" });
  const serialized = JSON.stringify(report);
  assert.equal(report.formCheckStatus, "failed");
  assert.equal(report.safeCode, "permission_denied");
  assert.equal(serialized.includes(APP_SECRET), false);
  assert.equal(serialized.includes(PAGE_TOKEN), false);
  assert.equal(serialized.includes("unexpected_graph_request"), false);
});
