import { z } from "zod";
import type { AvniHmacKeyProvider } from "./avni-provider-reference-hmac";

export const AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV =
  "AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_JSON";

const keyId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const keyringSchema = z.object({
  activeKeyId: keyId,
  keys: z.array(z.object({
    keyId,
    keyBase64: z.string().min(44).max(344),
  }).strict()).min(1).max(16),
}).strict();

export type AvniHmacKeyringConfig =
  | { state: "missing"; provider: null }
  | { state: "invalid"; provider: null }
  | { state: "ready"; provider: AvniHmacKeyProvider };

/**
 * Reads a server-only JSON key ring. It never logs or returns key material.
 * Every retained key is used for alias lookup; only the active key signs new
 * references, preserving idempotency during a reviewed rotation.
 */
export function readAvniHmacKeyringConfig(
  environment: Record<string, string | undefined> = process.env,
): AvniHmacKeyringConfig {
  const raw = environment[AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV];
  if (!raw?.trim()) return { state: "missing", provider: null };

  try {
    const parsed = keyringSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    const keys = parsed.keys.map((entry) => {
      if (seen.has(entry.keyId)) throw new Error("duplicate_key_id");
      seen.add(entry.keyId);
      const decoded = Buffer.from(entry.keyBase64, "base64");
      if (
        decoded.byteLength < 32 ||
        decoded.byteLength > 256 ||
        decoded.toString("base64") !== entry.keyBase64
      ) throw new Error("invalid_key_material");
      return { keyId: entry.keyId, key: new Uint8Array(decoded) };
    });
    if (!seen.has(parsed.activeKeyId)) throw new Error("active_key_missing");

    return {
      state: "ready",
      provider: {
        activeKeyId: () => parsed.activeKeyId,
        retainedKeys: () => keys.map(({ keyId: retainedId, key }) => ({
          keyId: retainedId,
          key: new Uint8Array(key),
        })),
      },
    };
  } catch {
    return { state: "invalid", provider: null };
  }
}
