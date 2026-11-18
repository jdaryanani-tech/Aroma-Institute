import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Request } from "express";
import type { AvniHmacKeyProvider } from "./avni-provider-reference-hmac";
import {
  createAvniPilotStatusReader,
  createAvniSingleRecipientPilotDispatcher,
  pilotMessageIdempotencyKey,
  type PilotGrantEngine,
} from "./avni-single-recipient-pilot";
import type { AvniPilotSupabaseWriterContract } from "./avni-pilot-supabase-writer";
import { AVNI_PILOT_MESSAGE, createEvolutionPilotTransport } from "./evolution-pilot-transport";

const leadId = "20000000-0000-4000-8000-000000000001";
const threadId = "30000000-0000-4000-8000-000000000001";
const outboxId = "40000000-0000-4000-8000-000000000001";
const messageId = "50000000-0000-4000-8000-000000000001";
const attemptId = "60000000-0000-4000-8000-000000000001";
const leaseToken = "70000000-0000-4000-8000-000000000001";
const idempotencyKey = "80000000-0000-4000-8000-000000000001";
const recipient = "+919876543210";
const request = {
  session: { lmsUserId: 7 },
  lmsUser: { id: 7, phoneE164: "redacted", displayName: null, roles: ["admin"] },
} as unknown as Pick<Request, "session" | "lmsUser">;

function syntheticKeys(): AvniHmacKeyProvider {
  return {
    activeKeyId: () => "test-a",
    retainedKeys: () => [{ keyId: "test-a", key: Buffer.alloc(32, 0x51) }],
  };
}

