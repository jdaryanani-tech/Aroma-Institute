import { createHash } from "node:crypto";
import { z } from "zod";

const opaqueReference = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "Reference must be an opaque identifier.");
const providerName = z.string().trim().min(1).max(40)
  .regex(/^[a-z][a-z0-9_-]*$/, "Provider must be a stable lowercase name.");
const appMediaReference = z.string()
  .regex(/^media:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const messageType = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "interactive",
  "location",
  "unknown",
]);
export const AVNI_DELIVERY_STATES = [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "unknown",
] as const;
export type AvniDeliveryState = typeof AVNI_DELIVERY_STATES[number];
export const providerReferenceTokenSchema = z.string()
  .regex(/^hmac-sha256:v1:[0-9a-f]{64}$/, "Provider references must be HMAC-tokenized by the server.");
export type ProviderReferenceToken = z.infer<typeof providerReferenceTokenSchema>;

const messageEventSchema = z.object({
  contractVersion: z.literal(1),
  provider: providerName,
  providerEventRef: opaqueReference,
  threadRef: opaqueReference,
  occurredAt: z.string().datetime({ offset: true }),
  kind: z.literal("message"),
  providerMessageRef: opaqueReference,
  direction: z.enum(["inbound", "outbound"]),
  author: z.enum(["prospect", "assistant", "human_staff", "system", "unknown"]),
  messageType,
  text: z.string().max(12_000).optional(),
  mediaRef: appMediaReference.optional(),
}).strict().superRefine((event, context) => {
  if (event.messageType === "text" && !event.text?.trim()) {
    context.addIssue({ code: "custom", path: ["text"], message: "Text messages require non-empty text." });
  }
  if (
    (event.direction === "inbound" && !["prospect", "unknown"].includes(event.author)) ||
    (event.direction === "outbound" && event.author === "prospect")
  ) {
    context.addIssue({ code: "custom", path: ["author"], message: "Author and direction are inconsistent." });
  }
});

const deliveryEventSchema = z.object({
  contractVersion: z.literal(1),
  provider: providerName,
  providerEventRef: opaqueReference,
  threadRef: opaqueReference,
  occurredAt: z.string().datetime({ offset: true }),
  kind: z.literal("delivery"),
  providerMessageRef: opaqueReference,
  deliveryState: z.enum(AVNI_DELIVERY_STATES),
  rawProviderReceiptValue: z.string().trim().min(1).max(100)
    .regex(/^[A-Za-z0-9_.:-]{1,100}$/).optional(),
}).strict();

export const avniConversationEventSchema = z.union([
  messageEventSchema,
  deliveryEventSchema,
]);

export type AvniConversationEvent = z.infer<typeof avniConversationEventSchema>;
export type ConversationControlState = {
  version: number;
  mode: "ai" | "human";
  lifecycle: "open" | "closed";
  consentStatus: "granted" | "not_provided" | "revoked" | "unknown";
  optedOut: boolean;
};
export type ThreadMappingStatus = "unique" | "unknown" | "ambiguous";

export const conversationControlStateSchema = z.object({
  version: z.number().int().nonnegative(),
  mode: z.enum(["ai", "human"]),
  lifecycle: z.enum(["open", "closed"]),
  consentStatus: z.enum(["granted", "not_provided", "revoked", "unknown"]),
  optedOut: z.boolean(),
}).strict();

export function validateConversationControlState(input: unknown):
  | { success: true; state: ConversationControlState }
  | { success: false; code: "invalid_conversation_control_state" } {
  const parsed = conversationControlStateSchema.safeParse(input);
  return parsed.success
    ? { success: true, state: parsed.data }
    : { success: false, code: "invalid_conversation_control_state" };
}

export function validateAvniConversationEvent(input: unknown):
  | { success: true; event: AvniConversationEvent }
  | { success: false; code: "invalid_conversation_event" } {
  const parsed = avniConversationEventSchema.safeParse(input);
  return parsed.success
    ? { success: true, event: parsed.data }
    : { success: false, code: "invalid_conversation_event" };
}

