import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, Request } from "express";

export const META_LEADGEN_WEBHOOK_PATH = "/api/webhooks/meta/leadgen";

export type MetaWebhookReasonCode =
  | "body_parser_invalid_json"
  | "body_parser_body_too_large"
  | "body_parser_encoding_unsupported"
  | "body_parser_rejected"
  | "lead_ads_configuration_missing"
  | "signature_header_absent"
  | "signature_header_malformed"
  | "signature_raw_body_unavailable"
  | "signature_mismatch"
  | "meta_schema_not_ready"
  | "meta_schema_check_failed"
  | "raw_body_invalid_json"
  | "notification_envelope_invalid"
  | "notification_entry_invalid"
  | "notification_changes_invalid"
  | "notification_not_leadgen"
  | "notification_value_invalid"
  | "notification_lead_id_invalid"
  | "notification_page_id_invalid"
  | "notification_payload_invalid"
  | "configured_page_id_mismatch"
  | "form_allowlist_missing"
  | "notification_form_id_missing"
  | "graph_form_id_missing"
  | "notification_form_id_mismatch"
  | "form_id_not_allowed"
  | "graph_lead_fetch_http_failure"
  | "graph_lead_fetch_failed"
  | "database_persistence_failed"
  | "webhook_request_pipeline_failure";

export type MetaWebhookErrorCategory =
  | "graph_authentication_rejected"
  | "graph_permission_rejected"
  | "graph_http_4xx"
  | "graph_http_5xx"
  | "graph_transport_failure"
  | "graph_response_invalid_json"
  | "graph_response_invalid_shape"
  | "graph_configuration_unavailable"
  | "graph_failure_unclassified";

export type MetaGraphClassificationFallbackCode =
  | "graph_error_response_invalid_json"
  | "graph_error_response_invalid_shape"
  | "graph_error_metadata_missing"
  | "graph_error_metadata_unexpected_fields";

export type MetaGraphFailureDiagnostic = {
  upstreamHttpStatus: number;
  errorCategory: MetaWebhookErrorCategory;
  upstreamErrorType?: string;
  upstreamErrorCode?: number;
  upstreamErrorSubcode?: number;
  upstreamIsTransient?: boolean;
  classificationFallbackCode?: MetaGraphClassificationFallbackCode;
};

declare module "http" {
  interface IncomingMessage {
    metaWebhookRequestId?: string;
    metaWebhookDiagnosticRecorded?: boolean;
  }
}

export type MetaWebhookDiagnostic =
  | {
      event: "meta_webhook";
      requestId: string;
      outcome: "success";
    }
  | {
      event: "meta_webhook";
      requestId: string;
      stage:
        | "body_parser"
        | "configuration"
        | "signature"
        | "schema"
        | "raw_body"
        | "notification"
        | "page_validation"
        | "form_validation"
        | "graph_fetch"
        | "persistence"
        | "request_pipeline";
      reasonCode: MetaWebhookReasonCode;
      httpStatus?: number;
      upstreamHttpStatus?: number;
      errorCategory?: MetaWebhookErrorCategory;
      upstreamErrorType?: string;
      upstreamErrorCode?: number;
      upstreamErrorSubcode?: number;
      upstreamIsTransient?: boolean;
      classificationFallbackCode?: MetaGraphClassificationFallbackCode;
    };

export type MetaWebhookDiagnosticLogger = (entry: MetaWebhookDiagnostic) => void;

const defaultLogger: MetaWebhookDiagnosticLogger = (entry) => {
  console.info(JSON.stringify(entry));
};

export function isMetaLeadgenWebhookRequest(req: Request) {
  return req.method === "POST" && req.path === META_LEADGEN_WEBHOOK_PATH;
}

export function metaWebhookRequestIdMiddleware(req: Request, _res: unknown, next: (error?: unknown) => void) {
  if (isMetaLeadgenWebhookRequest(req)) {
    req.metaWebhookRequestId = randomUUID();
  }
  next();
}

