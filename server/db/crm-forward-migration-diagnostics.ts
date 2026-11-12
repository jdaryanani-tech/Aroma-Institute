export const CRM_FORWARD_FAILURE_STAGE_CODES = Object.freeze({
  urlValidation: "CRM_FORWARD_STAGE_URL_VALIDATION",
  clientPoolConstruction: "CRM_FORWARD_STAGE_CLIENT_POOL_CONSTRUCTION",
  tcpConnectionTlsNegotiation: "CRM_FORWARD_STAGE_TCP_TLS_CONNECTION",
  livePinnedIdentityVerification: "CRM_FORWARD_STAGE_PINNED_IDENTITY_VERIFICATION",
  readOnlyTransactionStart: "CRM_FORWARD_STAGE_READ_ONLY_TRANSACTION_START",
  migrationLedgerRead: "CRM_FORWARD_STAGE_MIGRATION_LEDGER_READ",
  prerequisiteSchemaDriftInspection: "CRM_FORWARD_STAGE_PREREQUISITE_SCHEMA_DRIFT_INSPECTION",
  previewPlanAssembly: "CRM_FORWARD_STAGE_PREVIEW_PLAN_ASSEMBLY",
} as const);

export type CrmForwardFailureStage = keyof typeof CRM_FORWARD_FAILURE_STAGE_CODES;

const MAX_CAUSE_DEPTH = 5;
const CAUSE_KEYS = ["cause", "original", "parent"] as const;
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

function safeFailureCategory(error: unknown): string {
  const visited = new Set<object>();
  let current: unknown = error;
  let best: { category: string; priority: number } | undefined;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || visited.has(current)) break;
    visited.add(current);

    const code = ownDataProperty(current, "code");
    if (typeof code === "string") {
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
]);

function safeUserFacingFailureCode(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || visited.has(current)) break;
    visited.add(current);
    const code = ownDataProperty(current, "code");
    if (typeof code === "string" && SAFE_USER_FACING_FAILURE_CODES.has(code)) return code;
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
  return undefined;
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
): {
  stageCode: string;
  failureCategory: string;
  failureCode?: string;
  correlationId: string;
} {
  const failureCode = safeUserFacingFailureCode(error);
  return {
    stageCode: CRM_FORWARD_FAILURE_STAGE_CODES[stage],
    failureCategory: safeFailureCategory(error),
    ...(failureCode ? { failureCode } : {}),
    correlationId: sanitizedCorrelationId(correlationId),
  };
}
