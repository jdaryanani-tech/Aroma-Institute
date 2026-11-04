import type { CounsellingAnswers, Inquiry } from "@shared/schema";

const WEBHOOK_URL_ENV = "N8N_COUNSELLING_WEBHOOK_URL";
const WEBHOOK_SECRET_ENV = "N8N_COUNSELLING_WEBHOOK_SECRET";
const WEBHOOK_HOST = "n8n.aromacafeinstitute.in";
const WEBHOOK_TIMEOUT_MS = 8_000;

export type CounsellingWebhookResult =
  | { status: "not_configured" | "misconfigured" | "invalid_url" }
  | { status: "sent"; httpStatus: number }
  | { status: "failed"; reason: "timeout" | "network_error" | "http_error"; httpStatus?: number };

type CounsellingInquiry = Inquiry & { counsellingAnswers: CounsellingAnswers };

export function isTrustedCounsellingWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === WEBHOOK_HOST
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && url.pathname.startsWith("/webhook/");
  } catch {
    return false;
  }
}

export function buildCounsellingWebhookPayload(
  inquiry: CounsellingInquiry,
  submittedAt: Date = new Date(),
) {
  const answers = inquiry.counsellingAnswers;
  return {
    schemaVersion: 1,
    event: "counselling.inquiry.submitted",
    source: "aroma-leap-counselling-form",
    submissionId: `counselling-inquiry-${inquiry.id}`,
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
): Promise<CounsellingWebhookResult> {
  const webhookUrl = process.env[WEBHOOK_URL_ENV]?.trim();
  const webhookSecret = process.env[WEBHOOK_SECRET_ENV]?.trim();
  if (!webhookUrl && !webhookSecret) return { status: "not_configured" };
  if (!webhookUrl || !webhookSecret) return { status: "misconfigured" };
  if (!isTrustedCounsellingWebhookUrl(webhookUrl)) return { status: "invalid_url" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetcher(webhookUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${webhookSecret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `counselling-inquiry-${inquiry.id}`,
      },
      body: JSON.stringify(buildCounsellingWebhookPayload(inquiry)),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "failed", reason: "http_error", httpStatus: response.status };
    }
    return { status: "sent", httpStatus: response.status };
  } catch {
    return {
      status: "failed",
      reason: controller.signal.aborted ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