export function getMetaWebhookRequestId(req: Request) {
  req.metaWebhookRequestId ??= randomUUID();
  return req.metaWebhookRequestId;
}

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export function emitMetaWebhookDiagnostic(
  req: Request,
  detail: Omit<Extract<MetaWebhookDiagnostic, { stage: string }>, "event" | "requestId">,
  logger: MetaWebhookDiagnosticLogger = defaultLogger,
) {
  const entry: MetaWebhookDiagnostic = {
    event: "meta_webhook",
    requestId: getMetaWebhookRequestId(req),
    stage: detail.stage,
    reasonCode: detail.reasonCode,
    ...(detail.httpStatus === undefined ? {} : { httpStatus: safeHttpStatus(detail.httpStatus) }),
    ...(detail.upstreamHttpStatus === undefined ? {} : { upstreamHttpStatus: safeHttpStatus(detail.upstreamHttpStatus) }),
    ...(detail.errorCategory === undefined ? {} : { errorCategory: detail.errorCategory }),
    ...(detail.upstreamErrorType === undefined ? {} : { upstreamErrorType: detail.upstreamErrorType }),
    ...(detail.upstreamErrorCode === undefined ? {} : { upstreamErrorCode: detail.upstreamErrorCode }),
    ...(detail.upstreamErrorSubcode === undefined ? {} : { upstreamErrorSubcode: detail.upstreamErrorSubcode }),
    ...(detail.upstreamIsTransient === undefined ? {} : { upstreamIsTransient: detail.upstreamIsTransient }),
    ...(detail.classificationFallbackCode === undefined ? {} : { classificationFallbackCode: detail.classificationFallbackCode }),
  };
  req.metaWebhookDiagnosticRecorded = true;
  logger(entry);
}

export function emitMetaWebhookSuccess(
  req: Request,
  logger: MetaWebhookDiagnosticLogger = defaultLogger,
) {
  const entry: MetaWebhookDiagnostic = {
    event: "meta_webhook",
    requestId: getMetaWebhookRequestId(req),
    outcome: "success",
  };
  req.metaWebhookDiagnosticRecorded = true;
  logger(entry);
}

function parserFailureDetails(error: unknown) {
  const value = error && typeof error === "object"
    ? error as { type?: unknown; status?: unknown; statusCode?: unknown }
    : {};
  const reasonCode: MetaWebhookReasonCode = value.type === "entity.parse.failed"
    ? "body_parser_invalid_json"
    : value.type === "entity.too.large"
      ? "body_parser_body_too_large"
      : value.type === "charset.unsupported" || value.type === "encoding.unsupported"
        ? "body_parser_encoding_unsupported"
        : "body_parser_rejected";
  return {
    reasonCode,
    httpStatus: safeHttpStatus(value.status) ?? safeHttpStatus(value.statusCode) ?? 400,
  };
}

export function metaWebhookBodyParserDiagnostic(
  logger: MetaWebhookDiagnosticLogger = defaultLogger,
): ErrorRequestHandler {
  return (error, req, _res, next) => {
    if (!isMetaLeadgenWebhookRequest(req)) return next(error);
    if (!req.metaWebhookDiagnosticRecorded) {
      const details = parserFailureDetails(error);
      emitMetaWebhookDiagnostic(req, {
        stage: "body_parser",
        reasonCode: details.reasonCode,
        httpStatus: details.httpStatus,
      }, logger);
    }
    return next(error);
  };
}

export function logMetaWebhookUnhandledError(
  req: Request,
  error: unknown,
  logger: MetaWebhookDiagnosticLogger = defaultLogger,
) {
  if (!isMetaLeadgenWebhookRequest(req)) return false;
  if (!req.metaWebhookDiagnosticRecorded) {
    const value = error && typeof error === "object"
      ? error as { status?: unknown; statusCode?: unknown }
      : {};
    emitMetaWebhookDiagnostic(req, {
      stage: "request_pipeline",
      reasonCode: "webhook_request_pipeline_failure",
      httpStatus: safeHttpStatus(value.status) ?? safeHttpStatus(value.statusCode),
    }, logger);
  }
  return true;
}
