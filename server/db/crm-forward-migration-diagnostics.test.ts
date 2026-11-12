import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CRM_FORWARD_FAILURE_STAGE_CODES,
  formatCrmForwardStageFailure,
  type CrmForwardFailureStage,
} from "./crm-forward-migration-diagnostics";

const CORRELATION_ID = "b8f7749a-83fc-4c53-8c13-7a995de5a4da";

test("CRM forward failures map every requested stage to a stable sanitized code", () => {
  for (const [stage, stageCode] of Object.entries(CRM_FORWARD_FAILURE_STAGE_CODES)) {
    const diagnostic = formatCrmForwardStageFailure(
      stage as CrmForwardFailureStage,
      new Error("sensitive error message must not be included"),
      CORRELATION_ID,
    );
    assert.deepEqual(diagnostic, {
      stageCode,
      failureCategory: "unknown",
      correlationId: CORRELATION_ID,
    });
  }
});

test("CRM forward failures classify only explicitly allowlisted connection codes", () => {
  const cases = [
    ["ENOTFOUND", "dns_resolution"],
    ["EAI_AGAIN", "dns_resolution"],
    ["ECONNREFUSED", "tcp_connection"],
    ["ETIMEDOUT", "tcp_connection"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_hostname_verification"],
    ["CERT_HAS_EXPIRED", "tls_certificate_verification"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "tls_protocol_negotiation"],
    ["28P01", "postgres_authentication"],
    ["08006", "postgres_connection"],
    ["UNRECOGNIZED_CODE", "unknown"],
  ] as const;
  for (const [code, expected] of cases) {
    assert.equal(
      formatCrmForwardStageFailure(
        "tcpConnectionTlsNegotiation",
        Object.assign(new Error("hidden"), { code }),
        CORRELATION_ID,
      ).failureCategory,
      expected,
    );
  }
});

test("CRM forward diagnostics traverse bounded driver causes without looping", () => {
  const wrapped = Object.assign(new Error("outer"), {
    cause: Object.assign(new Error("driver wrapper"), {
      original: Object.assign(new Error("socket"), { code: "ECONNREFUSED" }),
    }),
  });
  assert.equal(
    formatCrmForwardStageFailure(
      "tcpConnectionTlsNegotiation",
      wrapped,
      CORRELATION_ID,
    ).failureCategory,
    "tcp_connection",
  );

  const cyclic: { code?: string; cause?: unknown } = { code: "NOT_ALLOWLISTED" };
  cyclic.cause = cyclic;
  assert.equal(
    formatCrmForwardStageFailure(
      "tcpConnectionTlsNegotiation",
      cyclic,
      CORRELATION_ID,
    ).failureCategory,
    "unknown",
  );
});

test("CRM forward cause traversal is bounded", () => {
  let wrapped: { cause?: unknown } = {};
  const root = wrapped;
  for (let i = 0; i < 6; i += 1) wrapped = wrapped.cause = {};
  wrapped.cause = { code: "ECONNREFUSED" };
  assert.equal(
    formatCrmForwardStageFailure(
      "tcpConnectionTlsNegotiation",
      root,
      CORRELATION_ID,
    ).failureCategory,
    "unknown",
  );
});

test("unknown errors redact message, stack, URL, credentials, and arbitrary fields", () => {
  const sensitiveMarkers = [
    "postgresql://",
    "secret-user",
    "secret-host.invalid",
    "secret-database",
    "secret-password",
    "secret-token",
    "PRIVATE_ENV_VALUE",
  ];
  const error = Object.assign(new Error(sensitiveMarkers.join(" ")), {
    name: "UnrecognizedFailureClass",
    code: "secret-token",
    stack: sensitiveMarkers.join(" "),
    connectionString: sensitiveMarkers.join(" "),
    environment: { DATABASE_URL: sensitiveMarkers.join(" ") },
    cause: Object.assign(new Error(sensitiveMarkers.join(" ")), {
      code: "secret-token",
      host: sensitiveMarkers.join(" "),
    }),
  });
  const serialized = JSON.stringify(formatCrmForwardStageFailure(
    "clientPoolConstruction",
    error,
    CORRELATION_ID,
  ));
  assert.equal(JSON.parse(serialized).failureCategory, "unknown");
  for (const marker of sensitiveMarkers) assert.equal(serialized.includes(marker), false);
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    "correlationId",
    "failureCategory",
    "stageCode",
  ]);
});

test("invalid correlation identifiers are replaced rather than emitted", () => {
  const serialized = JSON.stringify(formatCrmForwardStageFailure(
    "urlValidation",
    { message: "hidden" },
    "secret-token-or-url",
  ));
  assert.equal(JSON.parse(serialized).correlationId, "unavailable");
  assert.equal(serialized.includes("secret-token-or-url"), false);
});

test("runner wires every failure stage and closes both client and pool in finally", async () => {
  const source = await readFile(new URL("../../script/crm-forward-migrate.ts", import.meta.url), "utf8");
  for (const stage of Object.keys(CRM_FORWARD_FAILURE_STAGE_CODES)) {
    assert.match(source, new RegExp(`setStage\\("${stage}"\\)`));
  }
  assert.match(source, /finally\s*\{[\s\S]*client\.release\(\)[\s\S]*pool\.end\(\)/);
  assert.match(source, /formatCrmForwardStageFailure/);
  assert.doesNotMatch(source, /error\.message|error\.stack|console\.(?:log|error)\(.*(?:connectionUrl|pgConfig)/);
});
