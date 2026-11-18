import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyConversationEvent,
  conversationEventIdempotencyKey,
  conversationMessageIdempotencyKey,
  evaluateAiQueueItem,
  evaluateAiReplyEligibility,
  transitionConversationControl,
  validateConversationControlState,
  validateAvniConversationEvent,
  type AvniConversationEvent,
  type ConversationControlState,
} from "./avni-conversation-contract";

const inboundFixture = {
  contractVersion: 1,
  provider: "whatsapp",
  providerEventRef: "event-001",
  threadRef: "thread-opaque-01",
  occurredAt: "2026-11-18T08:00:00.000Z",
  kind: "message",
  providerMessageRef: "message-001",
  direction: "inbound",
  author: "prospect",
  messageType: "text",
  text: "Synthetic hello",
} as const;

const grantedAiState: ConversationControlState = {
  version: 4,
  mode: "ai",
  lifecycle: "open",
  consentStatus: "granted",
  optedOut: false,
};

function parseFixture(fixture: unknown = inboundFixture): AvniConversationEvent {
  const result = validateAvniConversationEvent(fixture);
  assert.equal(result.success, true);
  if (!result.success) throw new Error(result.code);
  return result.event;
}

test("versioned contract validates provider-neutral inbound and outbound message fixtures", () => {
  const inbound = parseFixture();
  assert.equal(inbound.contractVersion, 1);
  assert.equal(classifyConversationEvent(inbound), "inbound_prospect_message");

  const aiOutbound = parseFixture({
    ...inboundFixture,
    providerEventRef: "event-ai",
    providerMessageRef: "message-ai",
    direction: "outbound",
    author: "assistant",
  });
  assert.equal(classifyConversationEvent(aiOutbound), "outbound_ai_message");

  const humanOutbound = parseFixture({
    ...inboundFixture,
    providerEventRef: "event-human",
    providerMessageRef: "message-human",
    direction: "outbound",
    author: "human_staff",
  });
  assert.equal(classifyConversationEvent(humanOutbound), "outbound_human_message");

  const delivery = parseFixture({
    contractVersion: 1,
    provider: "whatsapp",
    providerEventRef: "event-delivery",
    threadRef: "thread-opaque-01",
    occurredAt: "2026-11-18T08:01:00.000Z",
    kind: "delivery",
    providerMessageRef: "message-ai",
    deliveryState: "delivered",
  });
  assert.equal(classifyConversationEvent(delivery), "delivery_update");
});

test("event validation rejects unknown versions, extra provider payload, and unsafe media URLs", () => {
  assert.deepEqual(validateAvniConversationEvent({ ...inboundFixture, contractVersion: 2 }), {
    success: false,
    code: "invalid_conversation_event",
  });
  assert.equal(validateAvniConversationEvent({ ...inboundFixture, rawPayload: { phone: "private" } }).success, false);
  assert.equal(validateAvniConversationEvent({
    ...inboundFixture,
    messageType: "image",
    text: undefined,
    mediaRef: "https://provider.example/private-media",
  }).success, false);
  assert.equal(validateConversationControlState({
    version: -1,
    mode: "ai",
    lifecycle: "open",
    consentStatus: "granted",
    optedOut: false,
  }).success, false);
  assert.equal(validateConversationControlState({
    version: 1,
    mode: "human",
    lifecycle: "open",
    consentStatus: "granted",
    optedOut: false,
    ownerPhone: "must-not-be-part-of-state",
  }).success, false);
});

test("event and message idempotency keys are stable, scoped, and contain no source references", () => {
  const first = parseFixture();
  const retry = parseFixture({ ...inboundFixture });
  const sameMessageNewEvent = parseFixture({ ...inboundFixture, providerEventRef: "event-retry-wrapper" });

  assert.equal(conversationEventIdempotencyKey(first), conversationEventIdempotencyKey(retry));
  assert.notEqual(conversationEventIdempotencyKey(first), conversationEventIdempotencyKey(sameMessageNewEvent));
  assert.equal(conversationMessageIdempotencyKey(first), conversationMessageIdempotencyKey(sameMessageNewEvent));
  assert.notEqual(
    conversationMessageIdempotencyKey(first),
    conversationMessageIdempotencyKey(parseFixture({ ...inboundFixture, provider: "other-provider" })),
  );
  assert.doesNotMatch(conversationEventIdempotencyKey(first), /event-001|whatsapp/);
});

test("unknown and ambiguous thread mappings fail closed before AI eligibility", () => {
  const event = parseFixture();
  assert.deepEqual(evaluateAiReplyEligibility({ event, mapping: "unknown", state: grantedAiState }), {
    eligible: false,
    code: "thread_mapping_unknown",
  });
  assert.deepEqual(evaluateAiReplyEligibility({ event, mapping: "ambiguous", state: grantedAiState }), {
    eligible: false,
    code: "thread_mapping_ambiguous",
  });
  assert.deepEqual(evaluateAiReplyEligibility({ event, mapping: "unique", state: grantedAiState }), {
    eligible: true,
    code: "eligible",
  });
});

