import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPasswordSetupToken,
  hashLmsPassword,
  hashPasswordSetupToken,
  normalizeLmsPhone,
  verifyLmsPassword,
} from "./password-security";

test("normalizes Indian mobile numbers and valid international E.164 numbers", () => {
  assert.equal(normalizeLmsPhone("9016305718"), "+919016305718");
  assert.equal(normalizeLmsPhone("+91 90163-05718"), "+919016305718");
  assert.equal(normalizeLmsPhone("+14155552671"), "+14155552671");
});

test("rejects malformed and invalid Indian mobile numbers", () => {
  assert.equal(normalizeLmsPhone(""), null);
  assert.equal(normalizeLmsPhone("1234567890"), null);
  assert.equal(normalizeLmsPhone("+91 12345 67890"), null);
  assert.equal(normalizeLmsPhone("+91 90163 005718"), null);
  assert.equal(normalizeLmsPhone("0091 9016305718"), null);
});

test("password hashes verify only the password they were made for", async () => {
  const password = "Aroma-Learning-Password-46!";
  const encodedHash = await hashLmsPassword(password);

  assert.match(encodedHash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyLmsPassword(password, encodedHash), true);
  assert.equal(await verifyLmsPassword("different password", encodedHash), false);
  assert.equal(await verifyLmsPassword(password, "invalid$hash"), false);
});

test("password setup tokens are random and only their hashes are suitable for storage", () => {
  const first = createPasswordSetupToken();
  const second = createPasswordSetupToken();

  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashPasswordSetupToken(first.token));
  assert.equal(first.tokenHash.length, 64);
  assert.notEqual(first.token, first.tokenHash);
});
