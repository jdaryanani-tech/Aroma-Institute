import { normalizeIndianMobile } from "@shared/indian-mobile";

/**
 * Minimal source shape used only for aggregate identity reconciliation.
 * Transcript and course-knowledge payloads are deliberately not modeled here:
 * they remain authoritative in Supabase and are never copied to Replit.
 */
export type SupabaseLegacyLeadReference = {
  id: string;
  phone: string | null;
};

export type ExistingLeadReference = { id: string; canonicalPhone: string };
export type LegacyLeadReferenceDecision =
  | { kind: "already_linked" }
  | { kind: "unmatched"; reason: "no_candidate" }
  | { kind: "review_required"; reason: "saved_crosswalk_not_linked" | "invalid_phone" | "identifier_collision_candidate" | "unique_phone_candidate" | "ambiguous_phone" };

export function classifyLegacyLeadReference(
  source: SupabaseLegacyLeadReference,
  existing: ExistingLeadReference[],
  existingLink?: { leadId: string | null; matchStatus: string },
): LegacyLeadReferenceDecision {
  if (existingLink) {
    return existingLink.matchStatus === "linked" && existingLink.leadId
      ? { kind: "already_linked" }
      : { kind: "review_required", reason: "saved_crosswalk_not_linked" };
  }
  const phone = source.phone ? normalizeIndianMobile(source.phone) : null;
  if (!phone) return { kind: "review_required", reason: "invalid_phone" };
  if (existing.some((lead) => lead.id === source.id)) {
    return { kind: "review_required", reason: "identifier_collision_candidate" };
  }
  const candidates = existing.filter((lead) => normalizeIndianMobile(lead.canonicalPhone) === phone);
  if (candidates.length > 1) return { kind: "review_required", reason: "ambiguous_phone" };
  if (candidates.length === 1) return { kind: "review_required", reason: "unique_phone_candidate" };
  return { kind: "unmatched", reason: "no_candidate" };
}

export function assertLegacyImportApplyGate(apply = false) {
  if (apply) throw new Error("legacy_import_disabled_two_database_architecture");
}