function syntheticPool(options: {
  consent?: string;
  optedOutAt?: Date | null;
  canonicalPhone?: string;
  actorActive?: boolean;
  roles?: string[];
  assignmentRows?: { assignee_user_id: number | null; version: number }[];
  preferenceCount?: number;
} = {}) {
  const queries: string[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          queries.push(sql);
          if (sql.includes("FROM lms_users")) {
            return { rows: [{ id: 7, is_active: options.actorActive ?? true }] };
          }
          if (sql.includes("FROM lms_user_roles")) {
            return { rows: (options.roles ?? ["admin"]).map(role => ({ role })) };
          }
          if (sql.includes("FROM admissions_leads")) {
            return { rows: [{ id: leadId, canonical_phone: options.canonicalPhone ?? "919876543210" }] };
          }
          if (sql.includes("FROM admissions_lead_assignments")) {
            return { rows: options.assignmentRows ?? [{ assignee_user_id: null, version: 0 }] };
          }
          if (sql.includes("FROM admissions_lead_contact_preferences")) {
            return { rows: Array.from({ length: options.preferenceCount ?? 1 }, () => ({
              consent_status: options.consent ?? "granted",
              opted_out_at: options.optedOutAt ?? null,
              consent_epoch: 3,
            })) };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return { pool: pool as unknown as Pick<Pool, "connect">, queries };
}

function createFakeWriter(
  state: { current: string | null },
  beginOutcome: "begun" | "denied" = "begun",
  options: { singleClaim?: boolean; rendezvousInitialLookups?: boolean } = {},
) {
  const calls: string[] = [];
  let claimIssued = false;
  let initialLookupCount = 0;
  let releaseInitialLookups!: () => void;
  const initialLookupBarrier = new Promise<void>(resolve => {
    releaseInitialLookups = resolve;
  });
  const writer: AvniPilotSupabaseWriterContract = {
    async preflight() {
      calls.push("preflight");
      return {
        outcome: "preflight_ready",
        threadId,
        provider: "whatsapp",
        mode: "human",
        lifecycle: "open",
        controlVersion: 2,
      };
    },
    async findByIdempotencyKey() {
      calls.push("lookup");
      if (options.rendezvousInitialLookups && state.current === null && initialLookupCount < 2) {
        initialLookupCount++;
        if (initialLookupCount === 2) releaseInitialLookups();
        await initialLookupBarrier;
      }
      if (!state.current) return null;
      return {
        outboxId, messageId, threadId,
        state: state.current as "pending" | "claimed" | "sending" | "accepted" | "delivered" | "failed" | "unknown" | "cancelled",
        controlVersion: 2,
        attemptNumber: 1,
      };
    },
    async enqueueHumanMessage(input) {
      calls.push("enqueue");
      assert.equal(input.actorRef, "replit_lms_user:7");
      assert.equal(input.text, AVNI_PILOT_MESSAGE);
      if (state.current) return { outcome: "duplicate", outboxId, messageId, threadId };
      state.current = "pending";
      return { outcome: "queued", outboxId, messageId, threadId };
    },
    async claimHumanOutbox() {
      calls.push("claim");
      if (options.singleClaim && claimIssued) return null;
      claimIssued = true;
      state.current = "claimed";
      return {
        outboxId, messageId, threadId, attemptId, leaseToken,
        controlVersion: 2, attemptNumber: 1, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
    },
    async beginHumanSend(input) {
      calls.push("begin");
      assert.equal(input.actorRef, "replit_lms_user:7");
      return beginOutcome;
    },
    async recordResult(input) {
      calls.push(`record:${input.result}`);
      state.current = input.result === "sent" ? "accepted" : input.result;
      return input.result;
    },
  };
  return { writer, calls };
}

function createGrantEngine(options: {
  issueCode?: string;
  beginDenyCode?: string;
} = {}) {
  const calls: string[] = [];
  const engine: PilotGrantEngine = {
    async issue(_request, binding) {
      calls.push("issue");
      assert.equal(binding.canonicalLeadId, leadId);
      assert.equal(binding.controlVersion, 2);
      if (options.issueCode) return { code: options.issueCode, grant: null };
      return { code: "grant_issued", grant: { id: "90000000-0000-4000-8000-000000000001", state: "issued" } };
    },
    async begin(_request, _grantId, beginSupabaseSend) {
      calls.push("begin");
      if (options.beginDenyCode) {
        return { code: options.beginDenyCode, providerCallAllowed: false };
      }
      const outcome = await beginSupabaseSend();
      return {
        code: outcome === "begun" ? "begin_send_started" : "supabase_begin_denied",
        providerCallAllowed: outcome === "begun",
      };
    },
    async settle(_grantId, outcome) {
      calls.push(`settle:${outcome}`);
      return true;
    },
  };
  return { engine, calls };
}

function createDispatcher(options: {
  consent?: string;
  optedOutAt?: Date | null;
  canonicalPhone?: string;
  actorActive?: boolean;
  roles?: string[];
  assignmentRows?: { assignee_user_id: number | null; version: number }[];
  preferenceCount?: number;
  providerOutcome?: "accepted" | "unknown" | "failed";
  beginOutcome?: "begun" | "denied";
  state?: { current: string | null };
  singleClaim?: boolean;
  rendezvousInitialLookups?: boolean;
  grantIssueCode?: string;
  grantBeginDenyCode?: string;
}) {
  const { pool, queries } = syntheticPool({
    consent: options.consent,
    optedOutAt: options.optedOutAt,
    canonicalPhone: options.canonicalPhone,
    actorActive: options.actorActive,
    roles: options.roles,
    assignmentRows: options.assignmentRows,
    preferenceCount: options.preferenceCount,
  });
  const state = options.state ?? { current: null };
  const { writer, calls: writerCalls } = createFakeWriter(state, options.beginOutcome ?? "begun", {
    singleClaim: options.singleClaim,
    rendezvousInitialLookups: options.rendezvousInitialLookups,
  });
  const grant = createGrantEngine({
    issueCode: options.grantIssueCode,
    beginDenyCode: options.grantBeginDenyCode,
  });
  let providerCalls = 0;
  const transport = createEvolutionPilotTransport({
    async sendText() {
      providerCalls += 1;
      if (options.providerOutcome === "unknown") return { state: "unknown" };
      if (options.providerOutcome === "failed") return { state: "failed", code: "definite_rejection" };
      return { state: "accepted", providerMessageId: "synthetic-provider-message-id" };
    },
  });
  const dispatch = createAvniSingleRecipientPilotDispatcher({
    pool,
    supabaseWriter: writer,
    hmacKeyProvider: syntheticKeys(),
    transport,
    grantEngine: grant.engine,
    enabled: true,
    approvedRecipientE164: recipient,
  });
  return { dispatch, state, queries, writerCalls, grantCalls: grant.calls, get providerCalls() { return providerCalls; } };
}

test("complete single-recipient pipeline orders consent authorization, HMAC grant, Supabase begin, then fake provider", async () => {
  const runtime = createDispatcher({ providerOutcome: "accepted" });
  const result = await runtime.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  });
  assert.deepEqual(result, { status: "accepted", safeCode: "provider_accepted" });
  assert.ok(runtime.queries.some(sql => sql === "BEGIN"));
  assert.ok(runtime.writerCalls.indexOf("enqueue") < runtime.writerCalls.indexOf("begin"));
  assert.equal(runtime.providerCalls, 1);
  assert.deepEqual(runtime.grantCalls, ["issue", "begin", "settle:accepted"]);
});

test("consent and opt-out gates stop before any Supabase queue or provider call", async () => {
  for (const consent of ["not_provided", "opted_out"]) {
    const runtime = createDispatcher({ consent });
    const result = await runtime.dispatch(request, {
      canonicalLeadId: leadId,
      recipientE164: recipient,
      expectedControlVersion: 2,
      idempotencyKey,
    });
    assert.deepEqual(result, { status: "failed", safeCode: "consent_not_granted" });
    assert.equal(runtime.writerCalls.length, 0);
    assert.equal(runtime.providerCalls, 0);
  }
  const optedOut = createDispatcher({ consent: "granted", optedOutAt: new Date() });
  assert.deepEqual(await optedOut.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  }), { status: "failed", safeCode: "consent_not_granted" });
  assert.equal(optedOut.writerCalls.length, 0);
});

