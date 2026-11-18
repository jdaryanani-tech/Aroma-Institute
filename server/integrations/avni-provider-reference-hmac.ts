import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const AVNI_PROVIDER_REFERENCE_KINDS = [
  "thread",
  "event",
  "message",
  "receipt",
] as const;
export type AvniProviderReferenceKind = typeof AVNI_PROVIDER_REFERENCE_KINDS[number];

const providerSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const keyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const rawReferenceSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const tokenSchema = z.string().regex(
  /^hmac-sha256:v2:[a-z0-9][a-z0-9_-]{0,31}:[0-9a-f]{64}$/,
);

export type AvniProviderReferenceToken = z.infer<typeof tokenSchema>;
export type AvniHmacKey = { keyId: string; key: Uint8Array };
export type AvniHmacKeyProvider = {
  /** The only key used to create new persisted aliases. */
  activeKeyId(): string | null;
  /** All keys still needed to resolve existing aliases during rotation. */
  retainedKeys(): readonly AvniHmacKey[];
};

export type AvniProviderReferenceAlias = {
  keyId: string;
  token: AvniProviderReferenceToken;
};

function invalidKeyConfiguration(): never {
  throw new Error("AVNI_PROVIDER_REFERENCE_KEY_CONFIGURATION_UNAVAILABLE");
}

function validatedKeys(provider: AvniHmacKeyProvider | null): {
  activeKeyId: string;
  keys: readonly AvniHmacKey[];
} {
  if (!provider) return invalidKeyConfiguration();
  let activeKeyId: string | null;
  let keys: readonly AvniHmacKey[];
  try {
    activeKeyId = provider.activeKeyId();
    keys = provider.retainedKeys();
  } catch {
    return invalidKeyConfiguration();
  }
  if (
    !activeKeyId ||
    !keyIdSchema.safeParse(activeKeyId).success ||
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.length > 16
  ) return invalidKeyConfiguration();

  const seen = new Set<string>();
  for (const item of keys) {
    if (
      !item ||
      !keyIdSchema.safeParse(item.keyId).success ||
      !(item.key instanceof Uint8Array) ||
      item.key.byteLength < 32 ||
      item.key.byteLength > 256 ||
      seen.has(item.keyId)
    ) return invalidKeyConfiguration();
    seen.add(item.keyId);
  }
  if (!seen.has(activeKeyId)) return invalidKeyConfiguration();
  return { activeKeyId, keys };
}

function mac(
  key: Uint8Array,
  provider: string,
  kind: AvniProviderReferenceKind,
  rawReference: string,
): string {
  // Length-delimited JSON prevents ambiguous concatenations; the fixed prefix
  // and kind provide domain separation between all persisted reference classes.
  const canonical = JSON.stringify([
    "aichm-avni-provider-reference",
    2,
    provider,
    kind,
    rawReference,
  ]);
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

export function signAvniProviderReference(
  input: {
    provider: string;
    kind: AvniProviderReferenceKind;
    rawReference: string;
  },
  keyProvider: AvniHmacKeyProvider | null,
): AvniProviderReferenceAlias {
  const { activeKeyId, keys } = validatedKeys(keyProvider);
  if (
    !providerSchema.safeParse(input.provider).success ||
    !AVNI_PROVIDER_REFERENCE_KINDS.includes(input.kind) ||
    !rawReferenceSchema.safeParse(input.rawReference).success
  ) throw new Error("AVNI_PROVIDER_REFERENCE_INPUT_INVALID");
  const key = keys.find(candidate => candidate.keyId === activeKeyId)!;
  return {
    keyId: activeKeyId,
    token: `hmac-sha256:v2:${activeKeyId}:${mac(
      key.key,
      input.provider,
      input.kind,
      input.rawReference,
    )}`,
  };
}

/**
 * Produces all retained-key aliases, always including the active write key.
 * Persisting the full set in one DB transaction makes event identity stable
 * across a key rotation; callers must not persist rawReference.
 */
export function createAvniProviderReferenceAliases(
  input: {
    provider: string;
    kind: AvniProviderReferenceKind;
    rawReference: string;
  },
  keyProvider: AvniHmacKeyProvider | null,
): AvniProviderReferenceAlias[] {
  const { keys } = validatedKeys(keyProvider);
  if (
    !providerSchema.safeParse(input.provider).success ||
    !AVNI_PROVIDER_REFERENCE_KINDS.includes(input.kind) ||
    !rawReferenceSchema.safeParse(input.rawReference).success
  ) throw new Error("AVNI_PROVIDER_REFERENCE_INPUT_INVALID");
  return [...keys]
    .sort((left, right) => left.keyId.localeCompare(right.keyId))
    .map(({ keyId, key }) => ({
      keyId,
      token: `hmac-sha256:v2:${keyId}:${mac(
        key,
        input.provider,
        input.kind,
        input.rawReference,
      )}`,
    }));
}

export function verifyAvniProviderReference(
  input: {
    provider: string;
    kind: AvniProviderReferenceKind;
    rawReference: string;
    token: string;
  },
  keyProvider: AvniHmacKeyProvider | null,
): boolean {
  const parsed = tokenSchema.safeParse(input.token);
  if (!parsed.success) return false;
  try {
    const { keys } = validatedKeys(keyProvider);
    if (
      !providerSchema.safeParse(input.provider).success ||
      !AVNI_PROVIDER_REFERENCE_KINDS.includes(input.kind) ||
      !rawReferenceSchema.safeParse(input.rawReference).success
    ) return false;
    const [, , keyId, suppliedHex] = parsed.data.split(":");
    const key = keys.find(candidate => candidate.keyId === keyId);
    if (!key) return false;
    const expected = Buffer.from(
      mac(key.key, input.provider, input.kind, input.rawReference),
      "hex",
    );
    const supplied = Buffer.from(suppliedHex!, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}
