import assert from "node:assert/strict";
import test from "node:test";
import {
  AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV,
  readAvniHmacKeyringConfig,
} from "./avni-provider-reference-hmac-config";
import {
  createAvniProviderReferenceAliases,
  verifyAvniProviderReference,
} from "./avni-provider-reference-hmac";

const material = Buffer.alloc(32, 0x49).toString("base64");
const rotatedMaterial = Buffer.alloc(32, 0x27).toString("base64");

function config(value: unknown) {
  return readAvniHmacKeyringConfig({
    [AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV]: JSON.stringify(value),
  });
}

test("HMAC environment adapter fails closed when the keyring is missing", () => {
  assert.deepEqual(readAvniHmacKeyringConfig({}), { state: "missing", provider: null });
});

test("HMAC environment adapter returns no key material and validates a synthetic keyring", () => {
  const result = config({ activeKeyId: "key-a", keys: [{ keyId: "key-a", keyBase64: material }] });
  assert.equal(result.state, "ready");
  assert.equal(JSON.stringify(result).includes(material), false);
  if (result.state !== "ready") return;
  const aliases = createAvniProviderReferenceAliases({
    provider: "whatsapp",
    kind: "event",
    rawReference: "synthetic-provider-event",
  }, result.provider);
  assert.equal(aliases.length, 1);
  assert.equal(verifyAvniProviderReference({
    provider: "whatsapp",
    kind: "event",
    rawReference: "synthetic-provider-event",
    token: aliases[0].token,
  }, result.provider), true);
});

test("rotation keyrings retain old aliases while writing with the active key", () => {
  const before = config({
    activeKeyId: "key-a",
    keys: [{ keyId: "key-a", keyBase64: material }],
  });
  const after = config({
    activeKeyId: "key-b",
    keys: [
      { keyId: "key-a", keyBase64: material },
      { keyId: "key-b", keyBase64: rotatedMaterial },
    ],
  });
  assert.equal(before.state, "ready");
  assert.equal(after.state, "ready");
  if (before.state !== "ready" || after.state !== "ready") return;
  const existing = createAvniProviderReferenceAliases({
    provider: "whatsapp",
    kind: "event",
    rawReference: "same-synthetic-event",
  }, before.provider);
  const rotated = createAvniProviderReferenceAliases({
    provider: "whatsapp",
    kind: "event",
    rawReference: "same-synthetic-event",
  }, after.provider);
  assert.equal(rotated.some(alias => alias.token === existing[0].token), true);
  assert.equal(rotated.length, 2);
});

test("HMAC environment adapter rejects malformed, duplicate, weak, or incomplete keys", () => {
  const invalid = [
    "{",
    JSON.stringify({ activeKeyId: "missing", keys: [{ keyId: "key-a", keyBase64: material }] }),
    JSON.stringify({ activeKeyId: "key-a", keys: [{ keyId: "key-a", keyBase64: Buffer.alloc(16).toString("base64") }] }),
    JSON.stringify({ activeKeyId: "key-a", keys: [
      { keyId: "key-a", keyBase64: material },
      { keyId: "key-a", keyBase64: rotatedMaterial },
    ] }),
    JSON.stringify({ activeKeyId: "key-a", keys: [{ keyId: "key-a", keyBase64: `${material}!` }] }),
    JSON.stringify({ activeKeyId: "key-a", keys: [{ keyId: "key-a", keyBase64: material }], extra: true }),
  ];
  for (const value of invalid) {
    assert.deepEqual(readAvniHmacKeyringConfig({
      [AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV]: value,
    }), { state: "invalid", provider: null });
  }
});
