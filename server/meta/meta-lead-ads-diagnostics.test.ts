import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { once } from "node:events";
import test from "node:test";
import { requireLmsRole, type LmsRole } from "../lms/auth";
import {
  META_LEAD_ADS_DIAGNOSTICS_PATH,
  registerMetaLeadAdsDiagnosticsRoute,
} from "./routes";
import type { MetaGraphFetch } from "./page-subscription";
import { VERIFIED_AICHM_META_PAGE_ID } from "./lead-ads-readiness";

const pageId = VERIFIED_AICHM_META_PAGE_ID;
const appId = "222222222222222";
const token = "synthetic-page-token";
const appSecret = "synthetic-app-secret";
const formOne = "333333333333333";
const formTwo = "444444444444444";
const now = new Date("2026-11-21T00:00:00.000Z");
const environment = {
  META_PAGE_ID: pageId,
  META_APP_ID: appId,
  META_APP_SECRET: appSecret,
  META_PAGE_ACCESS_TOKEN: token,
  META_GRAPH_API_VERSION: "v99.0",
  META_ALLOWED_FORM_IDS: `${formOne},${formTwo}`,
} as NodeJS.ProcessEnv;

function graphResponse(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

async function callDiagnostic(options: {
  roles?: string[];
  authenticated?: boolean;
  fetcher?: MetaGraphFetch;
  environment?: NodeJS.ProcessEnv;
}) {
  const app = express();
  let calls = 0;
  const methods: string[] = [];
  const fetcher = options.fetcher ?? (async (input, init) => {
    calls += 1;
    methods.push(init?.method ?? "GET");
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/debug_token")) {
      return graphResponse({
        data: {
          is_valid: true,
          app_id: appId,
          type: "PAGE",
          expires_at: Math.floor(now.getTime() / 1_000) + 3_600,
          data_access_expires_at: Math.floor(now.getTime() / 1_000) + 7_200,
          scopes: ["leads_retrieval", "pages_manage_metadata"],
          granular_scopes: [
            { scope: "leads_retrieval", target_ids: [pageId] },
            { scope: "pages_manage_metadata", target_ids: [pageId] },
          ],
        },
      });
    }
    if (url.pathname.endsWith("/me")) return graphResponse({ id: pageId });
    if (url.pathname.endsWith("/subscribed_apps")) {
      return graphResponse({ data: [{ id: appId, subscribed_fields: ["leadgen"] }] });
    }
    if (url.pathname.endsWith("/leadgen_forms")) {
      return graphResponse({ data: [{ id: formOne }, { id: formTwo }] });
    }
    throw new Error("unexpected_graph_path");
  });
  const authenticate: RequestHandler = (req, res, next) => {
    if (options.authenticated === false) return void res.status(401).json({ code: "unauthorized" });
    req.lmsUser = {
      id: 1,
      phoneE164: "+919000000001",
      displayName: "Synthetic admin",
      roles: (options.roles ?? ["admin"]) as LmsRole[],
    };
    return next();
  };
  registerMetaLeadAdsDiagnosticsRoute(app, {
    authenticate,
    authorizeAdmin: requireLmsRole("admin"),
    environment: () => options.environment ?? environment,
    fetcher,
    now: () => now,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${META_LEAD_ADS_DIAGNOSTICS_PATH}`);
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.json(),
      calls,
      methods,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}

test("Meta Page diagnostics require authentication and admin role before Graph access", async () => {
  const unauthenticated = await callDiagnostic({ authenticated: false });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.calls, 0);
  const staff = await callDiagnostic({ roles: ["admissions"] });
  assert.equal(staff.status, 403);
  assert.equal(staff.calls, 0);
});

test("Meta Page diagnostics are no-store and expose only safe readiness booleans", async () => {
  const result = await callDiagnostic({});
  assert.equal(result.status, 200);
  assert.equal(result.cacheControl, "private, no-store, max-age=0");
  assert.equal(result.body.configuredPageStatus, "approved");
  assert.equal(result.body.tokenDebugChecked, true);
  assert.equal(result.body.tokenValid, true);
  assert.equal(result.body.tokenBelongsToConfiguredApp, true);
  assert.equal(result.body.tokenExpiryStatus, "valid");
  assert.equal(result.body.dataAccessExpiryStatus, "valid");
  assert.equal(result.body.leadRetrievalPermission, true);
  assert.equal(result.body.pageSubscriptionPermission, true);
  assert.equal(result.body.pageIdentityChecked, true);
  assert.equal(result.body.pageIdentityMatches, true);
  assert.equal(result.body.subscriptionChecked, true);
  assert.equal(result.body.leadgenSubscribed, true);
  assert.equal(result.body.approvedFormAllowlistStatus, "configured");
  assert.equal(result.body.approvedFormCount, 2);
  assert.equal(result.body.formCheckStatus, "complete");
  assert.equal(result.body.accessibleApprovedFormCount, 2);
  assert.equal(result.body.inaccessibleApprovedFormCount, 0);
  assert.equal(result.body.allApprovedFormsAccessible, true);
  assert.equal(result.body.requestApplied, false);
  assert.equal(result.body.diagnosticOnly, true);
  assert.equal(result.calls, 4);
  assert.deepEqual(result.methods, ["GET", "GET", "GET", "GET"]);
  const json = JSON.stringify(result.body);
  for (const value of [pageId, appId, token, appSecret, formOne, formTwo, "ACTIVE"]) {
    assert.equal(json.includes(value), false);
  }
  assert.equal(/access_token|input_token|lead_id|form_id|payload|granular_scopes/i.test(json), false);
});

test("Meta form permission failures are classified without leaking Graph details", async () => {
  const calls: string[] = [];
  const fetcher: MetaGraphFetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/debug_token")) {
      return graphResponse({
        data: {
          is_valid: true,
          app_id: appId,
          type: "PAGE",
          expires_at: Math.floor(now.getTime() / 1_000) + 3_600,
          data_access_expires_at: Math.floor(now.getTime() / 1_000) + 7_200,
          scopes: ["leads_retrieval", "pages_manage_metadata"],
        },
      });
    }
    if (url.pathname.endsWith("/me")) return graphResponse({ id: pageId });
    if (url.pathname.endsWith("/subscribed_apps")) {
      return graphResponse({ data: [{ id: appId, subscribed_fields: ["leadgen"] }] });
    }
    return graphResponse({
      error: {
        type: "GraphMethodException",
        code: 10,
        error_subcode: 200,
        is_transient: false,
        message: `private token=${token} page=${pageId} email@example.invalid`,
      },
    }, 403);
  };
  const result = await callDiagnostic({ fetcher });
  assert.equal(result.status, 200);
  assert.equal(result.body.safeCode, "permission_denied");
  assert.equal(result.body.formCheckStatus, "failed");
  const serialized = JSON.stringify(result.body);
  for (const value of [token, appSecret, pageId, appId, formOne, "email@example.invalid", "private token="]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.equal(calls.length, 4);
});
