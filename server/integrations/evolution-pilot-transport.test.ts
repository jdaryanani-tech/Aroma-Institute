import assert from "node:assert/strict";
import test from "node:test";
import {
  AVNI_PILOT_MESSAGE,
  createEvolutionPilotTransport,
  type EvolutionPilotClient,
} from "./evolution-pilot-transport";

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
    recipientE164: "+919876543210",
    text: AVNI_PILOT_MESSAGE,
    idempotencyKey: "pilot-test-7",
  }), { state: "failed", code: "definite_rejection" });
});
