import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createAvniDiagnosticsHandler } from "./avni-diagnostics";
import type { SupabaseAvniDiagnosticChecks } from "../db/supabase-avni-readonly";

const TEST_SECRET = "diagnostic-test-secret-never-return-this";

const allReaderChecksPass: SupabaseAvniDiagnosticChecks = {
  readerUrlPresent: true,
  readerUrlValid: true,
  readerCaPresent: true,
  readerCaAccepted: true,
  tlsConfigStrict: true,
  tlsConnected: true,
  tlsChainVerified: true,
  tlsHostnameVerified: true,
  readerDatabaseIsPostgres: true,
  readerRoleIsDedicated: true,
  readerSessionIsReadOnly: true,
  conversationsRpcExecutes: true,
  syntheticConversationIsEmpty: true,
  confirmationRpcExecutes: true,
  syntheticConfirmationIsFalse: true,
  publicLeadsSelectDenied: true,
  publicConversationsSelectDenied: true,
};

async function requestDiagnostics(
  handler: ReturnType<typeof createAvniDiagnosticsHandler>,
  headers: Record<string, string> = {},
) {
  const app = express();
  app.get("/diagnostics", handler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/diagnostics`, { headers });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("diagnostics authenticate without invoking checks for unauthenticated requests", async () => {
  let called = false;
  const handler = createAvniDiagnosticsHandler({
    environment: { N8N_VSL_REGISTRATION_WEBHOOK_SECRET: TEST_SECRET },
    runReaderDiagnostics: async () => {
      called = true;
      return allReaderChecksPass;
    },
    checkOperationalApiReady: async () => {
      called = true;
      return true;
    },
  });
  const response = await requestDiagnostics(handler);
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { status: "fail", checks: { requestAuthenticated: false } });
  assert.equal(called, false);
});

test("diagnostics report missing integration secret without running checks", async () => {
  let called = false;
  const handler = createAvniDiagnosticsHandler({
    environment: {},
    runReaderDiagnostics: async () => {
      called = true;
      return allReaderChecksPass;
    },
  });
  const response = await requestDiagnostics(handler, { "x-aichm-webhook-secret": TEST_SECRET });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    status: "fail",
    checks: { integrationSecretConfigured: false, requestAuthenticated: false },
  });
  assert.equal(called, false);
});

test("authenticated diagnostics return only redacted boolean checks and safe status labels", async () => {
  const handler = createAvniDiagnosticsHandler({
    environment: { N8N_VSL_REGISTRATION_WEBHOOK_SECRET: TEST_SECRET },
    runReaderDiagnostics: async () => allReaderChecksPass,
    checkOperationalApiReady: async () => true,
  });
  const response = await requestDiagnostics(handler, { "x-aichm-webhook-secret": TEST_SECRET });
  assert.equal(response.status, 200);
  assert.equal(response.cacheControl, "private, no-store, max-age=0");
  assert.deepEqual(response.body, {
    status: "pass",
    checks: {
      integrationSecretConfigured: true,
      requestAuthenticated: true,
      ...allReaderChecksPass,
      operationalApiReady: true,
    },
  });
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(TEST_SECRET), false);
  assert.equal(serialized.includes("postgresql://"), false);
  assert.equal(serialized.includes("message body"), false);
  assert.deepEqual(Object.keys(response.body).sort(), ["checks", "status"]);
  assert.ok(Object.values(response.body.checks).every((value) => typeof value === "boolean"));
});

test("authenticated diagnostics report failed internal checks without exposing exceptions", async () => {
  const handler = createAvniDiagnosticsHandler({
    environment: { N8N_VSL_REGISTRATION_WEBHOOK_SECRET: TEST_SECRET },
    runReaderDiagnostics: async () => ({ ...allReaderChecksPass, tlsChainVerified: false }),
    checkOperationalApiReady: async () => {
      throw new Error("raw diagnostic exception must not escape");
    },
  });
  const response = await requestDiagnostics(handler, { "x-aichm-webhook-secret": TEST_SECRET });
  assert.equal(response.status, 503);
  assert.equal(response.body.status, "fail");
  assert.equal(response.body.checks.tlsChainVerified, false);
  assert.equal(response.body.checks.operationalApiReady, false);
  assert.equal(JSON.stringify(response.body).includes("raw diagnostic exception"), false);
});
