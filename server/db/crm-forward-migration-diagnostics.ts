export const CRM_FORWARD_FAILURE_STAGE_CODES = Object.freeze({
  urlValidation: "CRM_FORWARD_STAGE_URL_VALIDATION",
  clientPoolConstruction: "CRM_FORWARD_STAGE_CLIENT_POOL_CONSTRUCTION",
  tcpConnectionTlsNegotiation: "CRM_FORWARD_STAGE_TCP_TLS_CONNECTION",
  livePinnedIdentityVerification: "CRM_FORWARD_STAGE_PINNED_IDENTITY_VERIFICATION",
  readOnlyTransactionStart: "CRM_FORWARD_STAGE_READ_ONLY_TRANSACTION_START",
  migrationLedgerRead: "CRM_FORWARD_STAGE_MIGRATION_LEDGER_READ",
  prerequisiteSchemaDriftInspection: "CRM_FORWARD_STAGE_PREREQUISITE_SCHEMA_DRIFT_INSPECTION",
  previewPlanAssembly: "CRM_FORWARD_STAGE_PREVIEW_PLAN_ASSEMBLY",
  advisoryLockAcquisition: "CRM_FORWARD_STAGE_ADVISORY_LOCK_ACQUISITION",
  lockedReplan: "CRM_FORWARD_STAGE_LOCKED_REPLAN",
  preApplyRoleGate: "CRM_FORWARD_STAGE_PRE_APPLY_ROLE_GATE",
  ledgerSchemaTableSetup: "CRM_FORWARD_STAGE_LEDGER_SCHEMA_TABLE_SETUP",
  migrationPrerequisiteCheck: "CRM_FORWARD_STAGE_MIGRATION_PREREQUISITE_CHECK",
  migrationSqlExecution: "CRM_FORWARD_STAGE_MIGRATION_SQL_EXECUTION",
  migrationPostcondition: "CRM_FORWARD_STAGE_MIGRATION_POSTCONDITION",
  migrationLedgerInsertCommit: "CRM_FORWARD_STAGE_MIGRATION_LEDGER_INSERT_COMMIT",
  advisoryUnlock: "CRM_FORWARD_STAGE_ADVISORY_UNLOCK",
  finalReadiness: "CRM_FORWARD_STAGE_FINAL_READINESS",
} as const);

export type CrmForwardFailureStage = keyof typeof CRM_FORWARD_FAILURE_STAGE_CODES;

