import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  conversationEventFingerprint,
  conversationEventIdempotencyKey,
  conversationMessageFingerprint,
  conversationMessageIdempotencyKey,
  validateAvniConversationEvent,
  type AvniConversationEvent,
} from "../integrations/avni-conversation-contract";
import { assertAvniConversationRuntimePostconditions } from "./supabase-avni-conversation-runtime-postconditions";

type ScratchProof = {
  version: 1;
  instanceId: string;
  databaseName: string;
  port: number;
  dataDirectory: string;
  systemIdentifier: string;
  postmasterPid: number;
};

const databaseUrl = process.env.AICHM_DEVELOPMENT_DATABASE_URL;
const enabled = process.env.NODE_ENV === "test" &&
  process.env.CRM_TEST_DB_WRITE_APPROVED === "ISOLATED_EPHEMERAL_POSTGRES_ONLY" &&
  process.env.AICHM_SCHEMA_CHANGE_INTENT === "disposable-test" &&
  Boolean(databaseUrl && process.env.CRM_TEST_EPHEMERAL_PROOF);
let pool: Pool | undefined;
let legacyHistoryAfter: unknown[] = [];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requireHarness(): asserts pool {
  if (!pool) throw new Error("AVNI_TEST_EPHEMERAL_DATABASE_NOT_READY");
}

async function queryRows<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  requireHarness();
  const result = await pool!.query<T>(sql, values);
  return result.rows;
}

async function asRuntime<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  requireHarness();
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE aichm_conversation_runtime");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verifyIsolatedTarget(): Promise<void> {
  if (!databaseUrl || !process.env.CRM_TEST_EPHEMERAL_PROOF) {
    throw new Error("AVNI_TEST_EPHEMERAL_PROOF_MISSING");
  }
  const proof = JSON.parse(await readFile(process.env.CRM_TEST_EPHEMERAL_PROOF, "utf8")) as ScratchProof;
  const parsed = new URL(databaseUrl);
  if (
    proof.version !== 1 ||
    !/^aichm_test_[a-f0-9]{32}$/.test(proof.databaseName) ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== String(proof.port) ||
    parsed.pathname.slice(1) !== proof.databaseName ||
    process.env.CRM_TEST_DATABASE_NAME !== proof.databaseName
  ) throw new Error("AVNI_TEST_TARGET_NOT_ISOLATED");

  pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 });
  const { rows } = await pool.query<{
    database_name: string;
    host: string | null;
    port: number;
    data_directory: string;
    postmaster_pid: number;
    system_identifier: string;
    in_recovery: boolean;
  }>(`
    SELECT current_database() AS database_name,inet_server_addr()::text AS host,
      current_setting('port')::int AS port,current_setting('data_directory') AS data_directory,
      split_part(pg_read_file(current_setting('data_directory')||'/postmaster.pid'),E'\n',1)::int AS postmaster_pid,
      (pg_control_system()).system_identifier::text AS system_identifier,
      pg_is_in_recovery() AS in_recovery
  `);
  const identity = rows[0];
  assert.equal(identity.database_name, proof.databaseName);
  assert.equal(identity.host, "127.0.0.1/32");
  assert.equal(identity.port, proof.port);
  assert.equal(path.resolve(identity.data_directory), path.resolve(proof.dataDirectory));
  assert.equal(identity.postmaster_pid, proof.postmasterPid);
  assert.equal(identity.system_identifier, proof.systemIdentifier);
  assert.equal(identity.in_recovery, false);
}

async function installSyntheticPrerequisitesAndMigration(): Promise<void> {
  requireHarness();
  await pool!.query(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $roles$;
    CREATE TABLE public.leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      replit_lead_id uuid
    );
    CREATE TABLE public.conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES public.leads(id),
      direction text,
      message_type text,
      message text,
      ai_response text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const baseline = await readFile("supabase/migrations/20261107_aichm_two_database_contract.sql", "utf8");
  await pool!.query(baseline);

  const leadId = "10000000-0000-4000-8000-000000000001";
  const replitLeadId = "20000000-0000-4000-8000-000000000001";
  const legacyConversationId = "30000000-0000-4000-8000-000000000001";
  await pool!.query(
    "INSERT INTO public.leads(id,replit_lead_id) VALUES ($1,$2)",
    [leadId, replitLeadId],
  );
  await pool!.query(
    `INSERT INTO public.conversations(id,lead_id,direction,message_type,message,created_at)
     VALUES ($1,$2,'inbound','text','synthetic legacy history','2026-11-18T08:00:00Z')`,
    [legacyConversationId, leadId],
  );
  const before = await pool!.query(
    `SELECT * FROM aichm_private.aichm_crm_conversations_for_replit_lead($1::uuid)`,
    [replitLeadId],
  );

  const migration = await readFile("supabase/migrations/20261118_avni_conversation_runtime_v1.sql", "utf8");
  await pool!.query(migration);
  const afterMigration = await pool!.query(
    `SELECT * FROM aichm_private.aichm_crm_conversations_for_replit_lead($1::uuid)`,
    [replitLeadId],
  );
  assert.deepEqual(afterMigration.rows, before.rows, "the legacy CRM history RPC result must not change");
  legacyHistoryAfter = afterMigration.rows;
  const client = await pool!.connect();
  try {
    await assertAvniConversationRuntimePostconditions(client);
  } finally {
    client.release();
  }
}

