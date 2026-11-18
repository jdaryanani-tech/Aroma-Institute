import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEffectiveConsentChange,
  beginAvniDispatchAttempt,
  dispatchGrantIdempotencyKey,
  issueAvniDispatchGrant,
  settleAvniDispatchGrant,
  type AvniDispatchGrant,
  type AvniDispatchGrantBinding,
  type DispatchConsentSnapshot,
} from "./avni-dispatch-protocol";

const leadId = "10000000-0000-4000-8000-000000000001";
const threadId = "20000000-0000-4000-8000-000000000001";
const outboxId = "30000000-0000-4000-8000-000000000001";
const messageId = "40000000-0000-4000-8000-000000000001";
const attemptId = "50000000-0000-4000-8000-000000000001";
const grantId = "60000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);
const now = new Date("2026-11-19T10:00:00.000Z");

function binding(overrides: Partial<AvniDispatchGrantBinding> = {}): AvniDispatchGrantBinding {
  return {
    canonicalLeadId: leadId,
    actorUserId: 42,
    actorAccessLevel: "admin",
    assignmentAssigneeUserId: null,
    assignmentVersion: 0,
    supabaseThreadId: threadId,
    supabaseOutboxId: outboxId,
    supabaseMessageId: messageId,
    supabaseAttemptId: attemptId,
    messageIdempotencyKey: `message:v1:${digest}`,
    consentEpoch: 4,
    controlVersion: 9,
    attemptNumber: 1,
    leaseTokenHash: digest,
    payloadHash: digest,
    ...overrides,
  };
}

function consent(overrides: Partial<DispatchConsentSnapshot> = {}): DispatchConsentSnapshot {
  return { consentEpoch: 4, consentStatus: "granted", optedOutAt: null, ...overrides };
}

function issue(overrides: Partial<AvniDispatchGrantBinding> = {}): AvniDispatchGrant {
  const result = issueAvniDispatchGrant({
    binding: binding(overrides), consent: consent(), now, grantId,
  });
  assert.equal(result.code, "grant_issued");
  assert.ok(result.grant);
  return result.grant!;
}

test("grant is bound to exact lead/thread/outbox/message/attempt/epoch/version/hash and expires quickly", () => {
  const grant = issue();
  assert.equal(grant.binding.supabaseThreadId, threadId);
  assert.equal(grant.binding.supabaseMessageId, messageId);
  assert.equal(grant.binding.canonicalLeadId, leadId);
  assert.equal(grant.binding.consentEpoch, 4);
  assert.equal(grant.binding.controlVersion, 9);
  assert.equal(new Date(grant.expiresAt).getTime() - new Date(grant.createdAt).getTime(), 30_000);
  assert.match(grant.idempotencyKey, /^dispatch:v1:[0-9a-f]{64}$/);
});

test("duplicate idempotency returns one grant while changed payload/version conflicts", () => {
  const original = issue();
  const duplicate = issueAvniDispatchGrant({
    binding: binding(), consent: consent(), now, existing: original,
  });
  assert.equal(duplicate.code, "grant_duplicate");
  assert.equal(duplicate.grant?.id, original.id);

  const changed = issueAvniDispatchGrant({
    binding: binding({ payloadHash: "b".repeat(64) }),
    consent: consent(), now, existing: original,
  });
  assert.equal(changed.code, "grant_idempotency_conflict");
  assert.equal(dispatchGrantIdempotencyKey(binding({ controlVersion: 10 }))
    === original.idempotencyKey, false);
});

test("missing, revoked, opted-out, or stale-epoch consent cannot issue or begin a grant", () => {
  for (const snapshot of [
    consent({ consentStatus: "not_provided" }),
    consent({ consentStatus: "opted_out", optedOutAt: now.toISOString() }),
    consent({ optedOutAt: now.toISOString() }),
    consent({ consentEpoch: 5 }),
  ]) {
    const denied = issueAvniDispatchGrant({ binding: binding(), consent: snapshot, now });
    assert.equal(denied.code, "grant_revoked");
    assert.equal(denied.providerCallAllowed, false);
  }

  const grant = issue();
  const revoked = beginAvniDispatchAttempt({
    grant, binding: grant.binding, consent: consent({ consentEpoch: 5 }), now,
    supabaseOutcome: "begun",
  });
  assert.equal(revoked.code, "grant_revoked");
  assert.equal(revoked.grant?.state, "revoked");
});

