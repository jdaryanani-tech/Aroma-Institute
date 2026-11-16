import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  META_CONSENT_POLICY_VERSION, buildMetaCapiPayload, capiRetryDelayMs, getMetaReadiness,
  hasValidMetaConsent, isAcknowledgedCapiResponse, isPublicAdmissionsPath,
  isValidMetaChallenge, metaLeadIdempotencyKey, normalizeMetaFieldData,
  normalizeMetaFieldDataWithDiagnostics,
  safeMetaWebhookFailureStatus, sanitizeMetaCustomData, verifyMetaWebhookSignature,
} from "./config";
import { parseMetaAttribution } from "./attribution";
import { normalizeIndianMobile } from "../../shared/indian-mobile";

test("only current explicit marketing consent enables measurement", () => {
  assert.equal(hasValidMetaConsent("granted", META_CONSENT_POLICY_VERSION), true);
  assert.equal(hasValidMetaConsent("granted", "older-notice"), false);
  assert.equal(hasValidMetaConsent("denied", META_CONSENT_POLICY_VERSION), false);
  assert.equal(hasValidMetaConsent("withdrawn", META_CONSENT_POLICY_VERSION), false);
});

test("Meta Pixel scope is limited to public admissions pages", () => {
  for (const path of ["/", "/vsl", "/vsl-video", "/counselling"]) assert.equal(isPublicAdmissionsPath(path), true);
  for (const path of ["/admin", "/admin/login", "/learn", "/lms-admin", "/api/inquiries"]) {
    assert.equal(isPublicAdmissionsPath(path), false);
  }
});

test("integration readiness never enables Pixel, CAPI, or Lead Ads without config and explicit production gate", () => {
  const empty = getMetaReadiness({ NODE_ENV: "production" });
  assert.equal(empty.pixel.configured, false);
  assert.equal(empty.capi.enabled, false);
  assert.equal(empty.leadAds.configured, false);
  const configured = getMetaReadiness({
    NODE_ENV: "production", META_PIXEL_ID: "pixel-test", META_CAPI_ACCESS_TOKEN: "token-test",
    META_GRAPH_API_VERSION: "v99.0", META_CAPI_ENABLED: "true",
  });
  assert.equal(configured.capi.enabled, true);
  const development = getMetaReadiness({
    NODE_ENV: "development", META_PIXEL_ID: "pixel-test", META_CAPI_ACCESS_TOKEN: "token-test",
    META_GRAPH_API_VERSION: "v99.0", META_CAPI_ENABLED: "true",
  });
  assert.equal(development.capi.enabled, false);
});

test("webhook verify challenge requires subscribe mode and correct token", () => {
  assert.equal(isValidMetaChallenge("subscribe", "challenge", "verify", "verify"), true);
  assert.equal(isValidMetaChallenge("unsubscribe", "challenge", "verify", "verify"), false);
  assert.equal(isValidMetaChallenge("subscribe", "challenge", "wrong", "verify"), false);
  assert.equal(isValidMetaChallenge("subscribe", "challenge", "verify", undefined), false);
});

test("webhook signature verification accepts valid SHA-256 HMAC and rejects tampering", () => {
  const body = Buffer.from('{"object":"page"}');
  const secret = "unit-test-only";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyMetaWebhookSignature(body, signature, secret), true);
  assert.equal(verifyMetaWebhookSignature(body, `${signature.slice(0, -1)}0`, secret), false);
  assert.equal(verifyMetaWebhookSignature(body, signature, undefined), false);
});

test("Instant Form field mapping allowlists contact fields and ignores arbitrary answers", () => {
  const fields = normalizeMetaFieldData([
    { name: "full_name", values: ["Example Student"] },
    { name: "phone_number", values: ["+91 98765 43210"] },
    { name: "email", values: ["student@example.invalid"] },
    { name: "free_text_answer", values: ["Do not keep this field"] },
  ]);
  assert.deepEqual(fields, {
    name: "Example Student", phone: "+91 98765 43210",
    email: "student@example.invalid", programInterest: "Meta Instant Form Enquiry",
  });
});

test("Meta Instant Form WhatsApp number alias uses the same Indian mobile normalization", () => {
  for (const [value, expected] of [
    ["9000000001", "919000000001"],
    ["+91 90000 00002", "919000000002"],
    ["91-90000-00003", "919000000003"],
  ]) {
    const mapped = normalizeMetaFieldData([{ name: "whatsapp_number", values: [` ${value} `] }]);
    assert.equal(mapped.phone, value);
    assert.equal(normalizeIndianMobile(mapped.phone), expected);
  }
  // Human-readable question labels normalize to the same global alias; no
  // form ID or question ID is needed.
  assert.equal(
    normalizeMetaFieldData([{ name: "WhatsApp Number", values: ["9000000004"] }]).phone,
    "9000000004",
  );
});

