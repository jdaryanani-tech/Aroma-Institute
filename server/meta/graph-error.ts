import type {
  MetaGraphClassificationFallbackCode,
  MetaGraphFailureDiagnostic,
  MetaWebhookErrorCategory,
} from "./webhook-diagnostics";

const SAFE_ERROR_TYPES = new Set([
  "ApiException",
  "Exception",
  "FacebookApiException",
  "GraphMethodException",
  "OAuthException",
  "ParameterException",
  "PermissionsError",
  "RateLimitException",
  "ServerException",
  "UserException",
]);

const MAX_META_ERROR_NUMBER = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function baseCategory(status: number): MetaWebhookErrorCategory {
  if (status >= 400 && status < 500) return "graph_http_4xx";
  if (status >= 500 && status < 600) return "graph_http_5xx";
  return "graph_failure_unclassified";
}

function fallback(
  status: number,
  classificationFallbackCode: MetaGraphClassificationFallbackCode,
): MetaGraphFailureDiagnostic {
  return {
    upstreamHttpStatus: status,
    errorCategory: baseCategory(status),
    classificationFallbackCode,
  };
}

function safeMetaNumber(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_META_ERROR_NUMBER;
}

/**
 * Select only bounded primitives from a parsed Graph error envelope.
 * Provider message, trace, URL, identifiers, and all other response fields
 * are intentionally ignored and are never attached to the returned object.
 */
export function classifyMetaGraphError(
  status: number,
  body: unknown,
): MetaGraphFailureDiagnostic {
  if (!isRecord(body) || !isRecord(body.error)) {
    return fallback(status, "graph_error_response_invalid_shape");
  }

  const error = body.error;
  const typePresent = Object.prototype.hasOwnProperty.call(error, "type");
  const codePresent = Object.prototype.hasOwnProperty.call(error, "code");
  const subcodePresent = Object.prototype.hasOwnProperty.call(error, "error_subcode");
  const transientPresent = Object.prototype.hasOwnProperty.call(error, "is_transient");
  const anyPresent = typePresent || codePresent || subcodePresent || transientPresent;
  if (!anyPresent) return fallback(status, "graph_error_metadata_missing");

  let errorType: string | undefined;
  let errorCode: number | undefined;
  let errorSubcode: number | undefined;
  let isTransient: boolean | undefined;

  if (typePresent) {
    if (typeof error.type !== "string" || !SAFE_ERROR_TYPES.has(error.type)) {
      return fallback(status, "graph_error_metadata_unexpected_fields");
    }
    errorType = error.type;
  }
  if (codePresent) {
    if (!safeMetaNumber(error.code)) {
      return fallback(status, "graph_error_metadata_unexpected_fields");
    }
    errorCode = error.code;
  }
  if (subcodePresent) {
    if (!safeMetaNumber(error.error_subcode)) {
      return fallback(status, "graph_error_metadata_unexpected_fields");
    }
    errorSubcode = error.error_subcode;
  }
  if (transientPresent) {
    if (typeof error.is_transient !== "boolean") {
      return fallback(status, "graph_error_metadata_unexpected_fields");
    }
    isTransient = error.is_transient;
  }

  let errorCategory = baseCategory(status);
  if (status >= 400 && status < 500) {
    if (errorCode === 190) errorCategory = "graph_authentication_rejected";
    else if (errorCode === 200) errorCategory = "graph_permission_rejected";
  }

  return {
    upstreamHttpStatus: status,
    errorCategory,
    ...(errorType === undefined ? {} : { upstreamErrorType: errorType }),
    ...(errorCode === undefined ? {} : { upstreamErrorCode: errorCode }),
    ...(errorSubcode === undefined ? {} : { upstreamErrorSubcode: errorSubcode }),
    ...(isTransient === undefined ? {} : { upstreamIsTransient: isTransient }),
  };
}

export class MetaGraphHttpError extends Error {
  readonly diagnostic: MetaGraphFailureDiagnostic;

  constructor(diagnostic: MetaGraphFailureDiagnostic) {
    super(`meta_graph_http_${diagnostic.upstreamHttpStatus}`);
    this.name = "MetaGraphHttpError";
    this.diagnostic = diagnostic;
  }
}

export async function createMetaGraphHttpError(
  status: number,
  parseJson: () => Promise<unknown>,
): Promise<MetaGraphHttpError> {
  try {
    return new MetaGraphHttpError(classifyMetaGraphError(status, await parseJson()));
  } catch {
    return new MetaGraphHttpError(fallback(status, "graph_error_response_invalid_json"));
  }
}
