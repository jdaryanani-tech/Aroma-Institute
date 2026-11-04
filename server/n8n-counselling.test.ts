import assert from "node:assert/strict";
import test from "node:test";
import type { CounsellingAnswers, Inquiry } from "@shared/schema";
import {
  buildCounsellingWebhookPayload,
  isTrustedCounsellingWebhookUrl,
  sendCounsellingInquiryToN8n,
  summarizeCounsellingDeliveryResult,
} from "./n8n-counselling";

const answerSet = {
  fullName: "Test Student",
  ageRange: "18to20",
  currentActivity: "college",
  city: "Ahmedabad",
  careerReasons: ["practicalSkills"],
  mainBarrier: "noWorkExperience",
  situationImpact: "",
  sixToTwelveMonthGoal: "firstCaféJob",
  coffeeKnowledge: "beginner",
  stepsTaken: ["onlineResearch"],
  biggestConcern: "jobWithoutExperience",
  desiredStart: "withinOneMonth",
  handsOnReadiness: "ready",
  timeAvailability: "fullTime",
  decisionMaker: "self",
  familyDiscussion: "notDiscussed",
  investmentSituation: "understandProgramFirst",
  topQuestions: "",
  counsellorNote: "",
  visitMode: "instituteAhmedabad",
  preferredDate: "2027-02-10",
  preferredTime: "10to12",
  visitCompanion: "alone",
  visitFocus: "",
  mobileWhatsapp: "9876543210",
  email: "",
  counsellingLanguage: "hinglish",
  parentJoining: "no",
  consentToContact: true,
} satisfies CounsellingAnswers;

const inquiry = {
  id: 42,
  name: "Test Student",
  email: "",
  phone: "9876543210",
  programInterest: "Aroma LEAP",
  message: "Counselling request",
  counsellingAnswers: answerSet,
  counsellingSubmittedAt: new Date("2027-01-01T00:00:00.000Z"),
  counsellingDeliveryStatus: "untracked",
  counsellingDeliveryAttempts: 0,
  counsellingDeliveryLastAttemptAt: null,
  counsellingDeliveryLastResult: null,
} satisfies Inquiry & { counsellingAnswers: CounsellingAnswers };

const originalUrl = process.env.N8N_COUNSELLING_WEBHOOK_URL;
const originalSecret = process.env.N8N_COUNSELLING_WEBHOOK_SECRET;

function restoreEnv() {
  if (originalUrl === undefined) delete process.env.N8N_COUNSELLING_WEBHOOK_URL;
  else process.env.N8N_COUNSELLING_WEBHOOK_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.N8N_COUNSELLING_WEBHOOK_SECRET;
  else process.env.N8N_COUNSELLING_WEBHOOK_SECRET = originalSecret;
}

test("only production HTTPS webhooks on the Aroma n8n host are accepted", () => {
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in/webhook/counselling-intake"), true);
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in/webhook-test/counselling-intake"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("http://n8n.aromacafeinstitute.in/webhook/counselling-intake"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://example.org/webhook/counselling-intake"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://user:pass@n8n.aromacafeinstitute.in/webhook/counselling-intake"), false);
});

test("the payload carries the full questionnaire and keeps booking unconfirmed", () => {
  const payload = buildCounsellingWebhookPayload(inquiry);
  assert.equal(payload.event, "counselling.inquiry.submitted");
  assert.equal(payload.submissionId, "counselling-inquiry-42");
  assert.equal(payload.submittedAt, "2027-01-01T00:00:00.000Z");
  assert.equal(payload.lead.phone, "9876543210");
  assert.equal(payload.counsellingAnswers.preferredDate, "2027-02-10");
  assert.equal(payload.appointmentRequest.status, "pending_availability_check");
  assert.equal(payload.appointmentRequest.confirmed, false);
  assert.equal(payload.consentToContact, true);
});

test("delivery summaries persist only status and safe result metadata", () => {
  assert.deepEqual(
    summarizeCounsellingDeliveryResult({ status: "sent", httpStatus: 202 }),
    { status: "sent", lastResult: "HTTP 202" },
  );
  assert.deepEqual(
    summarizeCounsellingDeliveryResult({ status: "failed", reason: "http_error", httpStatus: 403 }),
    { status: "failed", lastResult: "http_error (HTTP 403)" },
  );
  assert.deepEqual(
    summarizeCounsellingDeliveryResult({ status: "failed", reason: "timeout" }),
    { status: "failed", lastResult: "timeout" },
  );
});

test("an unset webhook leaves local submission delivery disabled", async () => {
  delete process.env.N8N_COUNSELLING_WEBHOOK_URL;
  delete process.env.N8N_COUNSELLING_WEBHOOK_SECRET;
  try {
    assert.deepEqual(await sendCounsellingInquiryToN8n(inquiry, async () => {
      throw new Error("fetch should not run");
    }), { status: "not_configured" });
  } finally {
    restoreEnv();
  }
});

test("a successful webhook uses the custom secret header and an idempotency key", async () => {
  process.env.N8N_COUNSELLING_WEBHOOK_URL = "https://n8n.aromacafeinstitute.in/webhook/counselling-intake";
  process.env.N8N_COUNSELLING_WEBHOOK_SECRET = "  test-only-secret \n";
  let sentBody: unknown;
  let sentHeaders: Headers | null = null;
  try {
    const result = await sendCounsellingInquiryToN8n(inquiry, async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      sentHeaders = new Headers(init?.headers);
      return new Response(null, { status: 202 });
    });
    assert.deepEqual(result, { status: "sent", httpStatus: 202 });
    assert.equal(sentHeaders?.get("x-aichm-webhook-secret"), "test-only-secret");
    assert.equal(sentHeaders?.get("authorization"), null);
    assert.equal(sentHeaders?.get("idempotency-key"), "counselling-inquiry-42");
    assert.equal((sentBody as ReturnType<typeof buildCounsellingWebhookPayload>).appointmentRequest.confirmed, false);
  } finally {
    restoreEnv();
  }
});

test("an incomplete webhook configuration does not send data", async () => {
  process.env.N8N_COUNSELLING_WEBHOOK_URL = "https://n8n.aromacafeinstitute.in/webhook/counselling-intake";
  delete process.env.N8N_COUNSELLING_WEBHOOK_SECRET;
  try {
    assert.deepEqual(await sendCounsellingInquiryToN8n(inquiry, async () => {
      throw new Error("fetch should not run");
    }), { status: "misconfigured" });
  } finally {
    restoreEnv();
  }
});