test("inactive, wrong-role, ambiguous-assignment, and ambiguous-consent CRM state fail closed", async () => {
  const cases = [
    { actorActive: false, safeCode: "actor_unavailable" },
    { roles: ["admissions"], safeCode: "actor_unavailable" },
    {
      assignmentRows: [
        { assignee_user_id: null, version: 0 },
        { assignee_user_id: 8, version: 1 },
      ],
      safeCode: "assignment_denied",
    },
    { preferenceCount: 2, safeCode: "consent_not_granted" },
  ] as const;
  for (const item of cases) {
    const runtime = createDispatcher(item);
    assert.deepEqual(await runtime.dispatch(request, {
      canonicalLeadId: leadId,
      recipientE164: recipient,
      expectedControlVersion: 2,
      idempotencyKey,
    }), { status: "failed", safeCode: item.safeCode });
    assert.equal(runtime.writerCalls.length, 0);
    assert.equal(runtime.providerCalls, 0);
  }
  const mismatchedSession = createDispatcher({});
  assert.deepEqual(await mismatchedSession.dispatch({
    ...request,
    session: { lmsUserId: 8 } as never,
  }, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  }), { status: "failed", safeCode: "actor_unavailable" });
  assert.equal(mismatchedSession.queries.length, 0);
});

test("unknown provider outcomes are persisted as terminal and replay never calls provider again", async () => {
  const runtime = createDispatcher({ providerOutcome: "unknown" });
  const first = await runtime.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  });
  assert.deepEqual(first, { status: "unknown", safeCode: "provider_outcome_unknown" });
  assert.equal(runtime.providerCalls, 1);
  const second = await runtime.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  });
  assert.deepEqual(second, { status: "unknown", safeCode: "provider_outcome_unknown" });
  assert.equal(runtime.providerCalls, 1);
});

test("a new client idempotency key cannot create a second outbound message for this one-recipient pilot", async () => {
  const runtime = createDispatcher({ providerOutcome: "accepted" });
  const input = {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  };
  assert.deepEqual(await runtime.dispatch(request, input), {
    status: "accepted",
    safeCode: "provider_accepted",
  });
  assert.deepEqual(await runtime.dispatch(request, {
    ...input,
    idempotencyKey: "81000000-0000-4000-8000-000000000002",
  }), {
    status: "accepted",
    safeCode: "already_processed",
  });
  assert.equal(runtime.providerCalls, 1);
});

test("approved recipient mismatch and missing HMAC/writer/transport prerequisites fail closed", async () => {
  const base = createDispatcher({});
  assert.deepEqual(await base.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: "+919876543211",
    expectedControlVersion: 2,
    idempotencyKey,
  }), { status: "failed", safeCode: "pilot_request_not_approved" });
  assert.equal(base.providerCalls, 0);

  const { pool } = syntheticPool();
  const unconfigured = createAvniSingleRecipientPilotDispatcher({
    pool,
    supabaseWriter: null,
    hmacKeyProvider: null,
    transport: null,
    grantEngine: null,
    enabled: true,
    approvedRecipientE164: recipient,
  });
  assert.deepEqual(await unconfigured(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  }), { status: "unknown", safeCode: "dispatch_runtime_unavailable" });
});

