import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const AVNI_DISPATCH_GRANT_TTL_MS = 30_000;

export type DispatchConsentSnapshot = {
  consentEpoch: number;
  consentStatus: "granted" | "not_provided" | "opted_out";
  optedOutAt: string | null;
};

export type AvniDispatchGrantBinding = {
  canonicalLeadId: string;
  supabaseThreadId: string;
  supabaseOutboxId: string;
  supabaseMessageId: string;
  supabaseAttemptId: string;
  messageIdempotencyKey: string;
  consentEpoch: number;
  controlVersion: number;
  attemptNumber: number;
  leaseTokenHash: string;
  payloadHash: string;
};

export type AvniDispatchGrantState =
  | "issued"
  | "in_flight"
  | "accepted"
  | "failed"
  | "unknown"
  | "revoked"
  | "expired"
  | "aborted";

export type AvniDispatchGrant = {
  id: string;
  idempotencyKey: string;
  binding: AvniDispatchGrantBinding;
  state: AvniDispatchGrantState;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  completedAt: string | null;
  safeOutcome:
    | "provider_accepted"
    | "definite_failure"
    | "ambiguous_result"
    | "send_denied"
    | "authorization_expired"
    | null;
};

const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const bindingSchema = z.object({
  canonicalLeadId: uuid,
  supabaseThreadId: uuid,
  supabaseOutboxId: uuid,
  supabaseMessageId: uuid,
  supabaseAttemptId: uuid,
  messageIdempotencyKey: z.string().regex(/^message:v1:[0-9a-f]{64}$/),
  consentEpoch: z.number().int().nonnegative().safe(),
  controlVersion: z.number().int().nonnegative().safe(),
  attemptNumber: z.number().int().min(1).max(8),
  leaseTokenHash: digest,
  payloadHash: digest,
}).strict();

