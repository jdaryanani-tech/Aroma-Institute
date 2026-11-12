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
      errorClass: "ERROR",
      correlationId: CORRELATION_ID,
    });
  }
});

test("CRM forward stage diagnostics use only recognized SQLSTATE and transport classes", () => {
  assert.equal(
    formatCrmForwardStageFailure(
      "tcpConnectionTlsNegotiation",
      Object.assign(new Error("hidden"), { code: "28P01" }),
      CORRELATION_ID,
    ).errorClass,
    "SQLSTATE_INVALID_AUTHORIZATION",
  );
  assert.equal(
    formatCrmForwardStageFailure(
      "tcpConnectionTlsNegotiation",
      Object.assign(new Error("hidden"), { code: "ECONNREFUSED" }),
      CORRELATION_ID,
    ).errorClass,
    "NETWORK_CONNECTION_REFUSED",
  );
  assert.equal(
    formatCrmForwardStageFailure(
      "tcpConnectionTlsNegotiation",
      Object.assign(new Error("hidden"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
      CORRELATION_ID,
    ).errorClass,
    "TLS_CERTIFICATE_NAME_REJECTED",
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
  });
  const serialized = JSON.stringify(formatCrmForwardStageFailure(
    "clientPoolConstruction",
    error,
    CORRELATION_ID,
  ));
  assert.equal(JSON.parse(serialized).errorClass, "UNKNOWN");
  for (const marker of sensitiveMarkers) assert.equal(serialized.includes(marker), false);
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    "correlationId",
    "errorClass",
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
