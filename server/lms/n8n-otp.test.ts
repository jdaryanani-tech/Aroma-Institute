import assert from "node:assert/strict";
import test from "node:test";
import {
  parseN8nSendResponse,
  parseN8nVerifyResponse,
} from "./n8n-otp";

const challengeId = "4e5bf513-abd4-4df1-81a3-7148e339bb71";

test("n8n send response must accept and echo the expected challenge", () => {
  assert.equal(
    parseN8nSendResponse(
      { version: 1, action: "send", challengeId, accepted: true },
      challengeId,
    ),
    true,
  );
  assert.equal(
    parseN8nSendResponse(
      { version: 1, action: "send", challengeId, accepted: false },
      challengeId,
    ),
    false,
  );
  assert.equal(
    parseN8nSendResponse(
      { version: 1, action: "send", challengeId: "different", accepted: true },
      challengeId,
    ),
    false,
  );
});

test("n8n verification accepts only a valid, matching boolean response", () => {
  assert.equal(
    parseN8nVerifyResponse(
      { version: 1, action: "verify", challengeId, verified: true },
      challengeId,
    ),
    true,
  );
  assert.equal(
    parseN8nVerifyResponse(
      { version: 1, action: "verify", challengeId, verified: false },
      challengeId,
    ),
    false,
  );
  assert.equal(
    parseN8nVerifyResponse(
      { version: 1, action: "verify", challengeId: "different", verified: true },
      challengeId,
    ),
    null,
  );
  assert.equal(parseN8nVerifyResponse({ verified: true }, challengeId), null);
});