test("canonical phone mismatch and a denied begin-send fence never reach the provider", async () => {
  const mismatched = createDispatcher({ canonicalPhone: "919876543211" });
  assert.deepEqual(await mismatched.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  }), { status: "failed", safeCode: "recipient_mismatch" });
  assert.equal(mismatched.writerCalls.length, 0);
  assert.equal(mismatched.providerCalls, 0);

  const fenced = createDispatcher({ beginOutcome: "denied" });
  assert.deepEqual(await fenced.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  }), { status: "failed", safeCode: "supabase_begin_denied" });
  assert.equal(fenced.providerCalls, 0);
});

test("final grant recheck blocks revoked consent, expiry, reassignment, and actor-role changes", async () => {
  const revoked = createDispatcher({ grantIssueCode: "grant_revoked" });
  assert.deepEqual(await revoked.dispatch(request, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  }), { status: "failed", safeCode: "grant_revoked" });
  assert.equal(revoked.providerCalls, 0);

  for (const code of ["grant_expired", "assignment_changed", "actor_role_changed"]) {
    const runtime = createDispatcher({ grantBeginDenyCode: code });
    assert.deepEqual(await runtime.dispatch(request, {
      canonicalLeadId: leadId,
      recipientE164: recipient,
      expectedControlVersion: 2,
      idempotencyKey,
    }), { status: "failed", safeCode: code });
    assert.equal(runtime.providerCalls, 0);
    assert.ok(!runtime.writerCalls.includes("begin"));
  }
});

test("concurrent duplicate dispatch requests claim once and invoke the fake provider at most once", async () => {
  const runtime = createDispatcher({
    singleClaim: true,
    rendezvousInitialLookups: true,
    providerOutcome: "accepted",
  });
  const input = {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  };
  const [first, second] = await Promise.all([
    runtime.dispatch(request, input),
    runtime.dispatch(request, input),
  ]);
  assert.ok([first.status, second.status].every(status =>
    status === "accepted" || status === "in_progress"));
  assert.equal(runtime.providerCalls, 1);
  assert.equal(runtime.writerCalls.filter(call => call === "claim").length, 2);
});

test("unknown status reconciliation is read-only, stable-keyed, and returns no internal identifiers", async () => {
  const { writer, calls } = createFakeWriter({ current: "unknown" });
  const readStatus = createAvniPilotStatusReader({
    readStatus: async key => {
      const result = await writer.findByIdempotencyKey(key);
      return result && { state: result.state, attemptNumber: result.attemptNumber };
    },
  });
  const result = await readStatus(request, { canonicalLeadId: leadId, idempotencyKey });
  assert.deepEqual(result, {
    state: "unknown",
    attemptNumber: 1,
    safeCode: "manual_provider_reconciliation_required",
  });
  const expectedDigest = createHash("sha256")
    .update(`avni-single-recipient-pilot-v1:${leadId}`, "utf8")
    .digest("hex");
  assert.equal(pilotMessageIdempotencyKey(leadId, idempotencyKey), `message:v1:${expectedDigest}`);
  assert.equal(
    pilotMessageIdempotencyKey(leadId.toUpperCase(), idempotencyKey.toUpperCase()),
    `message:v1:${expectedDigest}`,
  );
  assert.equal(pilotMessageIdempotencyKey(leadId, "81000000-0000-4000-8000-000000000002"),
    `message:v1:${expectedDigest}`);
  assert.deepEqual(calls, ["lookup"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${leadId}|${threadId}|${outboxId}|${messageId}`));
});

test("definite provider failure is terminal and is never retried on idempotent replay", async () => {
  const runtime = createDispatcher({ providerOutcome: "failed" });
  const input = {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  };
  assert.deepEqual(await runtime.dispatch(request, input), {
    status: "failed", safeCode: "definite_rejection",
  });
  assert.equal(runtime.providerCalls, 1);
  assert.deepEqual(await runtime.dispatch(request, input), {
    status: "failed", safeCode: "already_terminal",
  });
  assert.equal(runtime.providerCalls, 1);
});

test("client-supplied actor and content never enter pilot API result or safe log fields", async () => {
  const runtime = createDispatcher({ providerOutcome: "accepted" });
  const result = await runtime.dispatch({
    ...request,
    lmsUser: { ...request.lmsUser!, id: 8, phoneE164: "secret-value", displayName: "private", roles: ["admin"] },
  }, {
    canonicalLeadId: leadId,
    recipientE164: recipient,
    expectedControlVersion: 2,
    idempotencyKey,
  });
  // The session/attached-user mismatch is caught before any database call.
  assert.deepEqual(result, { status: "failed", safeCode: "actor_unavailable" });
  assert.equal(runtime.providerCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|private|919876543210|Welcome/);
});