test("missing consent, opt-out, and closed conversations block AI replies", () => {
  const event = parseFixture();
  assert.equal(evaluateAiReplyEligibility({
    event,
    mapping: "unique",
    state: { ...grantedAiState, consentStatus: "not_provided" },
  }).code, "whatsapp_consent_not_granted");
  assert.equal(evaluateAiReplyEligibility({
    event,
    mapping: "unique",
    state: { ...grantedAiState, optedOut: true },
  }).code, "whatsapp_opted_out");
  assert.equal(evaluateAiReplyEligibility({
    event,
    mapping: "unique",
    state: { ...grantedAiState, lifecycle: "closed" },
  }).code, "conversation_closed");
});

test("outbound and delivery events are never treated as inbound prompts", () => {
  const outbound = parseFixture({ ...inboundFixture, direction: "outbound", author: "assistant" });
  const receipt = parseFixture({
    contractVersion: 1,
    provider: "whatsapp",
    providerEventRef: "receipt-001",
    threadRef: "thread-opaque-01",
    occurredAt: "2026-11-18T08:01:00.000Z",
    kind: "delivery",
    providerMessageRef: "message-001",
    deliveryState: "read",
  });
  assert.equal(evaluateAiReplyEligibility({ event: outbound, mapping: "unique", state: grantedAiState }).code,
    "not_inbound_prospect_message");
  assert.equal(evaluateAiReplyEligibility({ event: receipt, mapping: "unique", state: grantedAiState }).code,
    "not_inbound_prospect_message");
});

test("human takeover overrides AI eligibility and increments the control version", () => {
  const takeover = transitionConversationControl(grantedAiState, {
    type: "takeover",
    expectedVersion: 4,
    authorizedStaff: true,
  });
  assert.deepEqual(takeover, {
    changed: true,
    state: { ...grantedAiState, mode: "human", version: 5 },
  });
  if (!takeover.changed) return;
  assert.equal(evaluateAiReplyEligibility({
    event: parseFixture(),
    mapping: "unique",
    state: takeover.state,
  }).code, "human_takeover_active");
});

test("queued AI work becomes stale after takeover and stays stale after resume", () => {
  const item = { expectedConversationVersion: 4 };
  const afterTakeover = transitionConversationControl(grantedAiState, {
    type: "takeover",
    expectedVersion: 4,
    authorizedStaff: true,
  });
  assert.equal(afterTakeover.changed, true);
  if (!afterTakeover.changed) return;
  assert.equal(evaluateAiQueueItem({ item, mapping: "unique", state: afterTakeover.state }).code,
    "stale_conversation_version");

  const afterResume = transitionConversationControl(afterTakeover.state, {
    type: "resume",
    expectedVersion: 5,
    authorizedStaff: true,
  });
  assert.equal(afterResume.changed, true);
  if (!afterResume.changed) return;
  assert.equal(afterResume.state.version, 6);
  assert.equal(evaluateAiQueueItem({ item, mapping: "unique", state: afterResume.state }).code,
    "stale_conversation_version");
});

test("resume requires explicit staff authorization and the current version", () => {
  const humanState = { ...grantedAiState, mode: "human" as const, version: 9 };
  assert.deepEqual(transitionConversationControl(humanState, {
    type: "resume",
    expectedVersion: 9,
    authorizedStaff: false,
  }), { changed: false, code: "staff_authorization_required" });
  assert.deepEqual(transitionConversationControl(humanState, {
    type: "resume",
    expectedVersion: 8,
    authorizedStaff: true,
  }), { changed: false, code: "conversation_version_conflict" });
  assert.deepEqual(transitionConversationControl(humanState, {
    type: "resume",
    expectedVersion: 9,
    authorizedStaff: true,
  }), {
    changed: true,
    state: { ...humanState, mode: "ai", version: 10 },
  });
});

test("resume remains blocked after opt-out, missing consent, or closure", () => {
  const humanState = { ...grantedAiState, mode: "human" as const };
  assert.equal(transitionConversationControl({ ...humanState, optedOut: true }, {
    type: "resume",
    expectedVersion: 4,
    authorizedStaff: true,
  }).code, "whatsapp_opted_out");
  assert.equal(transitionConversationControl({ ...humanState, consentStatus: "unknown" }, {
    type: "resume",
    expectedVersion: 4,
    authorizedStaff: true,
  }).code, "whatsapp_consent_not_granted");
  assert.equal(transitionConversationControl({ ...humanState, lifecycle: "closed" }, {
    type: "resume",
    expectedVersion: 4,
    authorizedStaff: true,
  }).code, "conversation_closed");
});

test("resume is only a control transition and does not revive old queued work", () => {
  const closedOrHuman: ConversationControlState = { ...grantedAiState, mode: "human" };
  const transition = transitionConversationControl(closedOrHuman, {
    type: "resume",
    expectedVersion: closedOrHuman.version,
    authorizedStaff: true,
  });
  assert.equal(transition.changed, true);
  if (!transition.changed) return;
  assert.equal(evaluateAiQueueItem({
    item: { expectedConversationVersion: closedOrHuman.version - 1 },
    mapping: "unique",
    state: transition.state,
  }).code, "stale_conversation_version");
});
