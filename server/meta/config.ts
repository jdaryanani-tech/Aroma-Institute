import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { inspectIndianMobile } from "@shared/indian-mobile";

export const META_CONFIG_NAMES = {
  pixel: ["META_PIXEL_ID"],
  capi: ["META_PIXEL_ID", "META_CAPI_ACCESS_TOKEN", "META_GRAPH_API_VERSION"],
  leadAds: [
    "META_APP_ID",
    "META_APP_SECRET",
    "META_WEBHOOK_VERIFY_TOKEN",
    "META_PAGE_ID",
    "META_PAGE_ACCESS_TOKEN",
    "META_GRAPH_API_VERSION",
    "META_ALLOWED_FORM_IDS",
  ],
} as const;

export const META_CONSENT_POLICY_VERSION = "meta-measurement-v1";
export const META_CAPI_ENABLED_ENV = "META_CAPI_ENABLED";

export type MetaEnvironment = Record<string, string | undefined>;

const META_FORM_ID = /^[0-9]{1,40}$/;

/**
 * Parse the server-side allowlist for real-time Lead Ads intake. Invalid,
 * absent, empty, or duplicate entries fail closed and are never echoed.
 */
export function parseMetaAllowedFormIds(value: string | undefined): ReadonlySet<string> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ids = value.split(",").map((id) => id.trim());
  if (
    ids.length === 0 ||
    ids.some((id) => !META_FORM_ID.test(id)) ||
    new Set(ids).size !== ids.length
  ) return null;
  return new Set(ids);
}

function missing(names: readonly string[], env: MetaEnvironment) {
  return names.filter((name) => !env[name]?.trim());
}

export function getMetaReadiness(env: MetaEnvironment = process.env) {
  const pixelMissing = missing(META_CONFIG_NAMES.pixel, env);
  const capiMissing = missing(META_CONFIG_NAMES.capi, env);
  const leadAdsMissing = missing(META_CONFIG_NAMES.leadAds, env);
  if (!parseMetaAllowedFormIds(env.META_ALLOWED_FORM_IDS) &&
      !leadAdsMissing.includes("META_ALLOWED_FORM_IDS")) {
    leadAdsMissing.push("META_ALLOWED_FORM_IDS");
  }
  const graphVersion = env.META_GRAPH_API_VERSION?.trim() ?? "";
  const graphVersionValid = /^v\d+\.\d+$/.test(graphVersion);
  if (!graphVersionValid) {
    if (!capiMissing.includes("META_GRAPH_API_VERSION")) capiMissing.push("META_GRAPH_API_VERSION");
    if (!leadAdsMissing.includes("META_GRAPH_API_VERSION")) leadAdsMissing.push("META_GRAPH_API_VERSION");
  }
  return {
    pixel: { configured: pixelMissing.length === 0, missing: pixelMissing },
    capi: {
      configured: capiMissing.length === 0,
      enabled: env.NODE_ENV === "production"
        && env[META_CAPI_ENABLED_ENV] === "true"
        && capiMissing.length === 0,
      missing: capiMissing,
      enableFlag: META_CAPI_ENABLED_ENV,
      enableFlagSet: env[META_CAPI_ENABLED_ENV] === "true",
    },
    leadAds: { configured: leadAdsMissing.length === 0, missing: leadAdsMissing },
  };
}

export function hasValidMetaConsent(status: string | null | undefined, version: string | null | undefined) {
  return status === "granted" && version === META_CONSENT_POLICY_VERSION;
}

export function isPublicAdmissionsPath(pathname: string) {
  return pathname === "/" || pathname === "/vsl" || pathname === "/vsl-video" || pathname === "/counselling";
}

const PHONE_FIELD_PRECEDENCE = ["phone_number", "mobile_phone", "whatsapp_number"] as const;
type MetaPhoneField = typeof PHONE_FIELD_PRECEDENCE[number];
type MetaPhoneFieldState = "missing" | "blank" | "populated";
type MappedMetaFields = {
  name: string;
  email: string;
  phone: string;
  programInterest: string;
};

export type MetaPhoneIdentityDiagnostics = {
  fieldStates: Record<MetaPhoneField, MetaPhoneFieldState>;
  normalizationOutcome:
    | "valid"
    | "no_phone_field"
    | "phone_fields_blank"
    | "invalid_characters"
    | "invalid_length"
    | "invalid_mobile_prefix";
  selectedField: MetaPhoneField | null;
  fallbackAttempted: boolean;
  invalidHigherPriorityBlockedFallback: boolean;
};

const DEFAULT_META_FIELDS: MappedMetaFields = {
  name: "",
  email: "",
  phone: "",
  programInterest: "Meta Instant Form Enquiry",
};

