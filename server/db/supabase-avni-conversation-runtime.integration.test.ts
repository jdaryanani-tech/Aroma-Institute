import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import {
  assertAvniConversationRuntimePostconditions,
  assertAvniConversationRuntimeReadiness,
} from "./supabase-avni-conversation-runtime-postconditions";

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
let migrationRollbackVerified = false;

// Synthetic opaque token-format fixtures only. These are random strings, not an
// HMAC implementation; the production adapter remains a hard prerequisite.
const syntheticProviderTokens = new Map<string, string>();
function syntheticToken(reference: string): `hmac-sha256:v1:${string}` {
  let token = syntheticProviderTokens.get(reference);
  if (!token) {
    token = `hmac-sha256:v1:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    syntheticProviderTokens.set(reference, token);
  }
  return token as `hmac-sha256:v1:${string}`;
}

function requireHarness(): asserts pool {
  if (!pool) throw new Error("AVNI_TEST_EPHEMERAL_DATABASE_NOT_READY");
}

async function queryRows<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  requireHarness();
  const result = await pool!.query<T>(sql, values);
  return result.rows;
}

async function waitUntilBlockedBy(waitingPid: number, blockingPid: number): Promise<void> {
  requireHarness();
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await pool!.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [waitingPid, blockingPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("AVNI_TEST_EXPECTED_LOCK_WAIT_NOT_OBSERVED");
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
  const failingMigration = migration.replace(
    /\nCOMMIT;\s*$/,
    "\nSELECT 1/0;\nCOMMIT;\n",
  );
  assert.notEqual(failingMigration, migration, "the test must inject a failure before the migration COMMIT");
  const rollbackClient = await pool!.connect();
  try {
    await assert.rejects(rollbackClient.query(failingMigration), /division by zero/i);
    await rollbackClient.query("ROLLBACK");
    const state = await rollbackClient.query<{
      role_count: string;
      table_count: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pg_roles
         WHERE rolname IN ('aichm_conversation_owner','aichm_conversation_runtime')) AS role_count,
        (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='aichm_private' AND c.relname=ANY($1::text[])) AS table_count
    `, [[
      "conversation_threads", "conversation_messages", "conversation_events",
      "conversation_outbox", "conversation_outbox_attempts", "conversation_delivery_receipts",
      "conversation_control_events",
    ]]);
    assert.equal(state.rows[0].role_count, "0");
    assert.equal(state.rows[0].table_count, "0");
    migrationRollbackVerified = true;
  } finally {
    rollbackClient.release();
  }

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

  const reader = await pool!.connect();
  try {
    await reader.query("BEGIN");
    await reader.query("SET LOCAL ROLE aichm_crm_reader");
    const history = await reader.query(
      "SELECT * FROM aichm_private.aichm_crm_conversations_for_replit_lead($1::uuid)",
      ["20000000-0000-4000-8000-000000000001"],
    );
    assert.equal(history.rows.length, 1);
    await reader.query("SAVEPOINT reader_table_access");
    await assert.rejects(reader.query("SELECT * FROM aichm_private.conversation_threads"));
    await reader.query("ROLLBACK TO SAVEPOINT reader_table_access");
    await reader.query("ROLLBACK");
  } finally {
    reader.release();
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

test("injected migration failure rolls back role and table creation atomically", {
  skip: !enabled,
}, () => {
  assert.equal(migrationRollbackVerified, true);
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
  const threadKey = syntheticToken(event.threadRef);
  const eventKey = syntheticToken(event.providerEventRef);
  const messageKey = syntheticToken(event.providerMessageRef);
  const params = [
    event.provider, eventKey, threadKey,
    conversationEventIdempotencyKey(eventKey), conversationEventFingerprint(event),
    event.occurredAt, "message", messageKey,
    conversationMessageIdempotencyKey(messageKey), conversationMessageFingerprint(event),
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
    return { ...rows[0], threadKey, event };
  });
}

async function createReadyThread() {
  const accepted = await acceptMessage(makeMessageEvent());
  const supabaseLeadId = randomUUID();
  await pool!.query(
    "INSERT INTO public.leads(id,replit_lead_id) VALUES ($1,$2)",
    [supabaseLeadId, randomUUID()],
  );
  const linkRequestId = randomUUID();
  const link = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.link_conversation_thread($1,$2,0,'replit_lms_user:42',$3,'synthetic identity review')`,
    [accepted.thread_id, supabaseLeadId, linkRequestId],
  ));
  assert.equal(link.rows[0].outcome, "linked");
  const resumed = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,1,'resume','replit_lms_user:42',$2,'synthetic approved resume',true,false
    )`,
    [accepted.thread_id, randomUUID()],
  ));
  assert.equal(resumed.rows[0].outcome, "changed");
  return {
    threadId: accepted.thread_id as string,
    supabaseLeadId,
    linkRequestId,
    threadKey: accepted.threadKey as string,
    threadRef: accepted.event.threadRef,
  };
}

