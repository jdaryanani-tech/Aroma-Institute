import { createHash, timingSafeEqual } from "node:crypto";

export const N8N_INTEGRATION_SECRET_ENV = "N8N_VSL_REGISTRATION_WEBHOOK_SECRET";
export const N8N_INTEGRATION_SECRET_HEADER = "x-aichm-webhook-secret";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function verifyN8nIntegrationSecret(supplied: string, expected: string | undefined) {
  if (!expected?.trim() || supplied.length > 1024) return false;
  return timingSafeEqual(digest(supplied), digest(expected.trim()));
}