export type ConversationEventClass =
  | "inbound_prospect_message"
  | "outbound_ai_message"
  | "outbound_human_message"
  | "outbound_system_message"
  | "other_message"
  | "delivery_update";

export function classifyConversationEvent(event: AvniConversationEvent): ConversationEventClass {
  if (event.kind === "delivery") return "delivery_update";
  if (event.direction === "inbound" && event.author === "prospect") return "inbound_prospect_message";
  if (event.direction === "outbound" && event.author === "assistant") return "outbound_ai_message";
  if (event.direction === "outbound" && event.author === "human_staff") return "outbound_human_message";
  if (event.direction === "outbound" && event.author === "system") return "outbound_system_message";
  return "other_message";
}

function tokenDigest(token: ProviderReferenceToken): string {
  const parsed = providerReferenceTokenSchema.safeParse(token);
  if (!parsed.success) throw new Error("INVALID_PROVIDER_REFERENCE_TOKEN");
  return token.slice("hmac-sha256:v1:".length);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Consumes a server-HMACed, domain-separated event reference; it never hashes raw provider input. */
export function conversationEventIdempotencyKey(token: ProviderReferenceToken): string {
  return `event:v1:${tokenDigest(token)}`;
}

/** Consumes a server-HMACed, domain-separated message reference. */
export function conversationMessageIdempotencyKey(token: ProviderReferenceToken): string {
  return `message:v1:${tokenDigest(token)}`;
}

export function conversationEventFingerprint(event: AvniConversationEvent): string {
  if (event.kind === "delivery") {
    return sha256(JSON.stringify([
      event.contractVersion, event.provider, event.occurredAt, event.kind, event.deliveryState,
      event.rawProviderReceiptValue ?? null,
    ]));
  }
  return sha256(JSON.stringify([
    event.contractVersion, event.provider, event.occurredAt, event.kind, event.direction,
    event.author, event.messageType, event.text ?? null, event.mediaRef ?? null,
  ]));
}

export function conversationMessageFingerprint(event: Extract<AvniConversationEvent, { kind: "message" }>): string {
  return sha256(JSON.stringify([
    event.provider, event.occurredAt, event.direction, event.author,
    event.messageType, event.text ?? null, event.mediaRef ?? null,
  ]));
}

const deliveryStateTransitions: Record<AvniDeliveryState, ReadonlySet<AvniDeliveryState>> = {
  queued: new Set<AvniDeliveryState>(["sent", "delivered", "read", "failed"]),
  sent: new Set<AvniDeliveryState>(["delivered", "read", "failed"]),
  delivered: new Set<AvniDeliveryState>(["read"]),
  read: new Set<AvniDeliveryState>(),
  failed: new Set<AvniDeliveryState>(),
  // Unknown is an in-flight outcome, never a retry signal. A later provider
  // receipt may resolve it; a new retry must use a distinct attempt.
  unknown: new Set<AvniDeliveryState>(["sent", "delivered", "read", "failed"]),
};

/** Monotonic within one provider send attempt. Retries receive a new attempt row. */
export function advanceDeliveryState(
  current: AvniDeliveryState | null,
  incoming: AvniDeliveryState,
): { state: AvniDeliveryState; changed: boolean; regressionIgnored: boolean } {
  if (current === null) return { state: incoming, changed: true, regressionIgnored: false };
  if (current === incoming) return { state: current, changed: false, regressionIgnored: false };
  if (deliveryStateTransitions[current].has(incoming)) {
    return { state: incoming, changed: true, regressionIgnored: false };
  }
  return { state: current, changed: false, regressionIgnored: true };
}

export type AiReplyEligibilityCode =
  | "eligible"
  | "not_inbound_prospect_message"
  | "thread_mapping_unknown"
  | "thread_mapping_ambiguous"
  | "conversation_closed"
  | "whatsapp_opted_out"
  | "whatsapp_consent_not_granted"
  | "human_takeover_active";

function evaluateControlEligibility(input: {
  mapping: ThreadMappingStatus;
  state: ConversationControlState;
}): { eligible: boolean; code: AiReplyEligibilityCode } {
  if (input.mapping === "unknown") return { eligible: false, code: "thread_mapping_unknown" };
  if (input.mapping === "ambiguous") return { eligible: false, code: "thread_mapping_ambiguous" };
  if (input.state.lifecycle !== "open") return { eligible: false, code: "conversation_closed" };
  if (input.state.optedOut) return { eligible: false, code: "whatsapp_opted_out" };
  if (input.state.mode === "human") return { eligible: false, code: "human_takeover_active" };
  if (input.state.consentStatus !== "granted") {
    return { eligible: false, code: "whatsapp_consent_not_granted" };
  }
  return { eligible: true, code: "eligible" };
}

export function evaluateAiReplyEligibility(input: {
  event: AvniConversationEvent;
  mapping: ThreadMappingStatus;
  state: ConversationControlState;
}): { eligible: boolean; code: AiReplyEligibilityCode } {
  if (classifyConversationEvent(input.event) !== "inbound_prospect_message") {
    return { eligible: false, code: "not_inbound_prospect_message" };
  }
  return evaluateControlEligibility({ mapping: input.mapping, state: input.state });
}

export type AiReplyQueueItem = {
  expectedConversationVersion: number;
};

export type AiQueueEligibilityCode = AiReplyEligibilityCode | "stale_conversation_version";

/** Rechecks all safety gates at dispatch time; a takeover/resume version change invalidates old work. */
export function evaluateAiQueueItem(input: {
  item: AiReplyQueueItem;
  mapping: ThreadMappingStatus;
  state: ConversationControlState;
}): { eligible: boolean; code: AiQueueEligibilityCode } {
  if (input.item.expectedConversationVersion !== input.state.version) {
    return { eligible: false, code: "stale_conversation_version" };
  }
  // A queued response cannot bypass a later consent change, opt-out, mapping
  // issue, lifecycle close, or human takeover.
  return evaluateControlEligibility({ mapping: input.mapping, state: input.state });
}

export type ConversationControlAction =
  | { type: "takeover"; expectedVersion: number; authorizedStaff: boolean }
  | { type: "resume"; expectedVersion: number; authorizedStaff: boolean };

export type ConversationControlTransition =
  | { changed: true; state: ConversationControlState }
  | {
    changed: false;
    code:
      | "staff_authorization_required"
      | "conversation_version_conflict"
      | "conversation_closed"
      | "already_human_owned"
      | "conversation_not_human_owned"
      | "whatsapp_opted_out"
      | "whatsapp_consent_not_granted";
  };

/** Pure compare-and-swap state transition. Callers must derive authorization server-side. */
export function transitionConversationControl(
  state: ConversationControlState,
  action: ConversationControlAction,
): ConversationControlTransition {
  if (!action.authorizedStaff) return { changed: false, code: "staff_authorization_required" };
  if (action.expectedVersion !== state.version) {
    return { changed: false, code: "conversation_version_conflict" };
  }
  if (state.lifecycle !== "open") return { changed: false, code: "conversation_closed" };

  if (action.type === "takeover") {
    if (state.mode === "human") return { changed: false, code: "already_human_owned" };
    return { changed: true, state: { ...state, mode: "human", version: state.version + 1 } };
  }

  if (state.mode !== "human") return { changed: false, code: "conversation_not_human_owned" };
  if (state.optedOut) return { changed: false, code: "whatsapp_opted_out" };
  if (state.consentStatus !== "granted") {
    return { changed: false, code: "whatsapp_consent_not_granted" };
  }
  return { changed: true, state: { ...state, mode: "ai", version: state.version + 1 } };
}
