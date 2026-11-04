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
  counsellingDeliveryLastVerifiedAt: null,
  counsellingDeliveryLastVerifiedBy: null,
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
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in/webhook/counselling-submission"), true);
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in/webhook/counselling-intake"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in/webhook/counselling-submission/"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in/webhook/counselling-submission?test=1"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in:8443/webhook/counselling-submission"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://n8n.aromacafeinstitute.in:443/webhook/counselling-submission"), false);
  assert.equal(isTrustedCounsellingWebhookUrl(" https://n8n.aromacafeinstitute.in/webhook/counselling-submission"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("http://n8n.aromacafeinstitute.in/webhook/counselling-submission"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://example.org/webhook/counselling-submission"), false);
  assert.equal(isTrustedCounsellingWebhookUrl("https://user:pass@n8n.aromacafeinstitute.in/webhook/counselling-submission"), false);
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
  const responseAt = new Date("2027-01-01T00:00:01.000Z");
  assert.deepEqual(
    summarizeCounsellingDeliveryResult({ status: "acknowledged", httpStatus: 202, responseAt }),
    {
      status: "acknowledged",
      lastResult: "Acknowledged (HTTP 202)",
      responseAt,
      httpStatus: 202,
      errorSummary: null,
    },
  );
  assert.deepEqual(
    summarizeCounsellingDeliveryResult({
      status: "failed",
      reason: "http_error",
      httpStatus: 403,
      responseAt,
    }),
    {
      status: "failed",
      lastResult: "http_error (HTTP 403)",
      responseAt,
      httpStatus: 403,
      errorSummary: "http_error",
    },
  );
  assert.deepEqual(
    summarizeCounsellingDeliveryResult({
      status: "failed",
      reason: "timeout",
      httpStatus: null,
      responseAt: null,
    }),
    {
      status: "failed",
      lastResult: "timeout",
      responseAt: null,
      httpStatus: null,
      errorSummary: "timeout",
    },
  );
});

test("an unset webhook produces a safe failure without making a request", async () => {
  delete process.env.N8N_COUNSELLING_WEBHOOK_URL;
  delete process.env.N8N_COUNSELLING_WEBHOOK_SECRET;
  try {
    assert.deepEqual(await sendCounsellingInquiryToN8n(inquiry, async () => {
      throw new Error("fetch should not run");
    }), {
      status: "failed",
      reason: "not_configured",
      httpStatus: null,
      responseAt: null,
    });
  } finally {
    restoreEnv();
  }
});

test("a successful webhook uses the custom secret header and an idempotency key", async () => {
  process.env.N8N_COUNSELLING_WEBHOOK_URL = "https://n8n.aromacafeinstitute.in/webhook/counselling-submission";
  process.env.N8N_COUNSELLING_WEBHOOK_SECRET = "  test-only-secret \n";
  let sentBody: unknown;
  let sentHeaders: Headers | null = null;
  let sentUrl: string | null = null;
  try {
    const result = await sendCounsellingInquiryToN8n(inquiry, async (_input, init) => {
      sentUrl = String(_input);
      sentBody = JSON.parse(String(init?.body));
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        received: true,
        submissionId: "counselling-inquiry-42",
      }), { status: 202 });
    });
    assert.equal(result.status, "acknowledged");
    if (result.status === "acknowledged") {
      assert.equal(result.httpStatus, 202);
      assert.ok(result.responseAt instanceof Date);
    }
    assert.equal(sentUrl, "https://n8n.aromacafeinstitute.in/webhook/counselling-submission");
    assert.equal(sentHeaders?.get("x-aichm-webhook-secret"), "test-only-secret");
    assert.equal(sentHeaders?.get("authorization"), null);
    assert.equal(sentHeaders?.get("idempotency-key"), "counselling-inquiry-42");
    assert.equal((sentBody as ReturnType<typeof buildCounsellingWebhookPayload>).appointmentRequest.confirmed, false);
  } finally {
    restoreEnv();
  }
});

test("a 2xx response without a matching explicit acknowledgement is failed", async () => {
  process.env.N8N_COUNSELLING_WEBHOOK_URL = "https://n8n.aromacafeinstitute.in/webhook/counselling-submission";
  process.env.N8N_COUNSELLING_WEBHOOK_SECRET = "test-only-secret";
  try {
    const result = await sendCounsellingInquiryToN8n(inquiry, async () => new Response(
      JSON.stringify({ received: true, submissionId: "a-different-submission" }),
      { status: 200 },
    ));
    assert.deepEqual(result, {
      status: "failed",
      reason: "invalid_acknowledgement",
      httpStatus: 200,
      responseAt: result.status === "failed" ? result.responseAt : null,
    });
    assert.ok(result.status === "failed" && result.responseAt instanceof Date);
  } finally {
    restoreEnv();
  }
});

test("a 2xx response with invalid JSON is failed safely", async () => {
  process.env.N8N_COUNSELLING_WEBHOOK_URL = "https://n8n.aromacafeinstitute.in/webhook/counselling-submission";
  process.env.N8N_COUNSELLING_WEBHOOK_SECRET = "test-only-secret";
  try {
    const result = await sendCounsellingInquiryToN8n(inquiry, async () => new Response("not-json", { status: 200 }));
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.reason, "invalid_json");
      assert.equal(result.httpStatus, 200);
      assert.ok(result.responseAt instanceof Date);
    }
  } finally {
    restoreEnv();
  }
});

test("HTTP errors and timeouts remain failures without exposing response bodies", async () => {
  process.env.N8N_COUNSELLING_WEBHOOK_URL = "https://n8n.aromacafeinstitute.in/webhook/counselling-submission";
  process.env.N8N_COUNSELLING_WEBHOOK_SECRET = "test-only-secret";
  try {
    const httpError = await sendCounsellingInquiryToN8n(inquiry, async () => new Response(
      "private server detail",
      { status: 503 },
    ));
    assert.equal(httpError.status, "failed");
    if (httpError.status === "failed") {
      assert.equal(httpError.reason, "http_error");
      assert.equal(httpError.httpStatus, 503);
      assert.ok(httpError.responseAt instanceof Date);
    }

    const timeout = await sendCounsellingInquiryToN8n(
      inquiry,
      (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      5,
    );
    assert.deepEqual(timeout, {
      status: "failed",
      reason: "timeout",
      httpStatus: null,
      responseAt: null,
    });
  } finally {
    restoreEnv();
  }
});

test("an incomplete webhook configuration does not send data", async () => {
  process.env.N8N_COUNSELLING_WEBHOOK_URL = "https://n8n.aromacafeinstitute.in/webhook/counselling-submission";
  delete process.env.N8N_COUNSELLING_WEBHOOK_SECRET;
  try {
    assert.deepEqual(await sendCounsellingInquiryToN8n(inquiry, async () => {
      throw new Error("fetch should not run");
    }), {
      status: "failed",
      reason: "misconfigured",
      httpStatus: null,
      responseAt: null,
    });
  } finally {
    restoreEnv();
  }
});