function parseMetaFieldData(input: unknown): {
  mapped: MappedMetaFields;
  phoneIdentityDiagnostics: MetaPhoneIdentityDiagnostics;
} {
  const result: Record<string, string> = {};
  const phoneFieldSeen = new Set<MetaPhoneField>();
  const phoneFieldPopulated = new Set<MetaPhoneField>();
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { name?: unknown; values?: unknown };
    if (typeof entry.name !== "string" || !Array.isArray(entry.values)) continue;
    const key = entry.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if ((PHONE_FIELD_PRECEDENCE as readonly string[]).includes(key)) {
      phoneFieldSeen.add(key as MetaPhoneField);
    }
    const value = entry.values.find((v) => typeof v === "string" && v.trim());
    if (typeof value !== "string") continue;
    if (["full_name", "name", "first_name", "last_name", "email", "phone_number", "mobile_phone", "whatsapp_number", "program_interest", "course"].includes(key)) {
      result[key] = value.trim().slice(0, 500);
      if ((PHONE_FIELD_PRECEDENCE as readonly string[]).includes(key)) {
        phoneFieldPopulated.add(key as MetaPhoneField);
      }
    }
  }
  const name = result.full_name ?? result.name
    ?? [result.first_name, result.last_name].filter(Boolean).join(" ");
  // Preserve the existing phone_number > mobile_phone order, then accept the
  // global WhatsApp-number alias. Blank entries are omitted above, so they
  // fall through; a nonblank value is selected before validation, meaning an
  // invalid higher-priority value cannot silently fall back to another number.
  const phone = result.phone_number ?? result.mobile_phone ?? result.whatsapp_number ?? "";
  const selectedField = PHONE_FIELD_PRECEDENCE.find((field) => result[field] !== undefined) ?? null;
  const fieldStates = Object.fromEntries(PHONE_FIELD_PRECEDENCE.map((field) => [
    field,
    phoneFieldPopulated.has(field) ? "populated" : phoneFieldSeen.has(field) ? "blank" : "missing",
  ])) as Record<MetaPhoneField, MetaPhoneFieldState>;
  const normalized = selectedField ? inspectIndianMobile(phone.slice(0, 32)) : null;
  const selectedIndex = selectedField ? PHONE_FIELD_PRECEDENCE.indexOf(selectedField) : -1;
  const invalidHigherPriorityBlockedFallback = Boolean(
    selectedField &&
      normalized?.canonical === null &&
      PHONE_FIELD_PRECEDENCE.slice(selectedIndex + 1).some((field) => fieldStates[field] === "populated"),
  );
  return {
    mapped: {
      name: name?.slice(0, 120) ?? "",
      email: (result.email ?? "").slice(0, 320),
      phone: phone.slice(0, 32),
      programInterest: (result.program_interest ?? result.course ?? "Meta Instant Form Enquiry").slice(0, 200),
    },
    phoneIdentityDiagnostics: {
      fieldStates,
      normalizationOutcome: normalized?.outcome ?? (
        PHONE_FIELD_PRECEDENCE.every((field) => fieldStates[field] === "missing")
          ? "no_phone_field"
          : "phone_fields_blank"
      ),
      selectedField,
      fallbackAttempted: selectedIndex > 0,
      invalidHigherPriorityBlockedFallback,
    },
  };
}

export function normalizeMetaFieldData(input: unknown): MappedMetaFields {
  return parseMetaFieldData(input).mapped;
}

export function normalizeMetaFieldDataWithDiagnostics(input: unknown) {
  return parseMetaFieldData(input);
}

export function isValidMetaChallenge(mode: unknown, challenge: unknown, suppliedToken: string, expectedToken: string | undefined) {
  if (mode !== "subscribe" || typeof challenge !== "string" || !challenge || challenge.length > 512 || !expectedToken?.trim()) return false;
  const left = createHash("sha256").update(suppliedToken).digest();
  const right = createHash("sha256").update(expectedToken.trim()).digest();
  return timingSafeEqual(left, right);
}

export function verifyMetaWebhookSignature(rawBody: unknown, signature: string, appSecret: string | undefined) {
  if (!Buffer.isBuffer(rawBody) || !appSecret?.trim() || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", appSecret.trim()).update(rawBody).digest("hex")}`;
  const left = createHash("sha256").update(signature.toLowerCase()).digest();
  const right = createHash("sha256").update(expected.toLowerCase()).digest();
  return timingSafeEqual(left, right);
}

const allowedCustomFields = new Set(["funnel_step", "milestone", "observed_percent"]);
export function sanitizeMetaCustomData(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const safe: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!allowedCustomFields.has(key)) continue;
    if (key === "observed_percent" && typeof entry === "number" && Number.isFinite(entry)) {
      safe[key] = Math.max(0, Math.min(100, Math.floor(entry)));
    } else if (typeof entry === "string" && entry.length <= 80 && /^[A-Za-z0-9_-]+$/.test(entry)) {
      safe[key] = entry;
    }
  }
  return safe;
}

export function buildMetaCapiPayload(event: {
  eventName: string; eventTime: Date | string; eventId: string; eventSourceUrl: string; customData: unknown;
}) {
  const parsedTime = new Date(event.eventTime);
  const source = new URL(event.eventSourceUrl);
  const configuredHosts = (process.env.REPLIT_DOMAINS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const hostAllowed = source.hostname === "aromacafeinstitute.in"
    || source.hostname === "training.aromacafeinstitute.in"
    || configuredHosts.includes(source.host.toLowerCase());
  if (!Number.isFinite(parsedTime.getTime()) || !hostAllowed || source.protocol !== "https:"
    || source.search || source.hash || !isPublicAdmissionsPath(source.pathname)) {
    throw new Error("invalid_meta_event_source");
  }
  return {
    data: [{
      event_name: event.eventName,
      event_time: Math.floor(parsedTime.getTime() / 1000),
      event_id: event.eventId,
      action_source: "website",
      event_source_url: source.toString(),
      custom_data: sanitizeMetaCustomData(event.customData),
    }],
  };
}

export function isAcknowledgedCapiResponse(status: number, body: unknown) {
  return status >= 200 && status < 300 && !!body && typeof body === "object"
    && (body as { events_received?: unknown }).events_received === 1;
}

export function capiRetryDelayMs(attemptCount: number) {
  return Math.min(24 * 60 * 60_000, 30_000 * 2 ** Math.max(0, Math.min(7, attemptCount - 1)));
}

export function metaLeadIdempotencyKey(metaLeadId: string) {
  return `meta-lead:${metaLeadId}`;
}

export function safeMetaWebhookFailureStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const match = /^meta_graph_http_(4\d\d|5\d\d)$/.exec(message);
  return match ? Number(match[1]) : 503;
}