test("expiry, stale actor/assignment/control binding, and replay fail closed", () => {
  const grant = issue();
  const expired = beginAvniDispatchAttempt({
    grant, binding: grant.binding, consent: consent(),
    now: new Date(new Date(grant.expiresAt).getTime() + 1), supabaseOutcome: "begun",
  });
  assert.equal(expired.code, "grant_expired");
  assert.equal(expired.grant?.state, "expired");

  for (const changed of [
    binding({ controlVersion: 10 }),
    binding({ actorAccessLevel: "admissions", assignmentAssigneeUserId: 43, assignmentVersion: 8 }),
    binding({ actorUserId: 43 }),
  ]) {
    const changedBinding = beginAvniDispatchAttempt({
      grant, binding: changed, consent: consent(), now, supabaseOutcome: "begun",
    });
    assert.equal(changedBinding.code, "grant_binding_mismatch");
    assert.equal(changedBinding.grant?.state, "aborted");
  }

  const begun = beginAvniDispatchAttempt({
    grant, binding: grant.binding, consent: consent(), now, supabaseOutcome: "begun",
  });
  assert.equal(begun.code, "begin_send_started");
  assert.equal(begun.providerCallAllowed, false);
  const replay = beginAvniDispatchAttempt({
    grant: begun.grant!, binding: grant.binding, consent: consent(), now,
    supabaseOutcome: "begun",
  });
  assert.equal(replay.code, "grant_replayed");
  assert.equal(replay.providerCallAllowed, false);
});

test("takeover/stale Supabase fence and duplicate begin never authorize a provider call", () => {
  const grant = issue();
  for (const result of ["denied", "already_begun"] as const) {
    const decision = beginAvniDispatchAttempt({
      grant, binding: grant.binding, consent: consent(), now, supabaseOutcome: result,
    });
    assert.equal(decision.allowedToBeginSend, false);
    assert.equal(decision.providerCallAllowed, false);
    assert.equal(decision.grant?.state, result === "denied" ? "aborted" : "unknown");
  }
});

test("cross-database timeout is unknown and cannot be retried blindly", () => {
  const grant = issue();
  const ambiguous = beginAvniDispatchAttempt({
    grant, binding: grant.binding, consent: consent(), now, supabaseOutcome: "unavailable",
  });
  assert.equal(ambiguous.code, "supabase_begin_uncertain");
  assert.equal(ambiguous.grant?.state, "unknown");
  const retry = beginAvniDispatchAttempt({
    grant: ambiguous.grant!, binding: grant.binding, consent: consent(), now,
    supabaseOutcome: "begun",
  });
  assert.equal(retry.code, "grant_replayed");
  assert.equal(retry.providerCallAllowed, false);
});

test("successful begin_send is the in-flight boundary; later takeover/opt-out cannot recall it", () => {
  const grant = issue();
  const inFlight = beginAvniDispatchAttempt({
    grant, binding: grant.binding, consent: consent(), now, supabaseOutcome: "begun",
  });
  assert.equal(inFlight.grant?.state, "in_flight");
  assert.equal(inFlight.providerCallAllowed, false);
  const afterOptOut = beginAvniDispatchAttempt({
    grant: inFlight.grant!, binding: grant.binding,
    consent: consent({ consentStatus: "opted_out", optedOutAt: "2026-11-19T10:00:01.000Z", consentEpoch: 5 }),
    now: new Date("2026-11-19T10:00:01.000Z"), supabaseOutcome: "denied",
  });
  assert.equal(afterOptOut.code, "grant_replayed");
  assert.equal(afterOptOut.grant?.state, "in_flight");
});

test("provider acceptance followed by lost response becomes unknown, never automatic retry", () => {
  const grant = issue();
  const inFlight = beginAvniDispatchAttempt({
    grant, binding: grant.binding, consent: consent(), now, supabaseOutcome: "begun",
  }).grant!;
  const crashed = settleAvniDispatchGrant(inFlight, "ambiguous_result", now);
  assert.equal(crashed.state, "unknown");
  assert.equal(crashed.safeOutcome, "ambiguous_result");
  assert.throws(() => settleAvniDispatchGrant(crashed, "provider_accepted", now),
    /AVNI_DISPATCH_GRANT_NOT_IN_FLIGHT/);
});

test("effective consent changes increment epoch and revoke only unused grants", () => {
  const grant = issue();
  const inFlight = beginAvniDispatchAttempt({
    grant, binding: grant.binding, consent: consent(), now, supabaseOutcome: "begun",
  }).grant!;
  const changed = applyEffectiveConsentChange({
    canonicalLeadId: leadId,
    previous: consent(),
    next: { consentStatus: "opted_out", optedOutAt: now.toISOString() },
    grants: [grant, inFlight],
    now,
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.consent.consentEpoch, 5);
  assert.equal(changed.grants[0].state, "revoked");
  assert.equal(changed.grants[1].state, "in_flight");

  const noChange = applyEffectiveConsentChange({
    canonicalLeadId: leadId,
    previous: changed.consent,
    next: { consentStatus: "opted_out", optedOutAt: now.toISOString() },
    grants: changed.grants,
    now,
  });
  assert.equal(noChange.changed, false);
  assert.equal(noChange.consent.consentEpoch, 5);
});
