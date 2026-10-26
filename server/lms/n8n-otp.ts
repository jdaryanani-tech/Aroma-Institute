import { z } from "zod";

const otpWebhookRequestSchema = z.object({
  version: z.literal(1),
  action: z.enum(["send", "verify"]),
  challengeId: z.string().uuid(),
  phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  expiresAt: z.string().datetime(),
  otp: z.string().regex(/^\d{6}$/).optional(),
});

const sendResponseSchema = z.object({
  version: z.literal(1),
  action: z.literal("send"),
  challengeId: z.string().uuid(),
  accepted: z.boolean(),
});

const verifyResponseSchema = z.object({
  version: z.literal(1),
  action: z.literal("verify"),
  challengeId: z.string().uuid(),
  verified: z.boolean(),
});

export type SendOtpWebhookPayload = {
  version: 1;
  action: "send";
  challengeId: string;
  phoneE164: string;
  expiresAt: string;
};

export type VerifyOtpWebhookPayload = {
  version: 1;
  action: "verify";
  challengeId: string;
  phoneE164: string;
  expiresAt: string;
  otp: string;
};

export class OtpProviderNotConfiguredError extends Error {
  constructor() {
    super("OTP provider is not configured.");
    this.name = "OtpProviderNotConfiguredError";
  }
}

export class OtpProviderRequestError extends Error {
  constructor() {
    super("OTP provider request failed.");
    this.name = "OtpProviderRequestError";
  }
}

function getWebhookUrl() {
  const rawUrl = process.env.N8N_OTP_WEBHOOK_URL?.trim();
  const token = process.env.N8N_OTP_WEBHOOK_TOKEN?.trim();
  if (!rawUrl || !token || token.length < 32) {
    throw new OtpProviderNotConfiguredError();
  }

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new OtpProviderNotConfiguredError();
    }
    return { url: url.toString(), token };
  } catch (error) {
    if (error instanceof OtpProviderNotConfiguredError) throw error;
    throw new OtpProviderNotConfiguredError();
  }
}

export function isN8nOtpConfigured() {
  try {
    getWebhookUrl();
    return true;
  } catch {
    return false;
  }
}

function parseResponseBody(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new OtpProviderRequestError();
  }
}

export function parseN8nSendResponse(value: unknown, challengeId: string) {
  const response = sendResponseSchema.safeParse(value);
  return Boolean(
    response.success &&
      response.data.challengeId === challengeId &&
      response.data.accepted,
  );
}

export function parseN8nVerifyResponse(value: unknown, challengeId: string) {
  const response = verifyResponseSchema.safeParse(value);
  if (!response.success || response.data.challengeId !== challengeId) {
    return null;
  }
  return response.data.verified;
}

async function callN8n(
  payload: SendOtpWebhookPayload | VerifyOtpWebhookPayload,
) {
  const { url, token } = getWebhookUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new OtpProviderRequestError();
    const raw = await response.text();
    if (raw.length > 8_192) throw new OtpProviderRequestError();
    return parseResponseBody(raw);
  } catch (error) {
    if (
      error instanceof OtpProviderNotConfiguredError ||
      error instanceof OtpProviderRequestError
    ) {
      throw error;
    }
    throw new OtpProviderRequestError();
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendOtpThroughN8n(payload: SendOtpWebhookPayload) {
  const parsedPayload = otpWebhookRequestSchema.safeParse(payload);
  if (!parsedPayload.success || payload.action !== "send" || "otp" in payload) {
    throw new OtpProviderRequestError();
  }
  if (!parseN8nSendResponse(await callN8n(payload), payload.challengeId)) {
    throw new OtpProviderRequestError();
  }
}

export async function verifyOtpThroughN8n(payload: VerifyOtpWebhookPayload) {
  const parsedPayload = otpWebhookRequestSchema.safeParse(payload);
  if (!parsedPayload.success || payload.action !== "verify" || !payload.otp) {
    throw new OtpProviderRequestError();
  }
  const verified = parseN8nVerifyResponse(
    await callN8n(payload),
    payload.challengeId,
  );
  if (verified === null) {
    throw new OtpProviderRequestError();
  }
  return verified;
}
