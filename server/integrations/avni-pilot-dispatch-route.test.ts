import assert from "node:assert/strict";
import test from "node:test";
import express, { type RequestHandler } from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  AVNI_PILOT_DISPATCH_ROUTE,
  registerAvniPilotDispatchRoute,
} from "./avni-pilot-dispatch-route";

async function withRoute(
  options: {
    enabled?: boolean;
    authenticated?: boolean;
    admin?: boolean;
    approvedRecipientE164?: string | null;
    dispatch?: Parameters<typeof registerAvniPilotDispatchRoute>[1]["dispatch"];
  },
  run: (url: string, log: string[]) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  const authenticate: RequestHandler = (req, res, next) => {
    if (!options.authenticated) return void res.status(401).json({ code: "authentication_required" });
    req.session = { lmsUserId: 7 } as never;
    req.lmsUser = { id: 7, phoneE164: "redacted", displayName: null, roles: ["admin"] };
    next();
  };
  const authorizeAdmin: RequestHandler = (_req, res, next) => {
    if (!options.admin) return void res.status(403).json({ code: "admin_required" });
    next();
  };
  const log: string[] = [];
  registerAvniPilotDispatchRoute(app, {
    authenticate,
    authorizeAdmin,
    enabled: options.enabled ?? false,
    approvedRecipientE164: options.approvedRecipientE164 ?? "+919876543210",
    dispatch: options.dispatch ?? null,
    log: entry => log.push(JSON.stringify(entry)),
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}${AVNI_PILOT_DISPATCH_ROUTE}`, log);
  } finally {
    server.close();
    await once(server, "close");
  }
}

const validBody = {
  canonicalLeadId: "20000000-0000-4000-8000-000000000001",
  recipientE164: "+919876543210",
  expectedControlVersion: 2,
};

test("pilot route requires authenticated admin and same-origin browser write", async () => {
  await withRoute({ authenticated: false, admin: false }, async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 401);
  });
  await withRoute({ authenticated: true, admin: false }, async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 403);
  });
  await withRoute({ authenticated: true, admin: true }, async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        origin: new URL(url).origin,
        host: new URL(url).host,
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "dispatch_disabled");
  });
});

test("pilot route requires a stable idempotency key and strict request shape", async () => {
  await withRoute({ authenticated: true, admin: true, enabled: true, dispatch: async () => ({
    status: "accepted",
    safeCode: "provider_accepted",
  }) }, async (url) => {
    const origin = new URL(url).origin;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: new URL(url).host },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_request");
  });
  await withRoute({ authenticated: true, admin: true, enabled: true, dispatch: async () => ({
    status: "accepted",
    safeCode: "provider_accepted",
  }) }, async (url) => {
    const origin = new URL(url).origin;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        origin,
        host: new URL(url).host,
      },
      body: JSON.stringify({ ...validBody, text: "caller-controlled content" }),
    });
    assert.equal(response.status, 400);
  });
});

test("pilot route never returns or logs recipient, message, or request payload", async () => {
  const logs: string[] = [];
  await withRoute({
    authenticated: true,
    admin: true,
    enabled: true,
    approvedRecipientE164: "+919876543210",
    dispatch: async (_req, input) => {
      assert.equal(input.recipientE164, validBody.recipientE164);
      return { status: "unknown", safeCode: "provider_outcome_unknown" };
    },
  }, async (url, emitted) => {
    const origin = new URL(url).origin;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        origin,
        host: new URL(url).host,
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    logs.push(...emitted);
    assert.doesNotMatch(body + logs.join("\n"), /\+919876543210|Jigar|Welcome|caller-controlled/);
    assert.match(body, /provider_outcome_unknown/);
  });
});
