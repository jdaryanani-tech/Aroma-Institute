import assert from "node:assert/strict";
import test from "node:test";
import {
  createAvniProviderReferenceAliases,
  signAvniProviderReference,
  verifyAvniProviderReference,
  type AvniHmacKeyProvider,
} from "./avni-provider-reference-hmac";

function keyProvider(activeKeyId: string, ids = ["key-a"]): AvniHmacKeyProvider {
  return {
    activeKeyId: () => activeKeyId,
    retainedKeys: () => ids.map(keyId => ({
      keyId,
      // Synthetic deterministic fixtures only; never use these outside tests.
      key: Buffer.alloc(32, keyId === "key-a" ? 0x41 : 0x42),
    })),
  };
}

test("signs domain-separated HMAC references and verifies with a timing-safe adapter", () => {
  const provider = keyProvider("key-a");
  const threadReference = "15551234567@s.whatsapp.net";
  const thread = signAvniProviderReference({
    provider: "whatsapp",
    kind: "thread",
    rawReference: threadReference,
  }, provider);
  assert.match(thread.token, /^hmac-sha256:v2:key-a:[0-9a-f]{64}$/);
  assert.equal(verifyAvniProviderReference({
    provider: "whatsapp",
    kind: "thread",
    rawReference: threadReference,
    token: thread.token,
  }, provider), true);
  assert.equal(verifyAvniProviderReference({
    provider: "whatsapp",
    kind: "event",
    rawReference: threadReference,
    token: thread.token,
  }, provider), false);
  assert.equal(verifyAvniProviderReference({
    provider: "evolution",
    kind: "thread",
    rawReference: threadReference,
    token: thread.token,
  }, provider), false);
  assert.equal(verifyAvniProviderReference({
    provider: "whatsapp",
    kind: "thread",
    rawReference: `${threadReference}-different`,
    token: thread.token,
  }, provider), false);
});

test("rotation aliases cover retained keys independent of which key is active", () => {
  const reference = {
    provider: "whatsapp",
    kind: "event" as const,
    rawReference: "provider-event-456",
  };
  const before = createAvniProviderReferenceAliases(
    reference,
    keyProvider("key-a", ["key-a", "key-b"]),
  );
  const after = createAvniProviderReferenceAliases(
    reference,
    keyProvider("key-b", ["key-a", "key-b"]),
  );
  assert.deepEqual(after, before);
  assert.deepEqual(before.map(item => item.keyId), ["key-a", "key-b"]);
  assert.notEqual(before[0]?.token, before[1]?.token);
});

test("retained-key aliases prevent duplicate event creation across rotation", () => {
  const reference = {
    provider: "whatsapp",
    kind: "event" as const,
    rawReference: "event-stable-across-rotation",
  };
  const databaseAliases = new Map<string, string>();
  const eventRows: string[] = [];
  const retainEvent = (
    aliases: ReturnType<typeof createAvniProviderReferenceAliases>,
    eventFingerprint: string,
  ) => {
    const matches = new Set(aliases.flatMap(alias => {
      const eventId = databaseAliases.get(`${reference.provider}:${reference.kind}:${alias.token}`);
      return eventId ? [eventId] : [];
    }));
    assert.ok(matches.size <= 1, "alias set must resolve to at most one event");
    if (matches.size === 1) return { eventId: [...matches][0]!, created: false };
    const eventId = `synthetic-event-${eventRows.length + 1}`;
    eventRows.push(`${eventId}:${eventFingerprint}`);
    for (const alias of aliases) {
      const key = `${reference.provider}:${reference.kind}:${alias.token}`;
      const existing = databaseAliases.get(key);
      assert.ok(!existing || existing === eventId, "unique alias must not point to another event");
      databaseAliases.set(key, eventId);
    }
    return { eventId, created: true };
  };

  const first = retainEvent(
    createAvniProviderReferenceAliases(reference, keyProvider("key-a", ["key-a", "key-b"])),
    "fingerprint-a",
  );
  const retryAfterRotation = retainEvent(
    createAvniProviderReferenceAliases(reference, keyProvider("key-b", ["key-a", "key-b"])),
    "fingerprint-a",
  );
  assert.deepEqual(first, { eventId: "synthetic-event-1", created: true });
  assert.deepEqual(retryAfterRotation, { eventId: "synthetic-event-1", created: false });
  assert.equal(eventRows.length, 1);
});

test("missing keys, unknown key IDs, malformed aliases, and invalid key material fail closed", () => {
  assert.throws(() => signAvniProviderReference({
    provider: "whatsapp", kind: "event", rawReference: "event-1",
  }, null), /KEY_CONFIGURATION_UNAVAILABLE/);
  assert.throws(() => signAvniProviderReference({
    provider: "whatsapp", kind: "event", rawReference: "event-1",
  }, keyProvider("missing", ["key-a"])), /KEY_CONFIGURATION_UNAVAILABLE/);
  const token = signAvniProviderReference({
    provider: "whatsapp", kind: "event", rawReference: "event-1",
  }, keyProvider("key-a"));
  assert.equal(verifyAvniProviderReference({
    provider: "whatsapp", kind: "event", rawReference: "event-1",
    token: token.token.replace(":key-a:", ":unknown:"),
  }, keyProvider("key-a")), false);
  assert.throws(() => createAvniProviderReferenceAliases({
    provider: "whatsapp", kind: "event", rawReference: "event-1",
  }, {
    activeKeyId: () => "key-a",
    retainedKeys: () => [{ keyId: "key-a", key: Buffer.from("short") }],
  }), /KEY_CONFIGURATION_UNAVAILABLE/);
  assert.throws(() => signAvniProviderReference({
    provider: "whatsapp", kind: "event", rawReference: "bad\u0000reference",
  }, keyProvider("key-a")), /INPUT_INVALID/);
});