const consentSchema = z.object({
  consentEpoch: z.number().int().nonnegative().safe(),
  consentStatus: z.enum(["granted", "not_provided", "opted_out"]),
  optedOutAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type SupabaseBeginSendOutcome = "begun" | "denied" | "already_begun" | "unavailable";
export type DispatchGrantDecisionCode =
  | "grant_issued"
  | "grant_duplicate"
  | "grant_ready"
  | "grant_idempotency_conflict"
  | "grant_expired"
  | "grant_revoked"
  | "grant_replayed"
  | "grant_binding_mismatch"
  | "supabase_begin_denied"
  | "supabase_begin_uncertain"
  | "begin_send_started";

export type DispatchGrantDecision = {
  allowedToBeginSend: boolean;
  providerCallAllowed: false;
  code: DispatchGrantDecisionCode;
  grant: AvniDispatchGrant | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableBinding(binding: AvniDispatchGrantBinding): string {
  return JSON.stringify([
    binding.canonicalLeadId,
    binding.supabaseThreadId,
    binding.supabaseOutboxId,
    binding.supabaseMessageId,
    binding.supabaseAttemptId,
    binding.messageIdempotencyKey,
    binding.consentEpoch,
    binding.controlVersion,
    binding.attemptNumber,
    binding.leaseTokenHash,
    binding.payloadHash,
  ]);
}

export function dispatchGrantIdempotencyKey(binding: AvniDispatchGrantBinding): string {
  const parsed = bindingSchema.parse(binding);
  return `dispatch:v1:${sha256(stableBinding(parsed))}`;
}

function sameBinding(a: AvniDispatchGrantBinding, b: AvniDispatchGrantBinding): boolean {
  return stableBinding(a) === stableBinding(b);
}

function grantResult(
  code: DispatchGrantDecisionCode,
  grant: AvniDispatchGrant | null,
  allowedToBeginSend = false,
): DispatchGrantDecision {
  return { allowedToBeginSend, providerCallAllowed: false, code, grant };
}

/**
 * Creates or replays a deterministic, short-lived grant record.
 * A duplicate with identical binding returns the existing grant; it does not
 * create a second grant or authorize a second use.
 */
export function issueAvniDispatchGrant(input: {
  binding: AvniDispatchGrantBinding;
  consent: DispatchConsentSnapshot;
  now?: Date;
  ttlMs?: number;
  grantId?: string;
  existing?: AvniDispatchGrant | null;
}): DispatchGrantDecision {
  const binding = bindingSchema.parse(input.binding);
  const consent = consentSchema.parse(input.consent);
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? AVNI_DISPATCH_GRANT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > AVNI_DISPATCH_GRANT_TTL_MS) {
    throw new Error("AVNI_DISPATCH_GRANT_TTL_INVALID");
  }
  if (consent.consentStatus !== "granted" || consent.optedOutAt !== null
    || consent.consentEpoch !== binding.consentEpoch) {
    return grantResult("grant_revoked", null);
  }

  const idempotencyKey = dispatchGrantIdempotencyKey(binding);
  if (input.existing) {
    if (input.existing.idempotencyKey !== idempotencyKey
      || !sameBinding(input.existing.binding, binding)) {
      return grantResult("grant_idempotency_conflict", input.existing);
    }
    return grantResult("grant_duplicate", input.existing);
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return grantResult("grant_issued", {
    id: uuid.parse(input.grantId ?? randomUUID()),
    idempotencyKey,
    binding,
    state: "issued",
    createdAt,
    expiresAt,
    redeemedAt: null,
    completedAt: null,
    safeOutcome: null,
  });
}

export function validateAvniDispatchGrantForBegin(input: {
  grant: AvniDispatchGrant;
  binding: AvniDispatchGrantBinding;
  consent: DispatchConsentSnapshot;
  now?: Date;
}): DispatchGrantDecision {
  const binding = bindingSchema.parse(input.binding);
  const consent = consentSchema.parse(input.consent);
  const now = input.now ?? new Date();
  const grant = input.grant;
  if (grant.state !== "issued") return grantResult("grant_replayed", grant);
  if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return grantResult("grant_expired", {
      ...grant, state: "expired", completedAt: now.toISOString(), safeOutcome: "authorization_expired",
    });
  }
  if (grant.idempotencyKey !== dispatchGrantIdempotencyKey(binding)
    || !sameBinding(grant.binding, binding)) {
    return grantResult("grant_binding_mismatch", {
      ...grant, state: "aborted", completedAt: now.toISOString(), safeOutcome: "send_denied",
    });
  }
  if (consent.consentStatus !== "granted" || consent.optedOutAt !== null
    || consent.consentEpoch !== grant.binding.consentEpoch) {
    return grantResult("grant_revoked", {
      ...grant, state: "revoked", completedAt: now.toISOString(), safeOutcome: "send_denied",
    });
  }
  return grantResult("grant_ready", grant, true);
}

/**
 * Models the final Replit-consent + Supabase begin_send boundary. Callers must
 * hold the Replit preference/ledger transaction lock while evaluating this.
 * A successful result only records an in-flight reservation; it never sends.
 */
export function beginAvniDispatchAttempt(input: {
  grant: AvniDispatchGrant;
  binding: AvniDispatchGrantBinding;
  consent: DispatchConsentSnapshot;
  now?: Date;
  supabaseOutcome: SupabaseBeginSendOutcome;
}): DispatchGrantDecision {
  const binding = bindingSchema.parse(input.binding);
  const consent = consentSchema.parse(input.consent);
  const now = input.now ?? new Date();
  const grant = input.grant;
  const validation = validateAvniDispatchGrantForBegin({ grant, binding, consent, now });
  if (!validation.allowedToBeginSend) return validation;
  if (input.supabaseOutcome === "denied") {
    return grantResult("supabase_begin_denied", {
      ...grant, state: "aborted", completedAt: now.toISOString(), safeOutcome: "send_denied",
    });
  }
  if (input.supabaseOutcome !== "begun") {
    // A timeout may have followed a committed Supabase begin_send. Never replay
    // the provider call on an ambiguous cross-database result.
    return grantResult("supabase_begin_uncertain", {
      ...grant, state: "unknown", completedAt: now.toISOString(), safeOutcome: "ambiguous_result",
    });
  }
  return grantResult("begin_send_started", {
    ...grant, state: "in_flight", redeemedAt: now.toISOString(),
  }, true);
}

export function settleAvniDispatchGrant(
  grant: AvniDispatchGrant,
  providerOutcome: "provider_accepted" | "definite_failure" | "ambiguous_result",
  now = new Date(),
): AvniDispatchGrant {
  if (grant.state !== "in_flight") throw new Error("AVNI_DISPATCH_GRANT_NOT_IN_FLIGHT");
  const state: AvniDispatchGrantState = providerOutcome === "provider_accepted"
    ? "accepted"
    : providerOutcome === "definite_failure"
      ? "failed"
      : "unknown";
  return { ...grant, state, completedAt: now.toISOString(), safeOutcome: providerOutcome };
}

export function applyEffectiveConsentChange(input: {
  canonicalLeadId: string;
  previous: DispatchConsentSnapshot;
  next: Omit<DispatchConsentSnapshot, "consentEpoch">;
  grants: readonly AvniDispatchGrant[];
  now?: Date;
}): {
  consent: DispatchConsentSnapshot;
  grants: AvniDispatchGrant[];
  changed: boolean;
} {
  const previous = consentSchema.parse(input.previous);
  const next = consentSchema.omit({ consentEpoch: true }).parse(input.next);
  const previousAllowed = previous.consentStatus === "granted" && previous.optedOutAt === null;
  const nextAllowed = next.consentStatus === "granted" && next.optedOutAt === null;
  const previousOptedOut = previous.consentStatus === "opted_out" || previous.optedOutAt !== null;
  const nextOptedOut = next.consentStatus === "opted_out" || next.optedOutAt !== null;
  const changed = previousAllowed !== nextAllowed || previousOptedOut !== nextOptedOut;
  const consent = {
    ...next,
    consentEpoch: previous.consentEpoch + (changed ? 1 : 0),
  };
  const now = (input.now ?? new Date()).toISOString();
  return {
    consent,
    grants: input.grants.map(grant => changed
      && grant.binding.canonicalLeadId === input.canonicalLeadId
      && grant.state === "issued"
      ? { ...grant, state: "revoked", completedAt: now, safeOutcome: "send_denied" }
      : grant),
    changed,
  };
}