async function enqueueAssistant(threadId: string, version = 2) {
  const messageRef = `queued-${randomUUID()}`;
  const messageKey = syntheticToken(messageRef);
  const event = makeMessageEvent({
    providerMessageRef: messageRef,
    direction: "outbound",
    author: "assistant",
    text: "synthetic assistant reply",
  });
  const idempotencyKey = conversationMessageIdempotencyKey(messageKey);
  const fingerprint = conversationMessageFingerprint(event);
  const result = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.enqueue_conversation_message(
      $1,$2,'assistant',NULL,$3,$4,'text',$5,NULL,true
    )`,
    [threadId, version, idempotencyKey, fingerprint, event.text],
  ));
  return { ...result, idempotencyKey, fingerprint };
}

async function claimAndAuthorize(outboxId: string) {
  await pool!.query(
    "UPDATE aichm_private.conversation_outbox SET state='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE state='pending' AND id<>$1",
    [outboxId],
  );
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
  const postconditionClient = await pool!.connect();
  try {
    await assertAvniConversationRuntimePostconditions(postconditionClient);
  } finally {
    postconditionClient.release();
  }

  const directRead = await pool!.connect();
  try {
    await directRead.query("BEGIN");
    await directRead.query("SET LOCAL ROLE aichm_conversation_runtime");
    await directRead.query("SAVEPOINT privilege_check");
    await assert.rejects(directRead.query("SELECT * FROM aichm_private.conversation_threads"));
    await directRead.query("ROLLBACK TO SAVEPOINT privilege_check");
    await assert.rejects(directRead.query(
      `INSERT INTO aichm_private.conversation_threads(provider,provider_thread_key)
       VALUES ('whatsapp',$1)`, [syntheticToken("direct-write-denied")],
    ));
    await directRead.query("ROLLBACK TO SAVEPOINT privilege_check");
    await directRead.query("ROLLBACK");
  } finally {
    directRead.release();
  }
});

test("runtime readiness is separate, read-only, and accepts only one constrained approved login", {
  skip: !enabled,
}, async () => {
  requireHarness();
  const client = await pool!.connect();
  const login = "avni_runtime_test_login";
  const broadRole = "avni_runtime_test_broad";
  try {
    await assert.rejects(
      assertAvniConversationRuntimeReadiness(client, "avni_runtime_missing_login"),
      /AVNI_CONVERSATION_RUNTIME_LOGIN_NOT_APPROVED/,
    );
    await client.query(`
      CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
      CREATE ROLE ${broadRole} NOLOGIN;
      GRANT aichm_conversation_runtime TO ${login};
    `);
    await assertAvniConversationRuntimeReadiness(client, login);
    await client.query(`GRANT ${broadRole} TO ${login}`);
    await assert.rejects(
      assertAvniConversationRuntimeReadiness(client, login),
      /AVNI_CONVERSATION_RUNTIME_LOGIN_NOT_APPROVED/,
    );
  } finally {
    await client.query(`REVOKE ${broadRole} FROM ${login}`).catch(() => undefined);
    await client.query(`REVOKE aichm_conversation_runtime FROM ${login}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${broadRole}`).catch(() => undefined);
    client.release();
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
    "SELECT count(*)::text AS count FROM aichm_private.conversation_messages WHERE provider_message_key=$1",
    [syntheticToken(event.providerMessageRef)],
  );
  assert.equal(Number(messageCount[0].count), 1);
  assert.match(first.threadKey as string, /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.notEqual(first.threadKey, event.threadRef);

  const plainDigest = "c".repeat(64);
  await assert.rejects(asRuntime(client => client.query(
    `SELECT * FROM aichm_private.accept_provider_event(
      $1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )`,
    [
      "whatsapp", plainDigest, plainDigest, `event:v1:${plainDigest}`, "d".repeat(64),
      event.occurredAt, "message", syntheticToken("raw-rejected-message"),
      `message:v1:${"e".repeat(64)}`, "f".repeat(64), "inbound", "prospect", "text",
      "synthetic", null, null, null,
    ],
  )), /invalid_conversation_event/);

  const conflicting = makeMessageEvent({ ...event, text: "different synthetic body" });
  await assert.rejects(acceptMessage(conflicting), /conversation_event_idempotency_conflict/);
  const notMapped = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.enqueue_conversation_message(
      $1,0,'assistant',NULL,$2,$3,'text','safe synthetic reply',NULL,true
    )`,
    [first.thread_id, `message:v1:${"a".repeat(64)}`, "b".repeat(64)],
  ));
  assert.equal(notMapped.rows[0].outcome, "thread_mapping_unavailable");

  const externalOutbound = makeMessageEvent({
    direction: "outbound",
    author: "human_staff",
    text: "observed provider-side outbound",
  });
  const outboxBefore = await queryRows<{ count: string }>(
    "SELECT count(*)::text AS count FROM aichm_private.conversation_outbox",
  );
  const observed = await acceptMessage(externalOutbound);
  assert.equal(observed.outcome, "accepted");
  const observedMessage = await queryRows<{ delivery_state: string }>(
    "SELECT delivery_state FROM aichm_private.conversation_messages WHERE id=$1",
    [observed.message_id],
  );
  const outboxAfter = await queryRows<{ count: string }>(
    "SELECT count(*)::text AS count FROM aichm_private.conversation_outbox",
  );
  assert.equal(observedMessage[0].delivery_state, "unknown");
  assert.equal(outboxAfter[0].count, outboxBefore[0].count);

  const ready = await createReadyThread();
  const queued = await enqueueAssistant(ready.threadId);
  const duplicateEnqueue = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.enqueue_conversation_message(
      $1,2,'assistant',NULL,$2,$3,'text','synthetic assistant reply',NULL,true
    )`,
    [ready.threadId, queued.idempotencyKey, queued.fingerprint],
  ));
  assert.equal(duplicateEnqueue.rows[0].outcome, "duplicate");
  assert.equal(duplicateEnqueue.rows[0].outbox_id, queued.rows[0].outbox_id);
  await assert.rejects(asRuntime(client => client.query(
    `SELECT * FROM aichm_private.enqueue_conversation_message(
      $1,2,'assistant',NULL,$2,$3,'text','changed reply',NULL,true
    )`,
    [ready.threadId, queued.idempotencyKey, "f".repeat(64)],
  )), /conversation_outbox_idempotency_conflict/);

  const linkReplay = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.link_conversation_thread($1,$2,0,'replit_lms_user:42',$3,'synthetic identity review')`,
    [ready.threadId, ready.supabaseLeadId, ready.linkRequestId],
  ));
  assert.equal(linkReplay.rows[0].outcome, "duplicate");
  const conflictingLinkReplay = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.link_conversation_thread($1,$2,0,'replit_lms_user:42',$3,'different reason')`,
    [ready.threadId, ready.supabaseLeadId, ready.linkRequestId],
  ));
  assert.equal(conflictingLinkReplay.rows[0].outcome, "request_id_conflict");
});

test("resume uses consent and opt-out gates, and only a versioned staff action changes ownership", {
  skip: !enabled,
}, async () => {
  const { threadId } = await createReadyThread();
  const takeoverRequestId = randomUUID();
  const takeover = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,2,'takeover','replit_lms_user:42',$2,'synthetic takeover',false,true
    )`,
    [threadId, takeoverRequestId],
  ));
  assert.equal(takeover.rows[0].outcome, "changed");
  const takeoverReplay = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,2,'takeover','replit_lms_user:42',$2,'synthetic takeover',false,true
    )`,
    [threadId, takeoverRequestId],
  ));
  assert.equal(takeoverReplay.rows[0].outcome, "duplicate");
  const changedReplay = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.transition_conversation_control(
      $1,2,'takeover','replit_lms_user:42',$2,'different request data',false,true
    )`,
    [threadId, takeoverRequestId],
  ));
  assert.equal(changedReplay.rows[0].outcome, "request_id_conflict");
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
  await pool!.query(
    "UPDATE aichm_private.conversation_outbox SET state='cancelled' WHERE state='pending' AND id<>$1",
    [queued.rows[0].outbox_id],
  );
  assert.equal(queued.rows[0].outcome, "queued");
  const claimant = await pool!.connect();
  const taker = await pool!.connect();
  try {
    await claimant.query("BEGIN");
    await claimant.query("SET LOCAL ROLE aichm_conversation_runtime");
    const claimantPid = (await claimant.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const claim = await claimant.query("SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)");
    const item = claim.rows.find(row => row.outbox_id === queued.rows[0].outbox_id);
    assert.ok(item);

    await taker.query("SET ROLE aichm_conversation_runtime");
    const takerPid = (await taker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let takeoverFinished = false;
    const takeoverPromise = taker.query(
      `SELECT * FROM aichm_private.transition_conversation_control(
        $1,2,'takeover','replit_lms_user:42',$2,'synthetic concurrent takeover',false,true
      )`,
      [threadId, randomUUID()],
    ).then(result => { takeoverFinished = true; return result; });
    await waitUntilBlockedBy(takerPid, claimantPid);
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
  await pool!.query(
    "UPDATE aichm_private.conversation_outbox SET state='cancelled' WHERE state='pending' AND id<>$1",
    [queued.rows[0].outbox_id],
  );
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
  await pool!.query(
    "UPDATE aichm_private.conversation_outbox SET state='cancelled' WHERE state='pending' AND id<>$1",
    [retryQueue.rows[0].outbox_id],
  );
  const firstClaim = await asRuntime(client => client.query(
    "SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)",
  ));
  const attempt = firstClaim.rows.find(row => row.outbox_id === retryQueue.rows[0].outbox_id);
  assert.ok(attempt);
  await pool!.query(
    `UPDATE aichm_private.conversation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [retryQueue.rows[0].outbox_id],
  );
  await pool!.query(
    `UPDATE aichm_private.conversation_outbox_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [attempt.attempt_id],
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

  const { threadId: sendingThread } = await createReadyThread();
  const sendingQueue = await enqueueAssistant(sendingThread);
  const sending = await claimAndAuthorize(sendingQueue.rows[0].outbox_id);
  assert.equal(sending.allowed, true);
  await pool!.query(
    `UPDATE aichm_private.conversation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [sendingQueue.rows[0].outbox_id],
  );
  await pool!.query(
    `UPDATE aichm_private.conversation_outbox_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [sending.attempt_id],
  );
  const afterExpiredSend = await asRuntime(client => client.query(
    "SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)",
  ));
  assert.equal(afterExpiredSend.rows.some(row => row.outbox_id === sendingQueue.rows[0].outbox_id), false);
  const unknownState = await queryRows<{ outbox_state: string; attempt_count: number; delivery_state: string }>(`
    SELECT o.state AS outbox_state,o.attempt_count,a.delivery_state
    FROM aichm_private.conversation_outbox o
    JOIN aichm_private.conversation_outbox_attempts a ON a.outbox_id=o.id
    WHERE o.id=$1 ORDER BY a.attempt_number DESC LIMIT 1
  `, [sendingQueue.rows[0].outbox_id]);
  assert.equal(unknownState[0].outbox_state, "unknown");
  assert.equal(unknownState[0].delivery_state, "unknown");
  assert.equal(unknownState[0].attempt_count, 1);

  const { threadId: ceilingThread } = await createReadyThread();
  const ceilingQueue = await enqueueAssistant(ceilingThread);
  for (let expectedAttempt = 1; expectedAttempt <= 8; expectedAttempt += 1) {
    await pool!.query(
      "UPDATE aichm_private.conversation_outbox SET state='cancelled' WHERE state='pending' AND id<>$1",
      [ceilingQueue.rows[0].outbox_id],
    );
    const batch = await asRuntime(client => client.query(
      "SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)",
    ));
    const claim = batch.rows.find(row => row.outbox_id === ceilingQueue.rows[0].outbox_id);
    assert.ok(claim, `attempt ${expectedAttempt} should be claimed`);
    const attemptNumber = await queryRows<{ attempt_number: number }>(
      "SELECT attempt_number FROM aichm_private.conversation_outbox_attempts WHERE id=$1",
      [claim.attempt_id],
    );
    assert.equal(attemptNumber[0].attempt_number, expectedAttempt);
    await pool!.query(
      "UPDATE aichm_private.conversation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [ceilingQueue.rows[0].outbox_id],
    );
    await pool!.query(
      "UPDATE aichm_private.conversation_outbox_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [claim.attempt_id],
    );
  }
  const exhausted = await asRuntime(client => client.query(
    "SELECT * FROM aichm_private.claim_next_conversation_outbound(true,60)",
  ));
  assert.equal(exhausted.rows.some(row => row.outbox_id === ceilingQueue.rows[0].outbox_id), false);
  const ceilingState = await queryRows<{ state: string; attempt_count: number }>(
    "SELECT state,attempt_count FROM aichm_private.conversation_outbox WHERE id=$1",
    [ceilingQueue.rows[0].outbox_id],
  );
  assert.equal(ceilingState[0].state, "failed");
  assert.equal(ceilingState[0].attempt_count, 8);
});

test("delivery receipts retain raw provider labels and ignore regressions", {
  skip: !enabled,
}, async () => {
  const { threadId, threadRef } = await createReadyThread();
  const queued = await enqueueAssistant(threadId);
  const send = await claimAndAuthorize(queued.rows[0].outbox_id);
  assert.equal(send.allowed, true);
  const providerMessageRef = `sent-${randomUUID()}`;
  const providerMessageKey = syntheticToken(providerMessageRef);
  const sent = await asRuntime(client => client.query(
    "SELECT aichm_private.record_conversation_send_result($1,$2,$3,'sent',$4) AS result",
    [queued.rows[0].outbox_id, send.attempt_id, send.lease_token, providerMessageKey],
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
        event.provider, syntheticToken(event.providerEventRef), syntheticToken(event.threadRef),
        conversationEventIdempotencyKey(syntheticToken(event.providerEventRef)), conversationEventFingerprint(event),
        event.occurredAt, event.kind, syntheticToken(event.providerMessageRef), event.deliveryState,
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

test("a late receipt for a prior attempt is retained without mutating the current attempt", {
  skip: !enabled,
}, async () => {
  const { threadId, threadRef } = await createReadyThread();
  const queued = await enqueueAssistant(threadId);

  const firstSend = await claimAndAuthorize(queued.rows[0].outbox_id);
  const priorProviderMessageRef = `prior-attempt-${randomUUID()}`;
  const priorProviderMessageKey = syntheticToken(priorProviderMessageRef);
  await asRuntime(client => client.query(
    "SELECT aichm_private.record_conversation_send_result($1,$2,$3,'sent',$4)",
    [queued.rows[0].outbox_id, firstSend.attempt_id, firstSend.lease_token, priorProviderMessageKey],
  ));

  // Isolated fixture simulates a separately reviewed retry operation. No
  // production retry path or sender is installed by this migration.
  await pool!.query(`
    UPDATE aichm_private.conversation_outbox
    SET state='pending',attempt_count=1,lease_token=NULL,lease_expires_at=NULL
    WHERE id=$1
  `, [queued.rows[0].outbox_id]);
  const secondSend = await claimAndAuthorize(queued.rows[0].outbox_id);
  const currentProviderMessageKey = syntheticToken(`current-attempt-${randomUUID()}`);
  await asRuntime(client => client.query(
    "SELECT aichm_private.record_conversation_send_result($1,$2,$3,'sent',$4)",
    [queued.rows[0].outbox_id, secondSend.attempt_id, secondSend.lease_token, currentProviderMessageKey],
  ));

  const receipt = {
    contractVersion: 1,
    provider: "whatsapp",
    providerEventRef: `late-receipt-${randomUUID()}`,
    threadRef,
    occurredAt: new Date().toISOString(),
    kind: "delivery",
    providerMessageRef: priorProviderMessageRef,
    deliveryState: "delivered",
    rawProviderReceiptValue: "ProviderDelivered",
  };
  const parsed = validateAvniConversationEvent(receipt);
  if (!parsed.success || parsed.event.kind !== "delivery") {
    throw new Error("AVNI_TEST_LATE_RECEIPT_INVALID");
  }
  const event = parsed.event;
  const recorded = await asRuntime(client => client.query(
    `SELECT * FROM aichm_private.accept_provider_event(
      $1,$2,$3,$4,$5,$6::timestamptz,$7,$8,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$9,$10
    )`,
    [
      event.provider, syntheticToken(event.providerEventRef), syntheticToken(event.threadRef),
      conversationEventIdempotencyKey(syntheticToken(event.providerEventRef)),
      conversationEventFingerprint(event), event.occurredAt, event.kind,
      syntheticToken(event.providerMessageRef), event.deliveryState, event.rawProviderReceiptValue,
    ],
  ));
  assert.equal(recorded.rows[0].outcome, "receipt_recorded");

  const result = await queryRows<{ attempt_number: number; delivery_state: string; provider_message_key: string }>(`
    SELECT attempt_number,delivery_state,provider_message_key
    FROM aichm_private.conversation_outbox_attempts
    WHERE outbox_id=$1 ORDER BY attempt_number
  `, [queued.rows[0].outbox_id]);
  assert.equal(result.length, 2);
  assert.equal(result[0].delivery_state, "sent");
  assert.equal(result[1].delivery_state, "sent");
  assert.equal(result[1].provider_message_key, currentProviderMessageKey);
  const outbox = await queryRows<{ state: string }>(
    "SELECT state FROM aichm_private.conversation_outbox WHERE id=$1",
    [queued.rows[0].outbox_id],
  );
  assert.equal(outbox[0].state, "accepted");
});

test("provider acceptance is recorded as sent, not delivered, and takeover cannot recall it", {
  skip: !enabled,
}, async () => {
  const { threadId } = await createReadyThread();
  const queued = await enqueueAssistant(threadId);
  const send = await claimAndAuthorize(queued.rows[0].outbox_id);
  const providerAcceptedRef = `accepted-${randomUUID()}`;
  const providerAcceptedKey = syntheticToken(providerAcceptedRef);
  await asRuntime(client => client.query(
    "SELECT aichm_private.record_conversation_send_result($1,$2,$3,'sent',$4)",
    [queued.rows[0].outbox_id, send.attempt_id, send.lease_token, providerAcceptedKey],
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
