import test from "node:test";
import assert from "node:assert/strict";
import {
  META_PAGE_SUBSCRIBE_CONFIRM_VALUE,
  runMetaPageSubscription,
  type MetaGraphFetch,
} from "./page-subscription";

const PAGE_ID = "1096372060227919";
const APP_ID = "222222222222222";
const ACCESS_TOKEN = "synthetic-page-token-secret";
const GRAPH_VERSION = "v99.0";
const env = {
  META_PAGE_ID: PAGE_ID,
  META_APP_ID: APP_ID,
  META_PAGE_ACCESS_TOKEN: ACCESS_TOKEN,
  META_GRAPH_API_VERSION: GRAPH_VERSION,
};

function jsonResponse(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function requestUrl(input: string | URL | Request) {
  return input instanceof Request ? input.url : String(input);
}

test("preview reports an existing leadgen subscription without posting", async () => {
  const calls: Array<{ url: string; method: string; body?: URLSearchParams }> = [];
  const fetcher: MetaGraphFetch = async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body instanceof URLSearchParams ? init.body : undefined,
    });
    if (url.includes("/me?")) return jsonResponse({ id: PAGE_ID });
    return jsonResponse({ data: [{ id: APP_ID, subscribed_fields: ["feed", "leadgen"] }] });
  };

  const result = await runMetaPageSubscription(env, {
    apply: false,
    confirmationMatches: false,
    fetcher,
  });

  assert.equal(result.pageIdentityMatches, true);
  assert.equal(result.appInstalled, true);
  assert.equal(result.leadgenSubscribed, true);
  assert.equal(result.verified, true);
  assert.equal(result.postAttempted, false);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
});

test("guarded apply subscribes leadgen and verifies it with a follow-up GET", async () => {
  const calls: Array<{ url: string; method: string; init?: RequestInit }> = [];
  let subscriptionReads = 0;
  const fetcher: MetaGraphFetch = async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, init });
    if (url.includes("/me?")) return jsonResponse({ id: PAGE_ID });
    if (method === "POST") return jsonResponse({ success: true });
    subscriptionReads += 1;
    return jsonResponse({
      data: subscriptionReads === 1 ? [] : [{ id: APP_ID, subscribed_fields: ["leadgen"] }],
    });
  };

  const result = await runMetaPageSubscription(env, {
    apply: true,
    confirmationMatches: true,
    fetcher,
  });

  const post = calls.find((call) => call.method === "POST");
  assert.ok(post);
  assert.equal(new URL(post.url).search, "");
  assert.equal(post.init?.body instanceof URLSearchParams, true);
  const postBody = post.init?.body as URLSearchParams;
  assert.equal(postBody.get("subscribed_fields"), "leadgen");
  assert.equal(postBody.get("access_token"), ACCESS_TOKEN);
  assert.equal(result.postAttempted, true);
  assert.equal(result.postSucceeded, true);
  assert.equal(result.verificationChecked, true);
  assert.equal(result.verified, true);
  assert.equal(result.leadgenSubscribed, true);
});

test("adding leadgen preserves existing app subscriptions", async () => {
  let subscriptionReads = 0;
  let postedFields = "";
  const fetcher: MetaGraphFetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.includes("/me?")) return jsonResponse({ id: PAGE_ID });
    if (init?.method === "POST") {
      postedFields = (init.body as URLSearchParams).get("subscribed_fields") ?? "";
      return jsonResponse({ success: true });
    }
    subscriptionReads += 1;
    return jsonResponse({
      data: subscriptionReads === 1
        ? [{ id: APP_ID, subscribed_fields: ["feed"] }]
        : [{ id: APP_ID, subscribed_fields: ["feed", "leadgen"] }],
    });
  };

  const result = await runMetaPageSubscription(env, {
    apply: true,
    confirmationMatches: true,
    fetcher,
  });

  assert.equal(postedFields, "feed,leadgen");
  assert.equal(result.verified, true);
});

test("permission denial is sanitized and blocks apply", async () => {
  const fetcher: MetaGraphFetch = async (input) => {
    if (requestUrl(input).includes("/me?")) return jsonResponse({ id: PAGE_ID });
    return jsonResponse({ error: { message: `${ACCESS_TOKEN} ${PAGE_ID} ${APP_ID}` } }, 403);
  };

  const result = await runMetaPageSubscription(env, {
    apply: true,
    confirmationMatches: true,
    fetcher,
  });

  assert.equal(result.errorCategory, "permission_denied");
  assert.equal(result.postAttempted, false);
  const output = JSON.stringify(result);
  for (const secret of [ACCESS_TOKEN, PAGE_ID, APP_ID]) assert.equal(output.includes(secret), false);
});

test("wrong Page token identity stops before subscription inspection or POST", async () => {
  let calls = 0;
  const fetcher: MetaGraphFetch = async () => {
    calls += 1;
    return jsonResponse({ id: "different-page-id" });
  };

  const result = await runMetaPageSubscription(env, {
    apply: true,
    confirmationMatches: true,
    fetcher,
  });

  assert.equal(calls, 1);
  assert.equal(result.pageIdentityChecked, true);
  assert.equal(result.pageIdentityMatches, false);
  assert.equal(result.subscriptionChecked, false);
  assert.equal(result.postAttempted, false);
  assert.equal(result.errorCategory, "page_identity_mismatch");
  assert.equal(JSON.stringify(result).includes("different-page-id"), false);
});

test("missing configuration produces booleans and makes no request", async () => {
  let calls = 0;
  const result = await runMetaPageSubscription({
    META_PAGE_ID: PAGE_ID,
    META_APP_ID: APP_ID,
    META_PAGE_ACCESS_TOKEN: "",
    META_GRAPH_API_VERSION: GRAPH_VERSION,
  }, {
    apply: false,
    confirmationMatches: false,
    fetcher: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.configurationReady, false);
  assert.equal(result.pageAccessTokenPresent, false);
  assert.equal(result.errorCategory, "missing_configuration");
});

test("Graph failures never echo IDs, token, URL, or raw error body", async () => {
  const sensitiveUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me?access_token=${ACCESS_TOKEN}`;
  const rawMessage = `denied ${ACCESS_TOKEN} ${PAGE_ID} ${APP_ID} ${sensitiveUrl} private@example.invalid`;
  const fetcher: MetaGraphFetch = async () =>
    jsonResponse({ error: { message: rawMessage } }, 403);

  const result = await runMetaPageSubscription(env, {
    apply: false,
    confirmationMatches: false,
    fetcher,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.errorCategory, "permission_denied");
  for (const sensitive of [ACCESS_TOKEN, PAGE_ID, APP_ID, sensitiveUrl, rawMessage, "private@example.invalid"]) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test("apply requires the dedicated exact confirmation before network access", async () => {
  let calls = 0;
  const result = await runMetaPageSubscription(env, {
    apply: true,
    confirmationMatches: false,
    fetcher: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.errorCategory, "confirmation_required");
  assert.equal(META_PAGE_SUBSCRIBE_CONFIRM_VALUE, "SUBSCRIBE_LEADGEN_FOR_CONFIGURED_DEVELOPMENT_PAGE");
});