test("Meta phone aliases use deterministic precedence and blank values fall through", () => {
  const allPresent = normalizeMetaFieldData([
    { name: "phone_number", values: ["9000000001"] },
    { name: "mobile_phone", values: ["9000000002"] },
    { name: "whatsapp_number", values: ["9000000003"] },
  ]);
  assert.equal(allPresent.phone, "9000000001");

  const mobileBeforeWhatsapp = normalizeMetaFieldData([
    { name: "mobile_phone", values: ["9000000005"] },
    { name: "whatsapp_number", values: ["9000000006"] },
  ]);
  assert.equal(mobileBeforeWhatsapp.phone, "9000000005");

  const blankValuesFallThrough = normalizeMetaFieldData([
    { name: "phone_number", values: ["", "   "] },
    { name: "mobile_phone", values: [" "] },
    { name: "whatsapp_number", values: [" 90000-00007 "] },
  ]);
  assert.equal(blankValuesFallThrough.phone, "90000-00007");
  assert.equal(normalizeIndianMobile(blankValuesFallThrough.phone), "919000000007");
});

test("a nonblank invalid higher-priority phone does not fall through or yield an identity key", () => {
  const invalidPrimary = normalizeMetaFieldData([
    { name: "phone_number", values: ["not-a-valid-mobile"] },
    { name: "mobile_phone", values: ["9000000008"] },
    { name: "whatsapp_number", values: ["9000000009"] },
  ]);
  assert.equal(invalidPrimary.phone, "not-a-valid-mobile");
  assert.equal(normalizeIndianMobile(invalidPrimary.phone), null);

  const invalidMobile = normalizeMetaFieldData([
    { name: "mobile_phone", values: ["0000000000"] },
    { name: "whatsapp_number", values: ["9000000010"] },
  ]);
  assert.equal(invalidMobile.phone, "0000000000");
  assert.equal(normalizeIndianMobile(invalidMobile.phone), null);
});

test("phone diagnostics expose only field presence and safe normalization decisions", () => {
  const missing = normalizeMetaFieldDataWithDiagnostics(undefined).phoneIdentityDiagnostics;
  assert.deepEqual(missing, {
    fieldStates: {
      phone_number: "missing",
      mobile_phone: "missing",
      whatsapp_number: "missing",
    },
    normalizationOutcome: "no_phone_field",
    selectedField: null,
    fallbackAttempted: false,
    invalidHigherPriorityBlockedFallback: false,
  });

  const blank = normalizeMetaFieldDataWithDiagnostics([
    { name: "phone_number", values: ["", "   "] },
    { name: "mobile_phone", values: [" "] },
    { name: "whatsapp_number", values: [] },
  ]).phoneIdentityDiagnostics;
  assert.deepEqual(blank.fieldStates, {
    phone_number: "blank",
    mobile_phone: "blank",
    whatsapp_number: "blank",
  });
  assert.equal(blank.normalizationOutcome, "phone_fields_blank");

  const aliases = [
    ["phone_number", "+91 90000 00011"],
    ["mobile_phone", "91-90000-00012"],
    ["whatsapp_number", "9000000013"],
  ] as const;
  for (const [field, value] of aliases) {
    const diagnostics = normalizeMetaFieldDataWithDiagnostics([
      { name: field, values: [value] },
    ]).phoneIdentityDiagnostics;
    assert.equal(diagnostics.fieldStates[field], "populated");
    assert.equal(diagnostics.normalizationOutcome, "valid");
    assert.equal(diagnostics.selectedField, field);
    assert.equal(diagnostics.fallbackAttempted, field !== "phone_number");
    assert.equal(diagnostics.invalidHigherPriorityBlockedFallback, false);
  }

  const blankPrimaryFallsBack = normalizeMetaFieldDataWithDiagnostics([
    { name: "phone_number", values: ["  "] },
    { name: "mobile_phone", values: [""] },
    { name: "whatsapp_number", values: ["9000000014"] },
  ]).phoneIdentityDiagnostics;
  assert.equal(blankPrimaryFallsBack.selectedField, "whatsapp_number");
  assert.equal(blankPrimaryFallsBack.fallbackAttempted, true);
  assert.equal(blankPrimaryFallsBack.invalidHigherPriorityBlockedFallback, false);

  const invalidPrimaryBlocksFallback = normalizeMetaFieldDataWithDiagnostics([
    { name: "phone_number", values: ["private-invalid-phone-value"] },
    { name: "mobile_phone", values: ["9000000015"] },
    { name: "whatsapp_number", values: ["9000000016"] },
  ]).phoneIdentityDiagnostics;
  assert.equal(invalidPrimaryBlocksFallback.selectedField, "phone_number");
  assert.equal(invalidPrimaryBlocksFallback.normalizationOutcome, "invalid_characters");
  assert.equal(invalidPrimaryBlocksFallback.fallbackAttempted, false);
  assert.equal(invalidPrimaryBlocksFallback.invalidHigherPriorityBlockedFallback, true);

  const invalidLengths = normalizeMetaFieldDataWithDiagnostics([
    { name: "mobile_phone", values: ["123"] },
  ]).phoneIdentityDiagnostics;
  assert.equal(invalidLengths.normalizationOutcome, "invalid_length");

  const invalidPrefix = normalizeMetaFieldDataWithDiagnostics([
    { name: "whatsapp_number", values: ["0000000000"] },
  ]).phoneIdentityDiagnostics;
  assert.equal(invalidPrefix.normalizationOutcome, "invalid_mobile_prefix");

  const serialized = JSON.stringify([
    missing, blank, ...aliases.map(([field, value]) =>
      normalizeMetaFieldDataWithDiagnostics([{ name: field, values: [value] }]).phoneIdentityDiagnostics),
    blankPrimaryFallsBack, invalidPrimaryBlocksFallback, invalidLengths, invalidPrefix,
  ]);
  assert.doesNotMatch(serialized, /private-invalid-phone-value|90000|90000000|\+91|91-/);
});

