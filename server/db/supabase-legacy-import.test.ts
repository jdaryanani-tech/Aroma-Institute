import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLegacyImportApplyGate,
  classifyLegacyLeadReference,
  type SupabaseLegacyLeadReference,
} from "./supabase-legacy-import";

const sourceLead = (overrides: Partial<SupabaseLegacyLeadReference> = {}): SupabaseLegacyLeadReference => ({
  id: "11111111-1111-4111-8111-111111111111",
  phone: "9687878669",
  ...overrides,
});

test("legacy Supabase lead-index reconciliation never links automatically by phone or UUID coincidence", () => {
  const existing = [{ id: "22222222-2222-4222-8222-222222222222", canonicalPhone: "919687878669" }];
  assert.deepEqual(classifyLegacyLeadReference(sourceLead(), []), {
    kind: "unmatched", reason: "no_candidate",
  });
  assert.deepEqual(classifyLegacyLeadReference(sourceLead(), existing), {
    kind: "review_required", reason: "unique_phone_candidate",
  });
  assert.deepEqual(classifyLegacyLeadReference(sourceLead(), [
    ...existing, { id: "33333333-3333-4333-8333-333333333333", canonicalPhone: "919687878669" },
  ]), { kind: "review_required", reason: "ambiguous_phone" });
  assert.deepEqual(classifyLegacyLeadReference(sourceLead({ id: existing[0].id }), existing), {
    kind: "review_required", reason: "identifier_collision_candidate",
  });
  assert.deepEqual(classifyLegacyLeadReference(sourceLead({ phone: "invalid" }), []), {
    kind: "review_required", reason: "invalid_phone",
  });
  assert.deepEqual(classifyLegacyLeadReference(sourceLead(), existing, {
    leadId: "44444444-4444-4444-8444-444444444444", matchStatus: "linked",
  }), { kind: "already_linked" });
});

test("legacy import planner is read-only and refuses every data-copy apply attempt", () => {
  assert.equal(assertLegacyImportApplyGate(false), undefined);
  assert.throws(() => assertLegacyImportApplyGate(true), /legacy_import_disabled_two_database_architecture/);
});
