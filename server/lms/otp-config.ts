const OTP_WEBHOOK_URL_ENV = "LMS_OTP_WEBHOOK_URL";

/**
 * Reports whether a server-side HTTPS webhook URL is configured.
 *
 * This deliberately does not call the provider or imply that OTP login is
 * ready. The send and verification contract must be approved before use.
 */
export function isLmsOtpWebhookUrlConfigured() {
  const configuredUrl = process.env[OTP_WEBHOOK_URL_ENV]?.trim();
  if (!configuredUrl) return false;

  try {
    const url = new URL(configuredUrl);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
