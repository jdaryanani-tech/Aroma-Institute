import { normalizeIndianMobile } from "@shared/indian-mobile";

export type SupabaseLegacyLead = {
  id: string;
  phone: string | null;
  name: string | null;
  created_at: string | Date | null;
  lead_type: string | null;
  intent: string | null;
  city: string | null;
  experience: string | null;
  cafe_plan: string | null;
  timeline: string | null;
  lead_score: number | null;
  appointment_status: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  conversation_status: string | null;
  last_message_at: string | Date | null;
};
export type ExistingLead = { id: string; canonicalPhone: string };
export type LegacyLeadDecision =
  | { kind: "exact_id"; targetLeadId: string }
  | { kind: "insert"; targetLeadId: string }
  | { kind: "review"; reason: "unique_phone_candidate" | "ambiguous_phone" | "invalid_phone" | "id_phone_conflict"; candidateCount: number }
  | { kind: "linked"; targetLeadId: string }
  | { kind: "held"; reason: string };

export function classifyLegacyLead(
  source: SupabaseLegacyLead,
  existing: ExistingLead[],
  crosswalk?: { leadId: string | null; matchStatus: string } | null,
): LegacyLeadDecision {
  if (crosswalk) {
    if (crosswalk.matchStatus === "linked" && crosswalk.leadId) return { kind: "linked", targetLeadId: crosswalk.leadId };
    return { kind: "held", reason: "existing_crosswalk_requires_review" };
  }
  const phone = source.phone ? normalizeIndianMobile(source.phone) : null;
  if (!phone) return { kind: "review", reason: "invalid_phone", candidateCount: 0 };
  const exactId = existing.find((target) => target.id === source.id);
  if (exactId) {
    return exactId.canonicalPhone === phone
      ? { kind: "exact_id", targetLeadId: exactId.id }
      : { kind: "review", reason: "id_phone_conflict", candidateCount: 1 };
  }
  const candidates = existing.filter((target) => normalizeIndianMobile(target.canonicalPhone) === phone);
  if (candidates.length === 1) return { kind: "review", reason: "unique_phone_candidate", candidateCount: 1 };
  if (candidates.length > 1) return { kind: "review", reason: "ambiguous_phone", candidateCount: candidates.length };
  return { kind: "insert", targetLeadId: source.id };
}

export function legacyLeadProfile(source: SupabaseLegacyLead): Record<string, unknown> {
  return {
    sourceCreatedAt: source.created_at ?? null,
    leadType: source.lead_type,
    intent: source.intent,
    city: source.city,
    experience: source.experience,
    cafePlan: source.cafe_plan,
    timeline: source.timeline,
    leadScore: source.lead_score,
    appointmentStatus: source.appointment_status,
    appointmentDate: source.appointment_date,
    appointmentTime: source.appointment_time,
    conversationStatus: source.conversation_status,
    lastMessageAt: source.last_message_at ?? null,
  };
}

export type LegacyConversation = {
  id: string;
  lead_id: string;
  phone: string;
  direction: string;
  message: string | null;
  message_type: string | null;
  ai_response: string | null;
  created_at: string | Date;
};

export type ImportedMessagePlan = {
  sourceSystem: "supabase_aichm";
  sourceRecordId: string;
  sourceMessageSide: "message" | "ai_response";
  idempotencyKey: string;
  direction: "inbound" | "outbound";
  body: string;
  deliveryState: "received" | "unknown";
  occurredAt: Date;
  canonicalPhone: string;
};

export function planLegacyConversation(
  row: LegacyConversation,
  canonicalPhone: string,
): { messages: ImportedMessagePlan[]; error: "unrecognized_direction" | "missing_phone" | null } {
  const phone = normalizeIndianMobile(canonicalPhone);
  if (!phone) return { messages: [], error: "missing_phone" };
  const direction = new Map<string, "inbound" | "outbound">([
    ["inbound", "inbound"], ["incoming", "inbound"], ["user", "inbound"],
    ["outbound", "outbound"], ["outgoing", "outbound"], ["assistant", "outbound"],
  ]).get(row.direction.trim().toLowerCase());
  if (!direction && row.message?.trim()) return { messages: [], error: "unrecognized_direction" };
  const occurredAt = new Date(row.created_at);
  if (!Number.isFinite(occurredAt.getTime())) return { messages: [], error: "missing_phone" };
  const messages: ImportedMessagePlan[] = [];
  if (row.message?.trim()) messages.push({
    sourceSystem: "supabase_aichm", sourceRecordId: row.id, sourceMessageSide: "message",
    idempotencyKey: `supabase_aichm:${row.id}:message`, direction: direction!, body: row.message,
    deliveryState: direction === "inbound" ? "received" : "unknown", occurredAt, canonicalPhone: phone,
  });
  if (row.ai_response?.trim()) messages.push({
    sourceSystem: "supabase_aichm", sourceRecordId: row.id, sourceMessageSide: "ai_response",
    idempotencyKey: `supabase_aichm:${row.id}:ai_response`, direction: "outbound",
    body: row.ai_response, deliveryState: "unknown", occurredAt, canonicalPhone: phone,
  });
  return { messages, error: null };
}

export type LegacyKnowledge = {
  id: string;
  slug: string;
  category: string;
  question: string | null;
  answer: string;
  keywords: string[] | null;
  status: string;
  priority: number;
  metadata: Record<string, unknown> | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

export function planLegacyKnowledge(row: LegacyKnowledge) {
  return {
    id: row.id,
    sourceSystem: "supabase_aichm",
    sourceRecordId: row.id,
    slug: row.slug,
    category: row.category,
    question: row.question,
    answer: row.answer,
    keywords: row.keywords ?? [],
    status: row.status,
    priority: row.priority,
    metadata: row.metadata ?? {},
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

export type LegacyImportCounts = {
  source: { leads: number; conversations: number; courseKnowledge: number };
  target: { leads: number; messages: number; courseKnowledge: number };
  leads: { insert: number; exactIdSkip: number; linkedSkip: number; review: number; held: number };
  conversations: { plannedMessages: number; alreadyImported: number; blockedByLeadReview: number; validationErrors: number };
  courseKnowledge: { insert: number; sourceIdSkip: number; slugConflict: number };
};

/** Public report contract contains aggregate counts only; caller must not add row content. */
export function emptyLegacyImportCounts(): LegacyImportCounts {
  return {
    source: { leads: 0, conversations: 0, courseKnowledge: 0 },
    target: { leads: 0, messages: 0, courseKnowledge: 0 },
    leads: { insert: 0, exactIdSkip: 0, linkedSkip: 0, review: 0, held: 0 },
    conversations: { plannedMessages: 0, alreadyImported: 0, blockedByLeadReview: 0, validationErrors: 0 },
    courseKnowledge: { insert: 0, sourceIdSkip: 0, slugConflict: 0 },
  };
}