before(async () => {
  if (!enabled) return;
  await verifyIsolatedTarget();
  await installSyntheticPrerequisitesAndMigration();
});

after(async () => {
  await pool?.end();
});

function makeMessageEvent(overrides: Partial<Extract<AvniConversationEvent, { kind: "message" }>> = {}) {
  const event = {
    contractVersion: 1,
    provider: "whatsapp",
    providerEventRef: `event-${randomUUID()}`,
    threadRef: `synthetic-thread-${randomUUID()}`,
    occurredAt: new Date("2026-11-18T08:00:00.000Z").toISOString(),
    kind: "message",
    providerMessageRef: `provider-message-${randomUUID()}`,
    direction: "inbound",
    author: "prospect",
    messageType: "text",
    text: "synthetic message",
    ...overrides,
  } as const;
  const validation = validateAvniConversationEvent(event);
  if (!validation.success || validation.event.kind !== "message") {
    throw new Error("AVNI_TEST_SYNTHETIC_EVENT_INVALID");
  }
  return validation.event;
}

async function acceptMessage(event: Extract<AvniConversationEvent, { kind: "message" }>) {
  const threadHash = sha256(event.threadRef);
  const params = [
    event.provider, event.providerEventRef, threadHash,
    conversationEventIdempotencyKey(event), conversationEventFingerprint(event),
    event.occurredAt, "message", event.providerMessageRef,
    conversationMessageIdempotencyKey(event), conversationMessageFingerprint(event),
    event.direction, event.author, event.messageType, event.text ?? null,
    event.mediaRef ?? null, null, null,
  ];
  return asRuntime(async client => {
    const { rows } = await client.query(
      `SELECT * FROM aichm_private.accept_provider_event(
        $1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
      )`,
      params,
    );
    return { ...rows[0], threadHash, event };
  });
}

async function createReadyThread() {
  const accepted = await acceptMessage(makeMessageEvent());
  const supabaseLeadId = randomUUID();
  await pool!.query(
    "INSERT INTO public.leads(id,replit_lead_id) VALUES ($1,$2)",
    [supabaseLeadId, randomUUID()],
  );
  const mapped = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.link_conversation_thread($1,$2,0,'replit_lms_user:42',$3,'synthetic identity review')`,
    [accepted.thread_id, supabaseLeadId, randomUUID()],
  ));
  assert.equal(mapped.rows[0].outcome, "linked");
  const resumed = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,1,'resume','replit_lms_user:42',$2,'synthetic approved resume',true,false
    )`,
    [accepted.thread_id, randomUUID()],
  ));
  assert.equal(resumed.rows[0].outcome, "changed");
  return {
    threadId: accepted.thread_id as string,
    threadHash: accepted.threadHash as string,
    threadRef: accepted.event.threadRef,
  };
}

async function enqueueAssistant(threadId: string, version = 2) {
  const messageRef = `queued-${randomUUID()}`;
  const event = makeMessageEvent({
    providerMessageRef: messageRef,
    direction: "outbound",
    author: "assistant",
    text: "synthetic assistant reply",
  });
  const idempotencyKey = conversationMessageIdempotencyKey(event);
  const fingerprint = sha256(JSON.stringify([
    event.provider, event.threadRef, event.occurredAt, "assistant", "text", event.text,
  ]));
  return asRuntime(client => client.query(
    `SELECT * FROM aichm_private.enqueue_conversation_message(
      $1,$2,'assistant',NULL,$3,$4,'text',$5,NULL,true
    )`,
    [threadId, version, idempotencyKey, fingerprint, event.text],
  ));
}

