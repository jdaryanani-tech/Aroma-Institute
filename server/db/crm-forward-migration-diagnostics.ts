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

const SQLSTATE_CLASSES = new Map<string, string>([
  ["08", "SQLSTATE_CONNECTION_EXCEPTION"],
  ["22", "SQLSTATE_DATA_EXCEPTION"],
  ["23", "SQLSTATE_INTEGRITY_CONSTRAINT"],
  ["25", "SQLSTATE_INVALID_TRANSACTION_STATE"],
  ["28", "SQLSTATE_INVALID_AUTHORIZATION"],
  ["40", "SQLSTATE_TRANSACTION_ROLLBACK"],
  ["42", "SQLSTATE_SYNTAX_OR_ACCESS_RULE"],
  ["53", "SQLSTATE_INSUFFICIENT_RESOURCES"],
  ["55", "SQLSTATE_OBJECT_NOT_IN_PREREQUISITE_STATE"],
  ["57", "SQLSTATE_OPERATOR_INTERVENTION"],
  ["58", "SQLSTATE_SYSTEM_ERROR"],
]);

const SAFE_DRIVER_CODES = new Map<string, string>([
  ["ECONNREFUSED", "NETWORK_CONNECTION_REFUSED"],
  ["ECONNRESET", "NETWORK_CONNECTION_RESET"],
  ["ETIMEDOUT", "NETWORK_TIMEOUT"],
  ["EHOSTUNREACH", "NETWORK_HOST_UNREACHABLE"],
  ["ENETUNREACH", "NETWORK_UNREACHABLE"],
  ["ENOTFOUND", "DNS_LOOKUP_FAILED"],
  ["EAI_AGAIN", "DNS_TEMPORARY_FAILURE"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_CERTIFICATE_NAME_REJECTED"],
  ["CERT_HAS_EXPIRED", "TLS_CERTIFICATE_EXPIRED"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "TLS_CERTIFICATE_CHAIN_REJECTED"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "TLS_CERTIFICATE_CHAIN_REJECTED"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS_CERTIFICATE_CHAIN_REJECTED"],
  ["ERR_SSL_PROTOCOL_ERROR", "TLS_PROTOCOL_ERROR"],
]);

const SAFE_ERROR_NAMES = new Map<string, string>([
  ["Error", "ERROR"],
  ["TypeError", "TYPE_ERROR"],
  ["RangeError", "RANGE_ERROR"],
  ["SyntaxError", "SYNTAX_ERROR"],
  ["URIError", "URI_ERROR"],
  ["TimeoutError", "TIMEOUT_ERROR"],
  ["AbortError", "ABORT_ERROR"],
]);

function sanitizedErrorClass(error: unknown): string {
  if (!error || typeof error !== "object") return "UNKNOWN";

  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate.code === "string") {
    const code = candidate.code;
    if (/^[0-9A-Z]{5}$/.test(code)) {
      const sqlStateClass = SQLSTATE_CLASSES.get(code.slice(0, 2));
      if (sqlStateClass) return sqlStateClass;
    }
    const driverClass = SAFE_DRIVER_CODES.get(code);
    if (driverClass) return driverClass;
  }

  if (typeof candidate.name === "string") {
    return SAFE_ERROR_NAMES.get(candidate.name) ?? "UNKNOWN";
  }
  return "UNKNOWN";
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
  errorClass: string;
  correlationId: string;
} {
  return {
    stageCode: CRM_FORWARD_FAILURE_STAGE_CODES[stage],
    errorClass: sanitizedErrorClass(error),
    correlationId: sanitizedCorrelationId(correlationId),
  };
}
