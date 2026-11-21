import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { once } from "node:events";
import test from "node:test";
import { requireLmsRole, type LmsRole } from "../lms/auth";
import { registerMetaStatusRoute } from "./routes";

const formIdOne = "987654321012345";
const formIdTwo = "123456789098765";
const secretMarker = "synthetic-meta-secret-must-not-leak";
const tokenMarker = "synthetic-page-token-must-not-leak";

async function readMetaStatus(environment: NodeJS.ProcessEnv) {
  const app = express();
  const authenticate: RequestHandler = (req, _res, next) => {
    req.lmsUser = {
      id: 1,
      phoneE164: "+919000000001",
      displayName: "Synthetic admin",
      roles: ["admin"] as LmsRole[],
    };
    next();
  };
  registerMetaStatusRoute(app, {
    authenticate,
    authorizeAdmin: requireLmsRole("admin"),
    environment: () => environment,
    readSchema: async () => ({
      consent: true,
      touchpoints: true,
      lead_links: true,
      capi_outbox: true,
    }),
    readOutboxCounts: async () => [{ state: "pending", count: 2 }],
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input, init) => {
    requestedUrls.push(input instanceof Request ? input.url : String(input));
    return originalFetch(input, init);
  };
  const logLines: string[] = [];
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const captureLog = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
  console.log = captureLog;
  console.info = captureLog;
  console.warn = captureLog;
  console.error = captureLog;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/meta/status`, {
      cache: "no-store",
    });
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.json() as Record<string, unknown>,
      requestedUrls,
      logLines,
    };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

const testCases: Array<{
  name: string;
  configuredValue?: string;
  configured: boolean;
  count: number;
  status: "missing" | "empty" | "invalid" | "configured";
}> = [
  { name: "absent allowlist", configured: false, count: 0, status: "missing" },
  { name: "empty allowlist", configuredValue: "  ", configured: false, count: 0, status: "empty" },
  { name: "valid allowlist", configuredValue: `${formIdOne}, ${formIdTwo}`, configured: true, count: 2, status: "configured" },
  { name: "malformed allowlist", configuredValue: `${formIdOne},not-numeric`, configured: false, count: 0, status: "invalid" },
];

for (const testCase of testCases) {
  test(`admin Meta status reports only safe allowlist metadata for ${testCase.name}`, async () => {
    const environment = {
      NODE_ENV: "test",
      META_ALLOWED_FORM_IDS: testCase.configuredValue,
      META_APP_SECRET: secretMarker,
      META_PAGE_ACCESS_TOKEN: tokenMarker,
    } as NodeJS.ProcessEnv;
    const result = await readMetaStatus(environment);

    assert.equal(result.status, 200);
    assert.equal(result.cacheControl, "private, no-store");
    assert.equal(result.body.approvedFormAllowlistConfigured, testCase.configured);
    assert.equal(result.body.approvedFormAllowlistStatus, testCase.status);
    assert.equal(result.body.approvedFormCount, testCase.count);
    assert.ok(result.requestedUrls.every((url) => url.startsWith("http://127.0.0.1:")));

    const responseText = JSON.stringify(result.body);
    const loggedText = result.logLines.join("\n");
    for (const forbidden of [formIdOne, formIdTwo, secretMarker, tokenMarker]) {
      assert.equal(responseText.includes(forbidden), false);
      assert.equal(loggedText.includes(forbidden), false);
    }
  });
}
