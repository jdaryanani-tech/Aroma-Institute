import type { CounsellingAnswers, Inquiry } from "@shared/schema";

const WEBHOOK_URL_ENV = "N8N_COUNSELLING_WEBHOOK_URL";
const WEBHOOK_SECRET_ENV = "N8N_COUNSELLING_WEBHOOK_SECRET";
const WEBHOOK_HOST = "n8n.aromacafeinstitute.in";
const WEBHOOK_PATH = "/webhook/counselling-submission";
const EXPECTED_WEBHOOK_URL = `https://${WEBHOOK_HOST}${WEBHOOK_PATH}`;
const WEBHOOK_TIMEOUT_MS = 8_000;

export type CounsellingWebhookFailureReason =
  | "not_configured"
  | "misconfigured"
  | "invalid_url"
  | "http_error"
  | "invalid_json"
  | "invalid_acknowledgement"
  | "timeout"
  | "network_error";

export type CounsellingWebhookResult =
  | { status: "acknowledged"; httpStatus: number; responseAt: Date }
  | {
      status: "failed";
      reason: CounsellingWebhookFailureReason;
      httpStatus: number | null;
      responseAt: Date | null;
    };

export type PersistedCounsellingDeliveryResult = {
  status: "acknowledged" | "failed";
  lastResult: string;
  responseAt: Date | null;
  httpStatus: number | null;
  errorSummary: string | null;
};

type CounsellingInquiry = Inquiry & { counsellingAnswers: CounsellingAnswers };

export function summarizeCounsellingDeliveryResult(
  result: CounsellingWebhookResult,
): PersistedCounsellingDeliveryResult {
  if (result.status === "acknowledged") {
    return {
      status: "acknowledged",
      lastResult: `Acknowledged (HTTP ${result.httpStatus})`,
      responseAt: result.responseAt,
      httpStatus: result.httpStatus,
      errorSummary: null,
    };
  }
  const lastResult = result.httpStatus === null
    ? result.reason
    : `${result.reason} (HTTP ${result.httpStatus})`;
  return {
    status: "failed",
    lastResult,
    responseAt: result.responseAt,
    httpStatus: result.httpStatus,
    errorSummary: result.reason,
  };
}

export function isTrustedCounsellingWebhookUrl(value: string) {
  return value === EXPECTED_WEBHOOK_URL;
}

export function buildCounsellingWebhookPayload(
  inquiry: CounsellingInquiry,
  submittedAt: Date = inquiry.counsellingSubmittedAt ?? new Date(),
) {
  const answers = inquiry.counsellingAnswers;
  return {
    schemaVersion: 1,
    event: "counselling.inquiry.submitted",
    source: "aroma-leap-counselling-form",
    submissionId: `counselling-inquiry-${inquiry.id}`,
    leadId: inquiry.leadId ?? null,
    submittedAt: submittedAt.toISOString(),
    lead: {
      id: inquiry.id,
      name: inquiry.name,
      phone: inquiry.phone,
      email: inquiry.email || null,
      programInterest: inquiry.programInterest,
    },
    counsellingAnswers: answers,
    appointmentRequest: {
      visitMode: answers.visitMode,
      preferredDate: answers.preferredDate,
      preferredTime: answers.preferredTime,
      status: "pending_availability_check",
      confirmed: false,
    },
    consentToContact: answers.consentToContact,
  };
}

export async function sendCounsellingInquiryToN8n(
  inquiry: CounsellingInquiry,
  fetcher: typeof fetch = fetch,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
): Promise<CounsellingWebhookResult> {
  const webhookUrl = process.env[WEBHOOK_URL_ENV];
  const webhookSecret = process.env[WEBHOOK_SECRET_ENV]?.trim();
  if (!webhookUrl && !webhookSecret) {
    return { status: "failed", reason: "not_configured", httpStatus: null, responseAt: null };
  }
  if (!webhookUrl || !webhookSecret) {
    return { status: "failed", reason: "misconfigured", httpStatus: null, responseAt: null };
  }
  if (!isTrustedCounsellingWebhookUrl(webhookUrl)) {
    return { status: "failed", reason: "invalid_url", httpStatus: null, responseAt: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(webhookUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-aichm-webhook-secret": webhookSecret,
        "Content-Type": "application/json",
        "Idempotency-Key": `counselling-inquiry-${inquiry.id}`,
      },
      body: JSON.stringify(buildCounsellingWebhookPayload(inquiry)),
      redirect: "error",
      signal: controller.signal,
    });
    const responseAt = new Date();
    if (!response.ok) {
      return {
        status: "failed",
        reason: "http_error",
        httpStatus: response.status,
        responseAt,
      };
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return {
        status: "failed",
        reason: controller.signal.aborted ? "timeout" : "invalid_json",
        httpStatus: response.status,
        responseAt,
      };
    }
    const expectedSubmissionId = `counselling-inquiry-${inquiry.id}`;
    if (
      typeof responseBody !== "object"
      || responseBody === null
      || !("received" in responseBody)
      || responseBody.received !== true
      || !("submissionId" in responseBody)
      || responseBody.submissionId !== expectedSubmissionId
    ) {
      return {
        status: "failed",
        reason: "invalid_acknowledgement",
        httpStatus: response.status,
        responseAt,
      };
    }
    return { status: "acknowledged", httpStatus: response.status, responseAt };
  } catch {
    return {
      status: "failed",
      reason: controller.signal.aborted ? "timeout" : "network_error",
      httpStatus: null,
      responseAt: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