const MAX_CAUSE_DEPTH = 5;
const CAUSE_KEYS = ["cause", "original", "parent"] as const;
const SAFE_MIGRATION_DIAGNOSTIC_IDS = new Set([
  "0014_crm_canonical_assignments",
  "0015_crm_assignment_audit_invariants",
  "0016_crm_runtime_role_separation",
  "0017_meta_lead_ads_schema",
  "0018_meta_phone_identity_diagnostics",
]);
const SAFE_FAILURE_CODES = new Map<string, { category: string; priority: number }>([
  ["CRM_FORWARD_INTERNAL_DEVELOPMENT_AICHM_URL_REQUIRED", { category: "development_secret_required", priority: 10 }],
  ["CRM_FORWARD_INTERNAL_DEVELOPMENT_RUNTIME_URL_REQUIRED", { category: "development_runtime_reference_required", priority: 10 }],
  ["CRM_FORWARD_INTERNAL_DEVELOPMENT_AICHM_URL_INVALID", { category: "development_secret_invalid", priority: 10 }],
  ["CRM_FORWARD_INTERNAL_DEVELOPMENT_RUNTIME_URL_INVALID", { category: "development_runtime_reference_invalid", priority: 10 }],
  ["CRM_FORWARD_INTERNAL_DEVELOPMENT_ENDPOINT_REQUIRED", { category: "internal_development_endpoint_required", priority: 10 }],
  ["CRM_FORWARD_INTERNAL_DEVELOPMENT_ENDPOINT_MISMATCH", { category: "development_endpoint_mismatch", priority: 10 }],
  ["CRM_FORWARD_INTERNAL_DEVELOPMENT_SSLMODE_DISABLE_REQUIRED", { category: "development_non_tls_mode_required", priority: 10 }],
  ["CRM_FORWARD_PRODUCTION_IDENTITY_REJECTED", { category: "production_identity_rejected", priority: 10 }],
  ["CRM_FORWARD_DEVELOPMENT_IDENTITY_MISMATCH", { category: "pinned_development_identity_mismatch", priority: 10 }],
  ["APP_DATABASE_URL_NOT_CONFIGURED", { category: "application_database_url_required", priority: 10 }],
  ["APP_DATABASE_URL_INVALID", { category: "application_database_url_invalid", priority: 10 }],
  ["APP_DATABASE_PLATFORM_REFERENCE_REQUIRED", { category: "application_runtime_reference_required", priority: 10 }],
  ["APP_DATABASE_PLATFORM_REFERENCE_INVALID", { category: "application_runtime_reference_invalid", priority: 10 }],
  ["APP_DATABASE_ENDPOINT_NOT_INTERNAL", { category: "application_endpoint_not_internal", priority: 10 }],
  ["APP_DATABASE_HOST_POLICY_REJECTED", { category: "application_host_policy_rejected", priority: 10 }],
  ["APP_DATABASE_NEON_SSLMODE_REQUIRED", { category: "application_neon_sslmode_required", priority: 10 }],
  ["APP_DATABASE_ENDPOINT_MISMATCH", { category: "application_endpoint_mismatch", priority: 10 }],
  ["APP_DATABASE_RUNTIME_IDENTITY_UNAVAILABLE", { category: "application_runtime_identity_unavailable", priority: 10 }],
  ["APP_DATABASE_RUNTIME_IDENTITY_REJECTED", { category: "application_runtime_identity_rejected", priority: 10 }],
  ["APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY", { category: "application_runtime_privileges_not_ready", priority: 10 }],
  ["APP_DATABASE_TARGET_MISMATCH", { category: "application_database_target_mismatch", priority: 10 }],
  ["APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE", { category: "application_premigration_identity_unavailable", priority: 10 }],
  ["APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH", { category: "application_premigration_identity_mismatch", priority: 10 }],
  ["APP_DATABASE_PREMIGRATION_LOGIN_REJECTED", { category: "application_premigration_login_rejected", priority: 10 }],
  ["APP_DATABASE_PREMIGRATION_GROUP_REJECTED", { category: "application_premigration_group_rejected", priority: 10 }],
  ["APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED", { category: "application_premigration_membership_rejected", priority: 10 }],
  ["APP_DATABASE_PREMIGRATION_ROLE_CHECK_FAILED", { category: "application_premigration_role_check_failed", priority: 10 }],
  ["CRM_FORWARD_APP_ROLE_PRECONDITION_FAILED", { category: "application_premigration_role_required", priority: 10 }],
  ["CRM_FORWARD_ADVISORY_LOCK_FAILED", { category: "advisory_lock_failed", priority: 2 }],
  ["CRM_FORWARD_LEDGER_SETUP_FAILED", { category: "migration_ledger_setup_failed", priority: 2 }],
  ["CRM_FORWARD_MIGRATION_FAILED", { category: "migration_failed", priority: 2 }],
  ["CRM_FORWARD_ADVISORY_UNLOCK_FAILED", { category: "advisory_unlock_failed", priority: 2 }],
  ["CRM_FORWARD_FINAL_RUNTIME_READINESS_FAILED", { category: "final_runtime_readiness_failed", priority: 2 }],
  ["CRM_FORWARD_REGISTRY_INVALID", { category: "migration_registry_invalid", priority: 10 }],
  ["CRM_FORWARD_DATABASE_IDENTITY_UNAVAILABLE", { category: "database_identity_unavailable", priority: 10 }],
  ["CRM_FORWARD_CONNECTION_ROLE_UNAVAILABLE", { category: "database_role_unavailable", priority: 10 }],
  ["CRM_FORWARD_REGISTRY_PATH_REJECTED", { category: "migration_registry_path_rejected", priority: 10 }],
  ["CRM_FORWARD_MIGRATION_TRANSACTION_WRAPPER_INVALID", { category: "migration_transaction_wrapper_invalid", priority: 10 }],
  ["CRM_FORWARD_BASE_PREREQUISITES_MISSING", { category: "base_prerequisites_missing", priority: 10 }],
  ["CRM_FORWARD_UNKNOWN_LEDGER_ENTRY", { category: "migration_ledger_drift", priority: 10 }],
  ["CRM_FORWARD_LEDGER_HASH_MISMATCH", { category: "migration_ledger_checksum_mismatch", priority: 10 }],
  ["CRM_FORWARD_0014_LEDGER_PREREQUISITE_MISSING", { category: "migration_ledger_prerequisite_missing", priority: 10 }],
  ["CRM_FORWARD_0015_LEDGER_PREREQUISITE_MISSING", { category: "migration_ledger_prerequisite_missing", priority: 10 }],
  ["CRM_FORWARD_0016_LEDGER_PREREQUISITE_MISSING", { category: "migration_ledger_prerequisite_missing", priority: 10 }],
  ["CRM_FORWARD_0017_LEDGER_PREREQUISITE_MISSING", { category: "migration_ledger_prerequisite_missing", priority: 10 }],
  ["CRM_META_SCHEMA_SCHEMA_REJECTED", { category: "schema_postcondition_schema_rejected", priority: 10 }],
  ["CRM_META_SCHEMA_BASE_PREREQUISITES_MISSING", { category: "schema_base_prerequisites_missing", priority: 10 }],
  ["CRM_META_SCHEMA_UNTRACKED_STATE", { category: "schema_postcondition_untracked_state", priority: 10 }],
  ["CRM_META_SCHEMA_TABLES_OR_OWNERSHIP_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_SCHEMA_COLUMNS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_SCHEMA_CONSTRAINTS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_PHONE_DIAGNOSTICS_SCHEMA_REJECTED", { category: "schema_postcondition_schema_rejected", priority: 10 }],
  ["CRM_META_PHONE_DIAGNOSTICS_SCHEMA_CONFLICT", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_PHONE_DIAGNOSTICS_COLUMNS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_PHONE_DIAGNOSTICS_CONSTRAINT_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_SCHEMA_INDEXES_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_SCHEMA_RUNTIME_GRANTS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_META_SCHEMA_SEQUENCE_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_CATALOG_ARRAY_INVALID", { category: "schema_postcondition_catalog_invalid", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_EXPECTED_CONSTRAINT_NAME_INVALID", { category: "schema_postcondition_definition_invalid", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_EXPECTED_CONSTRAINT_NAMES_COLLIDE", { category: "schema_postcondition_definition_invalid", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_EXPECTED_INDEX_NAMES_COLLIDE", { category: "schema_postcondition_definition_invalid", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_INDEX_METADATA_INVALID", { category: "schema_postcondition_catalog_invalid", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_SCHEMA_REJECTED", { category: "schema_postcondition_schema_rejected", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_TABLES_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_COLUMNS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_TRIGGERS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_FUNCTIONS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_HISTORY_GRANTS_DRIFTED", { category: "schema_postcondition_drift", priority: 10 }],
  ["CRM_SCHEMA_POSTCONDITION_UNTRACKED_STATE", { category: "schema_postcondition_untracked_state", priority: 10 }],
  ["CRM_RUNTIME_FUNCTION_SOURCE_MISSING", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_ROLE_SCHEMA_REJECTED", { category: "runtime_postcondition_schema_rejected", priority: 10 }],
  ["CRM_RUNTIME_ROLES_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_ROLE_MEMBERSHIP_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_ASSIGNMENT_TABLE_GRANTS_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_SEQUENCE_PRIVILEGES_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_OWNER_BASE_TABLE_PRIVILEGES_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_SCHEMA_PRIVILEGES_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_FUNCTIONS_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_ASSIGNMENT_FUNCTION_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_TRIGGER_FUNCTION_OWNERSHIP_DRIFTED", { category: "runtime_postcondition_drift", priority: 10 }],
  ["CRM_RUNTIME_ROLE_UNTRACKED_STATE", { category: "runtime_postcondition_untracked_state", priority: 10 }],
  ["42501", { category: "postgres_insufficient_privilege", priority: 5 }],
  ["ENOTFOUND", { category: "dns_resolution", priority: 5 }],
  ["EAI_AGAIN", { category: "dns_resolution", priority: 5 }],
  ["EAI_FAIL", { category: "dns_resolution", priority: 5 }],
  ["EAI_NODATA", { category: "dns_resolution", priority: 5 }],
  ["EAI_NONAME", { category: "dns_resolution", priority: 5 }],

  ["ECONNREFUSED", { category: "tcp_connection", priority: 5 }],
  ["ECONNRESET", { category: "tcp_connection", priority: 5 }],
  ["ETIMEDOUT", { category: "tcp_connection", priority: 5 }],
  ["EHOSTUNREACH", { category: "tcp_connection", priority: 5 }],
  ["ENETUNREACH", { category: "tcp_connection", priority: 5 }],
  ["ECONNABORTED", { category: "tcp_connection", priority: 5 }],
  ["EPIPE", { category: "tcp_connection", priority: 5 }],
  ["EADDRNOTAVAIL", { category: "tcp_connection", priority: 5 }],

  ["ERR_TLS_CERT_ALTNAME_INVALID", { category: "tls_hostname_verification", priority: 8 }],
  ["CERT_HAS_EXPIRED", { category: "tls_certificate_verification", priority: 7 }],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", { category: "tls_certificate_verification", priority: 7 }],
  ["SELF_SIGNED_CERT_IN_CHAIN", { category: "tls_certificate_verification", priority: 7 }],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", { category: "tls_certificate_verification", priority: 7 }],
  ["CERT_UNTRUSTED", { category: "tls_certificate_verification", priority: 7 }],
  ["ERR_SSL_PROTOCOL_ERROR", { category: "tls_protocol_negotiation", priority: 6 }],
  ["ERR_SSL_WRONG_VERSION_NUMBER", { category: "tls_protocol_negotiation", priority: 6 }],
  ["ERR_SSL_UNSUPPORTED_PROTOCOL", { category: "tls_protocol_negotiation", priority: 6 }],
  ["ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", { category: "tls_protocol_negotiation", priority: 6 }],
  ["ERR_TLS_HANDSHAKE_TIMEOUT", { category: "tls_protocol_negotiation", priority: 6 }],

  ["28P01", { category: "postgres_authentication", priority: 4 }],
  ["28000", { category: "postgres_authentication", priority: 4 }],
  ["08000", { category: "postgres_connection", priority: 3 }],
  ["08001", { category: "postgres_connection", priority: 3 }],
  ["08003", { category: "postgres_connection", priority: 3 }],
  ["08004", { category: "postgres_connection", priority: 3 }],
  ["08006", { category: "postgres_connection", priority: 3 }],
  ["08007", { category: "postgres_connection", priority: 3 }],
  ["08P01", { category: "postgres_connection", priority: 3 }],
]);

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function safeErrorToken(value: object): string | undefined {
  const code = ownDataProperty(value, "code");
  if (typeof code === "string" && SAFE_FAILURE_CODES.has(code)) return code;
  const message = ownDataProperty(value, "message");
  return typeof message === "string" && SAFE_FAILURE_CODES.has(message) ? message : undefined;
}

function safeFailureCategory(error: unknown): string {
  const visited = new Set<object>();
  let current: unknown = error;
  let best: { category: string; priority: number } | undefined;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || visited.has(current)) break;
    visited.add(current);

    const code = safeErrorToken(current);
    if (code) {
      const match = SAFE_FAILURE_CODES.get(code);
      if (match && (!best || match.priority > best.priority)) best = match;
    }

    let next: unknown;
    for (const key of CAUSE_KEYS) {
      const candidate = ownDataProperty(current, key);
      if (candidate && typeof candidate === "object") {
        next = candidate;
        break;
      }
    }
    current = next;
  }

  return best?.category ?? "unknown";
}

const SAFE_USER_FACING_FAILURE_CODES = new Set([
  "CRM_FORWARD_INTERNAL_DEVELOPMENT_AICHM_URL_REQUIRED",
  "CRM_FORWARD_INTERNAL_DEVELOPMENT_RUNTIME_URL_REQUIRED",
  "CRM_FORWARD_INTERNAL_DEVELOPMENT_AICHM_URL_INVALID",
  "CRM_FORWARD_INTERNAL_DEVELOPMENT_RUNTIME_URL_INVALID",
  "CRM_FORWARD_INTERNAL_DEVELOPMENT_ENDPOINT_REQUIRED",
  "CRM_FORWARD_INTERNAL_DEVELOPMENT_ENDPOINT_MISMATCH",
  "CRM_FORWARD_INTERNAL_DEVELOPMENT_SSLMODE_DISABLE_REQUIRED",
  "CRM_FORWARD_PRODUCTION_IDENTITY_REJECTED",
  "CRM_FORWARD_DEVELOPMENT_IDENTITY_MISMATCH",
  "APP_DATABASE_URL_NOT_CONFIGURED",
  "APP_DATABASE_URL_INVALID",
  "APP_DATABASE_PLATFORM_REFERENCE_REQUIRED",
  "APP_DATABASE_PLATFORM_REFERENCE_INVALID",
  "APP_DATABASE_ENDPOINT_NOT_INTERNAL",
  "APP_DATABASE_HOST_POLICY_REJECTED",
  "APP_DATABASE_NEON_SSLMODE_REQUIRED",
  "APP_DATABASE_ENDPOINT_MISMATCH",
  "APP_DATABASE_RUNTIME_IDENTITY_UNAVAILABLE",
  "APP_DATABASE_RUNTIME_IDENTITY_REJECTED",
  "APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY",
  "APP_DATABASE_TARGET_MISMATCH",
  "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE",
  "APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH",
  "APP_DATABASE_PREMIGRATION_LOGIN_REJECTED",
  "APP_DATABASE_PREMIGRATION_GROUP_REJECTED",
  "APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED",
  "APP_DATABASE_PREMIGRATION_ROLE_CHECK_FAILED",
  "CRM_FORWARD_APP_ROLE_PRECONDITION_FAILED",
  "CRM_FORWARD_ADVISORY_LOCK_FAILED",
  "CRM_FORWARD_LEDGER_SETUP_FAILED",
  "CRM_FORWARD_MIGRATION_FAILED",
  "CRM_FORWARD_ADVISORY_UNLOCK_FAILED",
  "CRM_FORWARD_FINAL_RUNTIME_READINESS_FAILED",
  "CRM_FORWARD_REGISTRY_INVALID",
  "CRM_FORWARD_DATABASE_IDENTITY_UNAVAILABLE",
  "CRM_FORWARD_CONNECTION_ROLE_UNAVAILABLE",
  "CRM_FORWARD_REGISTRY_PATH_REJECTED",
  "CRM_FORWARD_MIGRATION_TRANSACTION_WRAPPER_INVALID",
  "CRM_FORWARD_BASE_PREREQUISITES_MISSING",
  "CRM_FORWARD_UNKNOWN_LEDGER_ENTRY",
  "CRM_FORWARD_LEDGER_HASH_MISMATCH",
  "CRM_FORWARD_0014_LEDGER_PREREQUISITE_MISSING",
  "CRM_FORWARD_0015_LEDGER_PREREQUISITE_MISSING",
  "CRM_FORWARD_0016_LEDGER_PREREQUISITE_MISSING",
  "CRM_FORWARD_0017_LEDGER_PREREQUISITE_MISSING",
  "CRM_META_SCHEMA_SCHEMA_REJECTED",
  "CRM_META_SCHEMA_BASE_PREREQUISITES_MISSING",
  "CRM_META_SCHEMA_UNTRACKED_STATE",
  "CRM_META_SCHEMA_TABLES_OR_OWNERSHIP_DRIFTED",
  "CRM_META_SCHEMA_COLUMNS_DRIFTED",
  "CRM_META_SCHEMA_CONSTRAINTS_DRIFTED",
  "CRM_META_PHONE_DIAGNOSTICS_SCHEMA_REJECTED",
  "CRM_META_PHONE_DIAGNOSTICS_SCHEMA_CONFLICT",
  "CRM_META_PHONE_DIAGNOSTICS_COLUMNS_DRIFTED",
  "CRM_META_PHONE_DIAGNOSTICS_CONSTRAINT_DRIFTED",
  "CRM_META_SCHEMA_INDEXES_DRIFTED",
  "CRM_META_SCHEMA_RUNTIME_GRANTS_DRIFTED",
  "CRM_META_SCHEMA_SEQUENCE_DRIFTED",
  "CRM_SCHEMA_POSTCONDITION_CATALOG_ARRAY_INVALID",
  "CRM_SCHEMA_POSTCONDITION_EXPECTED_CONSTRAINT_NAME_INVALID",
  "CRM_SCHEMA_POSTCONDITION_EXPECTED_CONSTRAINT_NAMES_COLLIDE",
  "CRM_SCHEMA_POSTCONDITION_EXPECTED_INDEX_NAMES_COLLIDE",
  "CRM_SCHEMA_POSTCONDITION_INDEX_METADATA_INVALID",
  "CRM_SCHEMA_POSTCONDITION_SCHEMA_REJECTED",
  "CRM_SCHEMA_POSTCONDITION_TABLES_DRIFTED",
  "CRM_SCHEMA_POSTCONDITION_COLUMNS_DRIFTED",
  "CRM_SCHEMA_POSTCONDITION_TRIGGERS_DRIFTED",
  "CRM_SCHEMA_POSTCONDITION_FUNCTIONS_DRIFTED",
  "CRM_SCHEMA_POSTCONDITION_HISTORY_GRANTS_DRIFTED",
  "CRM_SCHEMA_POSTCONDITION_UNTRACKED_STATE",
  "CRM_RUNTIME_FUNCTION_SOURCE_MISSING",
  "CRM_RUNTIME_ROLE_SCHEMA_REJECTED",
  "CRM_RUNTIME_ROLES_DRIFTED",
  "CRM_RUNTIME_ROLE_MEMBERSHIP_DRIFTED",
  "CRM_RUNTIME_ASSIGNMENT_TABLE_GRANTS_DRIFTED",
  "CRM_RUNTIME_SEQUENCE_PRIVILEGES_DRIFTED",
  "CRM_RUNTIME_OWNER_BASE_TABLE_PRIVILEGES_DRIFTED",
  "CRM_RUNTIME_SCHEMA_PRIVILEGES_DRIFTED",
  "CRM_RUNTIME_FUNCTIONS_DRIFTED",
  "CRM_RUNTIME_ASSIGNMENT_FUNCTION_DRIFTED",
  "CRM_RUNTIME_TRIGGER_FUNCTION_OWNERSHIP_DRIFTED",
  "CRM_RUNTIME_ROLE_UNTRACKED_STATE",
]);

function safeUserFacingFailureCode(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  let best: { code: string; priority: number } | undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || visited.has(current)) break;
    visited.add(current);
    const code = safeErrorToken(current);
    if (code && SAFE_USER_FACING_FAILURE_CODES.has(code)) {
      const priority = SAFE_FAILURE_CODES.get(code)?.priority ?? 1;
      if (!best || priority >= best.priority) best = { code, priority };
    }
    let next: unknown;
    for (const key of CAUSE_KEYS) {
      const candidate = ownDataProperty(current, key);
      if (candidate && typeof candidate === "object") {
        next = candidate;
        break;
      }
    }
    current = next;
  }
  return best?.code;
}

export type CrmForwardLedgerDiagnosticInput = {
  schemaExists: boolean;
  tableExists: boolean;
  registeredMigrations: Array<{ id: string; sha256: string }>;
  ledgerRows: Array<{ migration_id: string; sha256: string }>;
};

export function buildCrmForwardLedgerDiagnostics(input: CrmForwardLedgerDiagnosticInput) {
  const rowsById = new Map(input.ledgerRows.map(row => [row.migration_id, row.sha256]));
  return {
    schemaExists: input.schemaExists,
    tableExists: input.tableExists,
    rowCount: input.ledgerRows.length,
    hasRows: input.ledgerRows.length > 0,
    migrations: input.registeredMigrations.map(migration => {
      const id = SAFE_MIGRATION_DIAGNOSTIC_IDS.has(migration.id) ? migration.id : "unrecognized";
      const recordedHash = rowsById.get(migration.id);
      return {
        id,
        status: recordedHash === undefined ? "pending" as const : "applied" as const,
        checksumMatches: recordedHash === undefined ? null : recordedHash === migration.sha256,
      };
    }),
  };
}

function sanitizedCorrelationId(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : "unavailable";
}

export function formatCrmForwardStageFailure(
  stage: CrmForwardFailureStage,
  error: unknown,
  correlationId: string,
  migrationId?: string,
): {
  stageCode: string;
  failureCategory: string;
  failureCode?: string;
  migrationId?: string;
  correlationId: string;
} {
  const failureCode = safeUserFacingFailureCode(error);
  const safeMigrationId = migrationId && SAFE_MIGRATION_DIAGNOSTIC_IDS.has(migrationId)
    ? migrationId
    : undefined;
  return {
    stageCode: CRM_FORWARD_FAILURE_STAGE_CODES[stage],
    failureCategory: safeFailureCategory(error),
    ...(failureCode ? { failureCode } : {}),
    ...(safeMigrationId ? { migrationId: safeMigrationId } : {}),
    correlationId: sanitizedCorrelationId(correlationId),
  };
}
