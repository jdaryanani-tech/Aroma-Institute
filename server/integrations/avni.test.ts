import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMessageIdempotency, normalizeAvniMessageInput, verifyAvniIntegrationSecret,
} from "./avni";
import {
  classifyLegacyLead, planLegacyConversation, planLegacyKnowledge, type SupabaseLegacyLead,
} from "../db/supabase-legacy-import";

const lead = (overrides: Partial<SupabaseLegacyLead> = {}): SupabaseLegacyLead => ({
  id: "11111111-1111-4111-8111-111111111111",
  phone: "9687878669", name: "Test lead", created_at: "2026-01-01T00:00:00Z",
  lead_type: "student", intent: "training", city: null, experience: null, cafe_plan: null, timeline: null,
  lead_score: null, appointment_status: null, appointment_date: null, appointment_time: null,
  conversation_status: null, last_message_at: null, ...overrides,
});

test("AVNI secret comparison fails closed and compares authenticated values", () => {
  assert.equal(verifyAvniIntegrationSecret("same-secret", "same-secret"), true);
  assert.equal(verifyAvniIntegrationSecret("wrong", "same-secret"), false);
  assert.equal(verifyAvniIntegrationSecret("", undefined), false);
  assert.equal(verifyAvniIntegrationSecret("x".repeat(1025), "x".repeat(1025)), false);
});

test("AVNI message validation requires a normalized Indian phone and nonempty text", () => {
  const valid = normalizeAvniMessageInput({
    phone: "+91 96878 78669", direction: "inbound", body: "Hello",
    idempotencyKey: "wa:message-1",
  });
  assert.equal(valid.success, true);
  assert.equal(normalizeAvniMessageInput({
    phone: "12345", direction: "inbound", body: "Hello", idempotencyKey: "wa:1",
  }).success, false);
  assert.equal(normalizeAvniMessageInput({
    phone: "9687878669", direction: "inbound", body: "  ", idempotencyKey: "wa:2",
  }).success, false);
  assert.equal(normalizeAvniMessageInput({
    phone: "9687878669", direction: "outbound", messageType: "booking_confirmation",
    body: "confirmed", idempotencyKey: "wa:3",
  }).success, false);
});

test("message idempotency returns duplicate only for identical saved message data", () => {
  const existing = { leadId: "lead-1", body: "Hi", direction: "inbound" };
  assert.equal(classifyMessageIdempotency(null, existing), "new");
  assert.equal(classifyMessageIdempotency(existing, { ...existing }), "duplicate");
  assert.equal(classifyMessageIdempotency(existing, { ...existing, body: "Different" }), "conflict");
});

test("legacy lead import never automatically links by phone alone", () => {
  const source = lead();
  assert.deepEqual(classifyLegacyLead(source, []), {
    kind: "insert", targetLeadId: source.id,
  });
  assert.deepEqual(classifyLegacyLead(source, [{
    id: "22222222-2222-4222-8222-222222222222", canonicalPhone: "919687878669",
  }]), { kind: "review", reason: "unique_phone_candidate", candidateCount: 1 });
  assert.deepEqual(classifyLegacyLead(source, [
    { id: "22222222-2222-4222-8222-222222222222", canonicalPhone: "919687878669" },
    { id: "33333333-3333-4333-8333-333333333333", canonicalPhone: "919687878669" },
  ]), { kind: "review", reason: "ambiguous_phone", candidateCount: 2 });
  assert.equal(classifyLegacyLead(source, [
    { id: source.id, canonicalPhone: "919687878669" },
  ]).kind, "exact_id");
  assert.equal(classifyLegacyLead(lead({ phone: "bad" }), []).kind, "review");
});

test("legacy conversations preserve inbound/outbound history without claiming delivery", () => {
  const result = planLegacyConversation({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    lead_id: "11111111-1111-4111-8111-111111111111",
    phone: "9687878669", direction: "inbound", message: "Hello",
    message_type: "text", ai_response: "Welcome", created_at: "2026-01-01T00:00:00Z",
  }, "919687878669");
  assert.equal(result.error, null);
  assert.deepEqual(result.messages.map((row) => [row.direction, row.deliveryState, row.sourceMessageSide]), [
    ["inbound", "received", "message"],
    ["outbound", "unknown", "ai_response"],
  ]);
  assert.equal(result.messages[1].idempotencyKey, "supabase_aichm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:ai_response");
  assert.equal(planLegacyConversation({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    lead_id: "11111111-1111-4111-8111-111111111111",
    phone: "9687878669", direction: "unknown", message: "Hello",
    message_type: "text", ai_response: null, created_at: "2026-01-01T00:00:00Z",
  }, "919687878669").error, "unrecognized_direction");
});

test("course knowledge mapping preserves legacy UUID and fields", () => {
  const mapped = planLegacyKnowledge({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", slug: "espresso", category: "coffee",
    question: "What is espresso?", answer: "A concentrated coffee.", keywords: ["espresso"],
    status: "published", priority: 2, metadata: { source: "legacy" },
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
  });
  assert.equal(mapped.id, mapped.sourceRecordId);
  assert.equal(mapped.answer, "A concentrated coffee.");
  assert.equal(mapped.status, "published");
});
