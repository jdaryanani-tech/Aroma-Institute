import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCrmForwardLedgerDiagnostics,
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

test("stable Development-only guard codes remain visible without arbitrary error text", () => {
  const error = Object.assign(
    new Error("contains-secret-like-message"),
    { code: "CRM_FORWARD_INTERNAL_DEVELOPMENT_SSLMODE_DISABLE_REQUIRED" },
  );
  const diagnostic = formatCrmForwardStageFailure(
    "urlValidation",
    error,
    CORRELATION_ID,
  );
  assert.deepEqual(diagnostic, {
    stageCode: "CRM_FORWARD_STAGE_URL_VALIDATION",
    failureCategory: "development_non_tls_mode_required",
    failureCode: "CRM_FORWARD_INTERNAL_DEVELOPMENT_SSLMODE_DISABLE_REQUIRED",
    correlationId: CORRELATION_ID,
  });
  assert.equal(JSON.stringify(diagnostic).includes("contains-secret-like-message"), false);
});

test("app-role preflight blockers are reported as stable codes without raw errors", () => {
  for (const [code, category] of [
    ["APP_DATABASE_URL_NOT_CONFIGURED", "application_database_url_required"],
    ["APP_DATABASE_ENDPOINT_MISMATCH", "application_endpoint_mismatch"],
    ["APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED", "application_premigration_membership_rejected"],
  ] as const) {
    const diagnostic = formatCrmForwardStageFailure(
      "previewPlanAssembly",
      Object.assign(new Error("credential-like raw text"), { code }),
      CORRELATION_ID,
    );
    assert.equal(diagnostic.failureCode, code);
    assert.equal(diagnostic.failureCategory, category);
    assert.equal(JSON.stringify(diagnostic).includes("credential-like"), false);
  }
});

test("apply diagnostics preserve allowlisted wrapper and inner failure fields", () => {
  const sensitive = "credential-like raw text";
  const inner = Object.assign(new Error(sensitive), {
    code: "CRM_SCHEMA_POSTCONDITION_INDEX_METADATA_INVALID",
  });
  const wrapped = Object.assign(new Error(sensitive), {
    code: "CRM_FORWARD_MIGRATION_FAILED",
    cause: inner,
  });
  const diagnostic = formatCrmForwardStageFailure(
    "migrationPostcondition",
    wrapped,
    CORRELATION_ID,
    "0014_crm_canonical_assignments",
  );
  assert.deepEqual(diagnostic, {
    stageCode: "CRM_FORWARD_STAGE_MIGRATION_POSTCONDITION",
    failureCategory: "schema_postcondition_catalog_invalid",
    failureCode: "CRM_SCHEMA_POSTCONDITION_INDEX_METADATA_INVALID",
    migrationId: "0014_crm_canonical_assignments",
    correlationId: CORRELATION_ID,
  });
  assert.equal(JSON.stringify(diagnostic).includes(sensitive), false);
});

test("generic apply wrapper retains a safe SQLSTATE category without printing SQLSTATE", () => {
  const wrapped = Object.assign(new Error("hidden database text"), {
    code: "CRM_FORWARD_MIGRATION_FAILED",
    cause: Object.assign(new Error("hidden driver text"), { code: "42501" }),
  });
  const diagnostic = formatCrmForwardStageFailure(
    "migrationSqlExecution",
    wrapped,
    CORRELATION_ID,
    "0016_crm_runtime_role_separation",
  );
  assert.equal(diagnostic.failureCode, "CRM_FORWARD_MIGRATION_FAILED");
  assert.equal(diagnostic.failureCategory, "postgres_insufficient_privilege");
  assert.equal(diagnostic.migrationId, "0016_crm_runtime_role_separation");
  assert.doesNotMatch(JSON.stringify(diagnostic), /42501|hidden database text|hidden driver text/);
});

test("ledger diagnostics report control objects, row presence, migration status and checksum matches only", () => {
  const result = buildCrmForwardLedgerDiagnostics({
    schemaExists: true,
    tableExists: true,
    registeredMigrations: [
      { id: "0014_crm_canonical_assignments", sha256: "a".repeat(64) },
      { id: "0015_crm_assignment_audit_invariants", sha256: "b".repeat(64) },
      { id: "0016_crm_runtime_role_separation", sha256: "c".repeat(64) },
    ],
    ledgerRows: [
      { migration_id: "0014_crm_canonical_assignments", sha256: "a".repeat(64) },
      { migration_id: "0015_crm_assignment_audit_invariants", sha256: "d".repeat(64) },
    ],
  });
  assert.deepEqual(result, {
    schemaExists: true,
    tableExists: true,
    rowCount: 2,
    hasRows: true,
    migrations: [
      { id: "0014_crm_canonical_assignments", status: "applied", checksumMatches: true },
      { id: "0015_crm_assignment_audit_invariants", status: "applied", checksumMatches: false },
      { id: "0016_crm_runtime_role_separation", status: "pending", checksumMatches: null },
    ],
  });
  const serialized = JSON.stringify(result);
  for (const hash of ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)]) {
    assert.equal(serialized.includes(hash), false);
  }
});

test("ledger diagnostics report an absent empty ledger and redact unknown migration identifiers", () => {
  const result = buildCrmForwardLedgerDiagnostics({
    schemaExists: false,
    tableExists: false,
    registeredMigrations: [
      { id: "0014_crm_canonical_assignments", sha256: "a".repeat(64) },
      { id: "private_identifier", sha256: "b".repeat(64) },
    ],
    ledgerRows: [],
  });
  assert.deepEqual(result, {
    schemaExists: false,
    tableExists: false,
    rowCount: 0,
    hasRows: false,
    migrations: [
      { id: "0014_crm_canonical_assignments", status: "pending", checksumMatches: null },
      { id: "unrecognized", status: "pending", checksumMatches: null },
    ],
  });
  assert.equal(JSON.stringify(result).includes("private_identifier"), false);
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
    assert.match(source, new RegExp(`setStage\\("${stage}"(?:,\\s*migration\\.id)?\\)`));
  }
  assert.match(source, /finally\s*\{[\s\S]*client\.release\(\)[\s\S]*pool\.end\(\)/);
  assert.match(source, /formatCrmForwardStageFailure/);
  assert.doesNotMatch(source, /error\.message|error\.stack|console\.(?:log|error)\(.*(?:connectionUrl|pgConfig)/);
});
