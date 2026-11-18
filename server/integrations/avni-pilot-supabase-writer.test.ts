import assert from "node:assert/strict";
import test from "node:test";
import {
  AvniPilotSupabaseWriter,
  type AvniPilotSupabaseClient,
} from "./avni-pilot-supabase-writer";

const ids = {
  lead: "20000000-0000-4000-8000-000000000001",
  thread: "30000000-0000-4000-8000-000000000001",
  outbox: "40000000-0000-4000-8000-000000000001",
  message: "50000000-0000-4000-8000-000000000001",
  attempt: "60000000-0000-4000-8000-000000000001",
  lease: "70000000-0000-4000-8000-000000000001",
};

function fakeWriter(responses: Record<string, Record<string, unknown>[]>) {
  const calls: { channel: string; sql: string; values: unknown[] }[] = [];
  let releases = 0;
  const client: AvniPilotSupabaseClient = {
    async query(sql, values = []) {
      calls.push({ channel: "writer", sql, values });
      const key = sql.match(/aichm_private\.([a-z_]+)\(/)?.[1] ?? "unknown";
      return { rows: responses[key] ?? [] };
    },
    release() { releases += 1; },
  };
  const pool = { async connect() { return client; } };
  const reader = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ channel: "reader", sql, values });
      const key = sql.match(/aichm_private\.([a-z_]+)\(/)?.[1] ?? "unknown";
      return { rows: responses[key] ?? [] };
    },
  };
  return {
    adapter: new AvniPilotSupabaseWriter(pool, reader),
    calls,
    get releases() { return releases; },
  };
}

test("pilot preflight uses the separate reader and returns internal thread routing only server-side", async () => {
  const runtime = fakeWriter({
    read_human_pilot_thread: [{
      outcome: "preflight_ready", thread_id: ids.thread, provider: "whatsapp",
      mode: "human", lifecycle: "open", control_version: "2",
    }],
  });
  const result = await runtime.adapter.preflight(ids.lead, 2);
  assert.deepEqual(result, {
    outcome: "preflight_ready",
    threadId: ids.thread,
    provider: "whatsapp",
    mode: "human",
    lifecycle: "open",
    controlVersion: 2,
  });
  assert.equal(runtime.calls[0].channel, "reader");
  assert.deepEqual(runtime.calls[0].values, [ids.lead, 2]);
  assert.equal(runtime.releases, 0);
});

test("pilot writer uses only fixed parameterized RPCs and HMAC references", async () => {
  const key = `message:v1:${"a".repeat(64)}`;
  const alias = `hmac-sha256:v2:test-a:${"b".repeat(64)}`;
  const runtime = fakeWriter({
    find_human_pilot_outbound: [{
      outbox_id: ids.outbox, message_id: ids.message, thread_id: ids.thread,
      state: "pending", control_version: "2", attempt_number: 0,
    }],
    enqueue_conversation_message: [{
      outcome: "queued", outbox_id: ids.outbox, message_id: ids.message, control_version: "2",
    }],
    claim_human_pilot_outbound: [{
      outbox_id: ids.outbox, message_id: ids.message, thread_id: ids.thread,
      attempt_id: ids.attempt, lease_token: ids.lease, control_version: "2",
      attempt_number: 1, lease_expires_at: new Date("2026-11-18T12:00:00Z"),
    }],
    begin_human_pilot_send: [{ begin_human_pilot_send: "begun" }],
    record_human_pilot_send_result: [{ outcome: "sent" }],
  });
  assert.equal((await runtime.adapter.findByIdempotencyKey(key))?.state, "pending");
  const queued = await runtime.adapter.enqueueHumanMessage({
    threadId: ids.thread,
    expectedControlVersion: 2,
    actorRef: "replit_lms_user:7",
    idempotencyKey: key,
    messageFingerprint: "c".repeat(64),
    text: "synthetic only",
  });
  assert.deepEqual(queued, {
    outcome: "queued", outboxId: ids.outbox, messageId: ids.message, threadId: ids.thread,
  });
  const claim = await runtime.adapter.claimHumanOutbox(ids.outbox);
  assert.equal(claim?.attemptId, ids.attempt);
  assert.equal(await runtime.adapter.beginHumanSend({
    claim: claim!,
    expectedControlVersion: 2,
    actorRef: "replit_lms_user:7",
    payloadHash: "c".repeat(64),
  }), "begun");
  assert.equal(await runtime.adapter.recordResult({
    claim: claim!,
    result: "sent",
    providerReferenceAliases: [alias],
  }), "sent");
  assert.equal(runtime.releases, 5);
  const writerCalls = runtime.calls.filter(call => call.channel === "writer");
  assert.equal(writerCalls.length, 5);
  assert.ok(writerCalls.every(call => call.sql.startsWith("SELECT")));
  assert.ok(writerCalls.every(call => call.values.length > 0));
  assert.ok(writerCalls.some(call =>
    call.values.some(value => Array.isArray(value) && value.includes(alias)),
  ));
  assert.ok(writerCalls.every(call => !call.sql.includes("SELECT * FROM aichm_private.conversation_")));
});

test("invalid idempotency, actor and outbox identifiers are rejected before a query", async () => {
  const runtime = fakeWriter({});
  await assert.rejects(
    runtime.adapter.findByIdempotencyKey("message:v1:raw"),
    /AVNI_PILOT_IDEMPOTENCY_INVALID/,
  );
  const denied = await runtime.adapter.enqueueHumanMessage({
    threadId: ids.thread,
    expectedControlVersion: 2,
    actorRef: "replit_lms_user:7" as `replit_lms_user:${number}`,
    idempotencyKey: `message:v1:${"a".repeat(64)}`,
    messageFingerprint: "b".repeat(64),
    text: "x".repeat(1001),
  });
  assert.equal(denied.outcome, "denied");
  await assert.rejects(runtime.adapter.claimHumanOutbox("not-a-uuid"), /AVNI_PILOT_CLAIM_INPUT_INVALID/);
  assert.equal(runtime.calls.length, 0);
});