async function claimAndAuthorize(outboxId: string) {
  const claim = await asRuntime(client => client.query(
    "SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)",
  ));
  const row = claim.rows.find(candidate => candidate.outbox_id === outboxId);
  assert.ok(row, "the expected synthetic outbound row should be claimed");
  const authorized = await asRuntime(client => client.query(
    "SELECT aichm_private.authorize_conversation_outbound_attempt($1,$2,$3,true) AS allowed",
    [outboxId, row.attempt_id, row.lease_token],
  ));
  return { ...row, allowed: authorized.rows[0].allowed as boolean };
}

test("ephemeral PostgreSQL preparation proves private RPC boundary and legacy history remains unchanged", {
  skip: !enabled,
}, async () => {
  requireHarness();
  assert.equal(legacyHistoryAfter.length, 1);
  assert.equal((legacyHistoryAfter[0] as { body: string }).body, "synthetic legacy history");
  await assertAvniConversationRuntimePostconditions(await pool!.connect());

  const directRead = await pool!.connect();
  try {
    await directRead.query("BEGIN");
    await directRead.query("SET LOCAL ROLE aichm_conversation_runtime");
    await directRead.query("SAVEPOINT privilege_check");
    await assert.rejects(directRead.query("SELECT * FROM aichm_private.conversation_threads"));
    await directRead.query("ROLLBACK TO SAVEPOINT privilege_check");
    await assert.rejects(directRead.query(
      `INSERT INTO aichm_private.conversation_threads(provider,provider_thread_hash)
       VALUES ('whatsapp',$1)`, [sha256("direct-write-denied")],
    ));
    await directRead.query("ROLLBACK TO SAVEPOINT privilege_check");
    await directRead.query("ROLLBACK");
  } finally {
    directRead.release();
  }
});

test("provider events are idempotent, changed replays conflict, and unmapped threads cannot queue", {
  skip: !enabled,
}, async () => {
  const event = makeMessageEvent();
  const first = await acceptMessage(event);
  const duplicate = await acceptMessage(event);
  assert.equal(first.outcome, "accepted");
  assert.equal(duplicate.outcome, "duplicate_event");
  assert.equal(first.message_id, duplicate.message_id);

  const wrapper = makeMessageEvent({
    providerMessageRef: event.providerMessageRef,
    threadRef: event.threadRef,
    text: event.text,
  });
  const secondWrapper = await acceptMessage(wrapper);
  assert.equal(secondWrapper.outcome, "accepted");
  const messageCount = await queryRows<{ count: string }>(
    "SELECT count(*)::text AS count FROM aichm_private.conversation_messages WHERE provider_message_ref=$1",
    [event.providerMessageRef],
  );
  assert.equal(Number(messageCount[0].count), 1);

  const conflicting = makeMessageEvent({ ...event, text: "different synthetic body" });
  await assert.rejects(acceptMessage(conflicting), /conversation_event_idempotency_conflict/);
  const notMapped = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.enqueue_conversation_message(
      $1,0,'assistant',NULL,$2,$3,'text','safe synthetic reply',NULL,true
    )`,
    [first.thread_id, `message:v1:${"a".repeat(64)}`, "b".repeat(64)],
  ));
  assert.equal(notMapped.rows[0].outcome, "thread_mapping_unavailable");
});

test("resume uses consent and opt-out gates, and only a versioned staff action changes ownership", {
  skip: !enabled,
}, async () => {
  const { threadId } = await createReadyThread();
  const takeover = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,2,'takeover','replit_lms_user:42',$2,'synthetic takeover',false,true
    )`,
    [threadId, randomUUID()],
  ));
  assert.equal(takeover.rows[0].outcome, "changed");
  const noConsent = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,3,'resume','replit_lms_user:42',$2,'synthetic consent missing',false,false
    )`,
    [threadId, randomUUID()],
  ));
  assert.equal(noConsent.rows[0].outcome, "whatsapp_consent_not_granted");
  const optOut = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,3,'resume','replit_lms_user:42',$2,'synthetic opt out',true,true
    )`,
    [threadId, randomUUID()],
  ));
  assert.equal(optOut.rows[0].outcome, "whatsapp_opted_out");
  const stale = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,2,'resume','replit_lms_user:42',$2,'synthetic stale version',true,false
    )`,
    [threadId, randomUUID()],
  ));
  assert.equal(stale.rows[0].outcome, "version_conflict");
  const allowed = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,3,'resume','replit_lms_user:42',$2,'synthetic consent approved',true,false
    )`,
    [threadId, randomUUID()],
  ));
  assert.equal(allowed.rows[0].outcome, "changed");
  assert.equal(allowed.rows[0].control_version, "4");
});

