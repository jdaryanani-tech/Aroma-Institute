import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const TOKEN_AAD = Buffer.from("aichm-meta-backfill-v1");
const MAX_TOKEN_LENGTH = 128_000;

let cachedSecret: string | undefined;
let cachedKey: Buffer | undefined;

function encryptionKey(secret: string) {
  if (!secret) throw new Error("backfill_token_key_unavailable");
  if (cachedSecret !== secret || !cachedKey) {
    cachedSecret = secret;
    cachedKey = scryptSync(secret, "aichm-meta-backfill-v1", 32);
  }
  return cachedKey;
}

/**
 * Continuation state is authenticated and encrypted. The browser receives only
 * an opaque short-lived token, never Graph cursors or run internals.
 */
export function sealBackfillState(value: unknown, secret: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  cipher.setAAD(TOKEN_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [nonce, ciphertext, tag].map((part) => part.toString("base64url")).join(".");
}

export function openBackfillState<T>(token: string, secret: string): T {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error("backfill_token_invalid");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("backfill_token_invalid");
  try {
    const [nonce, ciphertext, tag] = parts.map((part) => Buffer.from(part, "base64url"));
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_TOKEN_LENGTH) {
      throw new Error("backfill_token_invalid");
    }
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), nonce);
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error("backfill_token_invalid");
  }
}
