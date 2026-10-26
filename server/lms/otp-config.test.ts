import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isLmsOtpWebhookUrlConfigured } from "./otp-config";

const originalUrl = process.env.LMS_OTP_WEBHOOK_URL;

afterEach(() => {
  if (originalUrl === undefined) {
    delete process.env.LMS_OTP_WEBHOOK_URL;
  } else {
    process.env.LMS_OTP_WEBHOOK_URL = originalUrl;
  }
});

test("OTP webhook is not configured when the server variable is empty", () => {
  delete process.env.LMS_OTP_WEBHOOK_URL;
  assert.equal(isLmsOtpWebhookUrlConfigured(), false);
});

test("OTP webhook accepts an HTTPS URL without exposing or calling it", () => {
  process.env.LMS_OTP_WEBHOOK_URL = "https://example.test/webhook/otp";
  assert.equal(isLmsOtpWebhookUrlConfigured(), true);
});

test("OTP webhook rejects insecure or credential-embedded URLs", () => {
  process.env.LMS_OTP_WEBHOOK_URL = "http://example.test/webhook/otp";
  assert.equal(isLmsOtpWebhookUrlConfigured(), false);

  process.env.LMS_OTP_WEBHOOK_URL = "https://user:password@example.test/webhook/otp";
  assert.equal(isLmsOtpWebhookUrlConfigured(), false);
});