test("takeover wins atomically against a claimed AI send and invalidates stale queue work", {
  skip: !enabled,
}, async () => {
  const { threadId } = await createReadyThread();
  const queued = await enqueueAssistant(threadId);
  assert.equal(queued.rows[0].outcome, "queued");
  const claimant = await pool!.connect();
  const taker = await pool!.connect();
  try {
    await claimant.query("BEGIN");
    await claimant.query("SET LOCAL ROLE aichm_conversation_runtime");
    const claim = await claimant.query("SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)");
    const item = claim.rows.find(row => row.outbox_id === queued.rows[0].outbox_id);
    assert.ok(item);

    await taker.query("SET ROLE aichm_conversation_runtime");
    let takeoverFinished = false;
    const takeoverPromise = taker.query(
      `SELECT * FROM aichm_private.transition_conversation_control(
        $1,2,'takeover','replit_lms_user:42',$2,'synthetic concurrent takeover',false,true
      )`,
      [threadId, randomUUID()],
    ).then(result => { takeoverFinished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(takeoverFinished, false, "takeover waits while claim holds the thread lock");
    await claimant.query("COMMIT");
    const takeover = await takeoverPromise;
    assert.equal(takeover.rows[0].outcome, "changed");

    const authorize = await asRuntime(client => client.query(
      "SELECT aichm_private.authorize_conversation_outbound_attempt($1,$2,$3,true) AS allowed",
      [queued.rows[0].outbox_id, item.attempt_id, item.lease_token],
    ));
    assert.equal(authorize.rows[0].allowed, false);
    const state = await queryRows<{ state: string; attempt_count: number }>(
      "SELECT state,attempt_count FROM aichm_private.conversation_outbox WHERE id=$1",
      [queued.rows[0].outbox_id],
    );
    assert.equal(state[0].state, "cancelled");
    assert.equal(state[0].attempt_count, 1);
  } finally {
    try { await claimant.query("ROLLBACK"); } catch {}
    try { await taker.query("RESET ROLE"); } catch {}
    claimant.release();
    taker.release();
  }
});

test("claim skips a thread locked by takeover, and expired claim leases are bounded retries", {
  skip: !enabled,
}, async () => {
  const { threadId } = await createReadyThread();
  const queued = await enqueueAssistant(threadId);
  const owner = await pool!.connect();
  const claimer = await pool!.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE aichm_conversation_runtime");
    const takeover = await owner.query(
      `SELECT * FROM aichm_private.transition_conversation_control(
        $1,2,'takeover','replit_lms_user:42',$2,'synthetic lock winner',false,true
      )`,
      [threadId, randomUUID()],
    );
    assert.equal(takeover.rows[0].outcome, "changed");
    await claimer.query("SET ROLE aichm_conversation_runtime");
    const skipped = await claimer.query("SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)");
    assert.equal(skipped.rows.length, 0);
    await owner.query("COMMIT");
    const outbox = await queryRows<{ state: string }>(
      "SELECT state FROM aichm_private.conversation_outbox WHERE id=$1",
      [queued.rows[0].outbox_id],
    );
    assert.equal(outbox[0].state, "cancelled");
  } finally {
    try { await owner.query("ROLLBACK"); } catch {}
    try { await claimer.query("RESET ROLE"); } catch {}
    owner.release();
    claimer.release();
  }

  const { threadId: retryThread } = await createReadyThread();
  const retryQueue = await enqueueAssistant(retryThread);
  const firstClaim = await asRuntime(client => client.query(
    "SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)",
  ));
  const attempt = firstClaim.rows.find(row => row.outbox_id === retryQueue.rows[0].outbox_id);
  assert.ok(attempt);
  await pool!.query(
    `UPDATE aichm_private.conversation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1;
     UPDATE aichm_private.conversation_outbox_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$2`,
    [retryQueue.rows[0].outbox_id, attempt.attempt_id],
  );
  const secondClaim = await asRuntime(client => client.query(
    "SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)",
  ));
  const retried = secondClaim.rows.find(row => row.outbox_id === retryQueue.rows[0].outbox_id);
  assert.ok(retried);
  const count = await queryRows<{ attempt_count: number }>(
    "SELECT attempt_count FROM aichm_private.conversation_outbox WHERE id=$1",
    [retryQueue.rows[0].outbox_id],
  );
  assert.equal(count[0].attempt_count, 2);
});

test("delivery receipts retain raw provider labels and ignore regressions", {
  skip: !enabled,
}, async () => {
  const { threadId, threadRef } = await createReadyThread();
  const queued = await enqueueAssistant(threadId);
  const send = await claimAndAuthorize(queued.rows[0].outbox_id);
  assert.equal(send.allowed, true);
  const providerMessageRef = `sent-${randomUUID()}`;
  const sent = await asRuntime(client => client.query(
    "SELECT aichm_private.record_conversation_send_result($1,$2,$3,'sent',$4) AS result",
    [queued.rows[0].outbox_id, send.attempt_id, send.lease_token, providerMessageRef],
  ));
  assert.equal(sent.rows[0].result, "sent");
  const attempt = await queryRows<{ id: string }>(
    "SELECT id FROM aichm_private.conversation_outbox_attempts WHERE outbox_id=$1",
    [queued.rows[0].outbox_id],
  );
  assert.equal(attempt.length, 1);

  async function receipt(state: string, raw: string) {
    const candidate = {
      contractVersion: 1,
      provider: "whatsapp",
      providerEventRef: `receipt-${randomUUID()}`,
      threadRef,
      occurredAt: new Date().toISOString(),
      kind: "delivery",
      providerMessageRef,
      deliveryState: state,
      rawProviderReceiptValue: raw,
    };
    const parsed = validateAvniConversationEvent(candidate);
    if (!parsed.success || parsed.event.kind !== "delivery") throw new Error("AVNI_TEST_RECEIPT_INVALID");
    const event = parsed.event;
    return asRuntime(client => client.query(
      `SELECT * FROM aichm_private.accept_provider_event(
        $1,$2,$3,$4,$5,$6::timestamptz,$7,$8,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$9,$10
      )`,
      [
        event.provider, event.providerEventRef, sha256(event.threadRef),
        conversationEventIdempotencyKey(event), conversationEventFingerprint(event),
        event.occurredAt, event.kind, event.providerMessageRef, event.deliveryState,
        event.rawProviderReceiptValue,
      ],
    ));
  }
  assert.equal((await receipt("delivered", "ProviderDelivered")).rows[0].outcome, "receipt_recorded");
  await receipt("unknown", "ProviderUnknownLate");
  await receipt("sent", "ProviderSentLate");
  await receipt("read", "ProviderRead");
  await receipt("delivered", "ProviderDeliveredLate");
  const states = await queryRows<{
    delivery_state: string;
    receipt_count: string;
    has_raw: boolean;
  }>(`
    SELECT a.delivery_state,count(r.id)::text AS receipt_count,
      bool_or(r.raw_provider_state='ProviderDelivered') AS has_raw
    FROM aichm_private.conversation_outbox_attempts a
    LEFT JOIN aichm_private.conversation_delivery_receipts r ON r.attempt_id=a.id
    WHERE a.id=$1 GROUP BY a.delivery_state
  `, [attempt[0].id]);
  assert.equal(states[0].delivery_state, "read");
  assert.equal(Number(states[0].receipt_count), 5);
  assert.equal(states[0].has_raw, true);
  const message = await queryRows<{ delivery_state: string }>(
    "SELECT delivery_state FROM aichm_private.conversation_messages WHERE id=$1",
    [queued.rows[0].message_id],
  );
  assert.equal(message[0].delivery_state, "read");
});

test("provider acceptance is recorded as sent, not delivered, and takeover cannot recall it", {
  skip: !enabled,
}, async () => {
  const { threadId } = await createReadyThread();
  const queued = await enqueueAssistant(threadId);
  const send = await claimAndAuthorize(queued.rows[0].outbox_id);
  const providerAcceptedRef = `accepted-${randomUUID()}`;
  await asRuntime(client => client.query(
    "SELECT aichm_private.record_conversation_send_result($1,$2,$3,'sent',$4)",
    [queued.rows[0].outbox_id, send.attempt_id, send.lease_token, providerAcceptedRef],
  ));
  const state = await queryRows<{ outbox_state: string; delivery_state: string }>(`
    SELECT o.state AS outbox_state,m.delivery_state
    FROM aichm_private.conversation_outbox o
    JOIN aichm_private.conversation_messages m ON m.id=o.message_id WHERE o.id=$1
  `, [queued.rows[0].outbox_id]);
  assert.deepEqual(state[0], { outbox_state: "accepted", delivery_state: "sent" });

  const takeover = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,2,'takeover','replit_lms_user:42',$2,'synthetic after provider acceptance',false,true
    )`,
    [threadId, randomUUID()],
  ));
  assert.equal(takeover.rows[0].outcome, "changed");
  const remainsAccepted = await queryRows<{ state: string }>(
    "SELECT state FROM aichm_private.conversation_outbox WHERE id=$1",
    [queued.rows[0].outbox_id],
  );
  assert.equal(remainsAccepted[0].state, "accepted");
});
