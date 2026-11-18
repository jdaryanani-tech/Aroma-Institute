import assert from "node:assert/strict";
import test from "node:test";
import {
  AVNI_PILOT_MESSAGE,
  createEvolutionPilotHttpClient,
  createEvolutionPilotTransport,
  EVOLUTION_API_BASE_URL,
  type EvolutionPilotClient,
} from "./evolution-pilot-transport";

const syntheticRecipient = "+19995550123";

test("Evolution pilot transport validates a strict E.164 recipient and returns accepted", async () => {
  const calls: unknown[] = [];
  const client: EvolutionPilotClient = {
    async sendText(input) {
      calls.push(input);
      return { state: "accepted", providerMessageId: "synthetic-provider-id" };
    },
  };
  const result = await createEvolutionPilotTransport(client).sendText({
    recipientE164: "+919876543210",
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-1",
  });
  assert.deepEqual(result, { state: "accepted", providerMessageId: "synthetic-provider-id" });
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { text: string }).text, AVNI_PILOT_MESSAGE);
});

test("invalid recipients and changed message text are rejected before transport", async () => {
  let calls = 0;
  const client: EvolutionPilotClient = {
    async sendText() {
      calls += 1;
      return { state: "accepted", providerMessageId: "synthetic-id" };
    },
  };
  const transport = createEvolutionPilotTransport(client);
  assert.deepEqual(await transport.sendText({
    recipientE164: "919876543210",
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-2",
  }), { state: "failed", code: "definite_rejection" });
  assert.deepEqual(await transport.sendText({
    recipientE164: "+919876543210",
    text: "different text" as typeof AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-3",
  }), { state: "failed", code: "definite_rejection" });
  assert.equal(calls, 0);
});

test("missing transport fails closed without a provider call", async () => {
  assert.deepEqual(await createEvolutionPilotTransport(null).sendText({
    recipientE164: "+919876543210",
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-4",
  }), { state: "unavailable", code: "transport_not_configured" });
});

test("ambiguous outcomes and timeouts are unknown, never definite failure", async () => {
  const ambiguous = createEvolutionPilotTransport({
    async sendText() { return { state: "unknown" }; },
  });
  assert.deepEqual(await ambiguous.sendText({
    recipientE164: "+919876543210",
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-5",
  }), { state: "unknown", code: "transport_error" });

  const timeout = createEvolutionPilotTransport({
    async sendText() {
      return new Promise(() => undefined);
    },
  }, { timeoutMs: 100 });
  assert.deepEqual(await timeout.sendText({
    recipientE164: "+919876543210",
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-6",
  }), { state: "unknown", code: "timeout" });
});

test("only a deployment client can declare a definite pre-acceptance rejection", async () => {
  const transport = createEvolutionPilotTransport({
    async sendText() { return { state: "failed", code: "definite_rejection" }; },
  });
  assert.deepEqual(await transport.sendText({
    recipientE164: syntheticRecipient,
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-7",
  }), { state: "failed", code: "definite_rejection" });
});

test("HTTP client sends only the fixed Evolution request with server-only apikey auth", async () => {
  let called = false;
  const client = createEvolutionPilotHttpClient({
    apiKey: "synthetic-api-key-not-a-real-credential",
    instanceName: "test_instance-1",
  }, async (input, init) => {
    called = true;
    assert.equal(String(input), `${EVOLUTION_API_BASE_URL}/message/sendText/test_instance-1`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), "synthetic-api-key-not-a-real-credential");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("idempotency-key"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      number: "19995550123",
      text: AVNI_PILOT_MESSAGE,
    });
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ key: { id: "synthetic-provider-message-id" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });
  assert.ok(client);
  assert.equal(called, false, "constructing the client must not make a network request");
  const result = await client.sendText({
    recipientE164: syntheticRecipient,
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "synthetic-idempotency-key",
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { state: "accepted", providerMessageId: "synthetic-provider-message-id" });
  assert.equal(called, true);
});

test("HTTP client fails closed when credentials or instance config are missing or malformed", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response(null, { status: 201 });
  };
  assert.equal(createEvolutionPilotHttpClient({ apiKey: null, instanceName: "test" }, fetchImpl), null);
  assert.equal(createEvolutionPilotHttpClient({ apiKey: "key", instanceName: null }, fetchImpl), null);
  assert.equal(createEvolutionPilotHttpClient({ apiKey: "bad\r\nkey", instanceName: "test" }, fetchImpl), null);
  assert.equal(createEvolutionPilotHttpClient({ apiKey: "key", instanceName: "../other" }, fetchImpl), null);
  assert.equal(calls, 0);
});

test("HTTP client classifies auth rejection as definite and all other HTTP errors as unknown", async () => {
  for (const status of [401, 403]) {
    const client = createEvolutionPilotHttpClient({ apiKey: "synthetic-key", instanceName: "test" },
      async () => new Response("sensitive provider error text", { status }));
    assert.ok(client);
    assert.deepEqual(await client.sendText({
      recipientE164: syntheticRecipient,
      text: AVNI_PILOT_MESSAGE,
      idempotencyKey: "synthetic-idempotency-key",
      signal: new AbortController().signal,
    }), { state: "failed", code: "definite_rejection" });
  }
  for (const status of [302, 400, 404, 429, 500]) {
    let requestInit: RequestInit | undefined;
    const client = createEvolutionPilotHttpClient({ apiKey: "synthetic-key", instanceName: "test" },
      async (_input, init) => {
        requestInit = init;
        return new Response("sensitive provider error text", { status });
      });
    assert.ok(client);
    assert.deepEqual(await client.sendText({
      recipientE164: syntheticRecipient,
      text: AVNI_PILOT_MESSAGE,
      idempotencyKey: "synthetic-idempotency-key",
      signal: new AbortController().signal,
    }), { state: "unknown" });
    assert.equal(requestInit?.redirect, "manual");
  }
});

test("HTTP client treats malformed, oversized, or identifier-free success as unknown without exposing body", async () => {
  const bodies = [
    "not-json",
    JSON.stringify({ message: "sensitive provider response" }),
    JSON.stringify({ key: { id: "bad\nprovider-id" } }),
    "x".repeat(16 * 1024 + 1),
  ];
  for (const body of bodies) {
    const client = createEvolutionPilotHttpClient({ apiKey: "synthetic-key", instanceName: "test" },
      async () => new Response(body, { status: 201 }));
    assert.ok(client);
    const result = await client.sendText({
      recipientE164: syntheticRecipient,
      text: AVNI_PILOT_MESSAGE,
      idempotencyKey: "synthetic-idempotency-key",
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { state: "unknown" });
    assert.doesNotMatch(JSON.stringify(result), /sensitive|provider-id|test/);
  }
});