test("CAPI payload omits identifiers and only accepts safe custom fields", () => {
  const payload = buildMetaCapiPayload({
    eventName: "Lead", eventTime: "2026-11-07T12:00:00Z", eventId: "same-event-id",
    eventSourceUrl: "https://aromacafeinstitute.in/counselling",
    customData: {
      funnel_step: "counselling_submitted", observed_percent: 74.9,
      name: "must-not-send", email: "must-not-send", phone: "must-not-send",
      user_data: { em: "must-not-send" }, answers: "must-not-send",
    },
  });
  const event = payload.data[0];
  assert.equal(event.event_id, "same-event-id");
  assert.deepEqual(event.custom_data, { funnel_step: "counselling_submitted", observed_percent: 74 });
  assert.equal("user_data" in event, false);
  assert.equal(JSON.stringify(payload).includes("must-not-send"), false);
  assert.throws(() => buildMetaCapiPayload({
    eventName: "Lead", eventTime: new Date(), eventId: "id",
    eventSourceUrl: "https://aromacafeinstitute.in/counselling?email=private",
    customData: {},
  }), /invalid_meta_event_source/);
});

test("CAPI acknowledgement, retry backoff and Graph error mapping are bounded and safe", () => {
  assert.equal(isAcknowledgedCapiResponse(200, { events_received: 1 }), true);
  assert.equal(isAcknowledgedCapiResponse(200, { events_received: 0 }), false);
  assert.equal(isAcknowledgedCapiResponse(403, { events_received: 1 }), false);
  assert.equal(capiRetryDelayMs(1), 30_000);
  assert.equal(capiRetryDelayMs(8), 3_840_000);
  assert.equal(capiRetryDelayMs(100), 3_840_000);
  assert.equal(safeMetaWebhookFailureStatus(new Error("meta_graph_http_403")), 403);
  assert.equal(safeMetaWebhookFailureStatus(new Error("raw private response")), 503);
});

test("Meta lead idempotency uses the provider's stable lead ID", () => {
  assert.equal(metaLeadIdempotencyKey("123456"), "meta-lead:123456");
  assert.equal(metaLeadIdempotencyKey("123456"), metaLeadIdempotencyKey("123456"));
});

test("only consented browser contexts contribute bounded attribution fields", () => {
  const parsed = parseMetaAttribution({
    source: "facebook", campaign: "Autumn", campaignId: "1234", fbp: "fb.1.abc",
    unsafe: "must not persist", adId: "bad id with spaces",
  });
  assert.deepEqual(parsed, {
    source: "facebook", medium: null, campaign: "Autumn", campaignId: "1234",
    adId: null, adsetId: null, formId: null, fbc: null, fbp: "fb.1.abc",
  });
  assert.deepEqual(sanitizeMetaCustomData({ name: "private", funnel_step: "enquiry_submitted" }), {
    funnel_step: "enquiry_submitted",
  });
});
