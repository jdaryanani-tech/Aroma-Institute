import type { Request, Response } from "express";
import { safeMetaWebhookFailureStatus } from "./config";
import { MetaGraphHttpError } from "./graph-error";
import {
  emitMetaWebhookDiagnostic,
  emitMetaWebhookSuccess,
  type MetaGraphClassificationFallbackCode,
  type MetaWebhookErrorCategory,
  type MetaWebhookDiagnosticLogger,
  type MetaWebhookReasonCode,
} from "./webhook-diagnostics";

export type MetaFetchedLead = {
  id?: unknown;
  created_time?: unknown;
  field_data?: unknown;
  ad_id?: unknown;
  adset_id?: unknown;
  campaign_id?: unknown;
  form_id?: unknown;
};

type MetaNotification = {
  leadId: string;
  pageId: string;
  formId: string | null;
};

type NotificationParseResult = {
  notifications: MetaNotification[];
  reasonCode?: MetaWebhookReasonCode;
};

type PersistMetaLeadInput = {
  metaLeadId: string;
  pageId: string;
  formId: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  leadCreatedAt: Date | null;
  fieldData: unknown;
};

export type MetaLeadgenHandlerDependencies = {
  isConfigured: () => boolean;
  verifySignature: (rawBody: unknown, signature: string) => boolean;
  isSchemaReady: () => Promise<boolean>;
  expectedPageId: () => string | undefined;
  fetchLead: (leadId: string) => Promise<MetaFetchedLead>;
  persistLead: (input: PersistMetaLeadInput) => Promise<unknown>;
  logger?: MetaWebhookDiagnosticLogger;
};

const NUMERIC_PROVIDER_ID = /^[0-9]{1,40}$/;
const SIGNATURE_HEADER = /^sha256=[a-f0-9]{64}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseNotifications(body: unknown): NotificationParseResult {
  if (!isObject(body) || !Array.isArray(body.entry)) {
    return { notifications: [], reasonCode: "notification_envelope_invalid" };
  }

  const entries = body.entry;
  if (entries.length === 0) return { notifications: [], reasonCode: "notification_entry_invalid" };

  const notifications: MetaNotification[] = [];
  let sawEntry = false;
  let sawChanges = false;
  let sawNonEmptyChanges = false;
  let sawLeadgen = false;
  let sawLeadgenValue = false;
  let sawInvalidLeadId = false;
  let sawInvalidPageId = false;
  let sawInvalidValue = false;

  for (const entry of entries) {
    if (!isObject(entry)) continue;
    sawEntry = true;
    if (!Array.isArray(entry.changes)) continue;
    sawChanges = true;
    if (entry.changes.length) sawNonEmptyChanges = true;

    for (const change of entry.changes) {
      if (!isObject(change) || change.field !== "leadgen") continue;
      sawLeadgen = true;
      if (!isObject(change.value)) {
        sawInvalidValue = true;
        continue;
      }

      sawLeadgenValue = true;
      const value = change.value;
      const leadId = typeof value.leadgen_id === "string" ? value.leadgen_id : "";
      const pageId = String(value.page_id ?? entry.id ?? "");
      const formId = typeof value.form_id === "string" ? value.form_id : null;
      const validLeadId = NUMERIC_PROVIDER_ID.test(leadId);
      const validPageId = NUMERIC_PROVIDER_ID.test(pageId);
      if (!validLeadId) sawInvalidLeadId = true;
      if (!validPageId) sawInvalidPageId = true;
      if (validLeadId && validPageId) notifications.push({ leadId, pageId, formId });
    }
  }

  if (notifications.length) return { notifications };
  if (!sawEntry) return { notifications, reasonCode: "notification_entry_invalid" };
  if (!sawChanges) return { notifications, reasonCode: "notification_changes_invalid" };
  if (!sawNonEmptyChanges) return { notifications, reasonCode: "notification_changes_invalid" };
  if (!sawLeadgen) return { notifications, reasonCode: "notification_not_leadgen" };
  if (sawInvalidValue && !sawLeadgenValue) return { notifications, reasonCode: "notification_value_invalid" };
  if (sawInvalidLeadId) return { notifications, reasonCode: "notification_lead_id_invalid" };
  if (sawInvalidPageId) return { notifications, reasonCode: "notification_page_id_invalid" };
  if (sawInvalidValue) return { notifications, reasonCode: "notification_value_invalid" };
  return { notifications, reasonCode: "notification_changes_invalid" };
}

function graphFetchFailure(error: unknown): {
  reasonCode: "graph_lead_fetch_http_failure" | "graph_lead_fetch_failed";
  upstreamHttpStatus?: number;
  errorCategory: MetaWebhookErrorCategory;
  upstreamErrorType?: string;
  upstreamErrorCode?: number;
  upstreamErrorSubcode?: number;
  upstreamIsTransient?: boolean;
  classificationFallbackCode?: MetaGraphClassificationFallbackCode;
} {
  if (error instanceof MetaGraphHttpError) {
    return {
      reasonCode: "graph_lead_fetch_http_failure",
      ...error.diagnostic,
    };
  }
  const message = error instanceof Error ? error.message : "";
  const httpMatch = /^meta_graph_http_(4\d\d|5\d\d)$/.exec(message);
  if (httpMatch) {
    const upstreamHttpStatus = Number(httpMatch[1]);
    return {
      reasonCode: "graph_lead_fetch_http_failure",
      upstreamHttpStatus,
      errorCategory: upstreamHttpStatus < 500 ? "graph_http_4xx" : "graph_http_5xx",
    };
  }
  if (message === "meta_graph_network_error") {
    return { reasonCode: "graph_lead_fetch_failed", errorCategory: "graph_transport_failure" };
  }
  if (message === "meta_graph_invalid_json") {
    return { reasonCode: "graph_lead_fetch_failed", errorCategory: "graph_response_invalid_json" };
  }
  if (message === "meta_graph_invalid_lead") {
    return { reasonCode: "graph_lead_fetch_failed", errorCategory: "graph_response_invalid_shape" };
  }
  if (message === "meta_not_configured") {
    return { reasonCode: "graph_lead_fetch_failed", errorCategory: "graph_configuration_unavailable" };
  }
  return { reasonCode: "graph_lead_fetch_failed", errorCategory: "graph_failure_unclassified" };
}

export function createMetaLeadgenHandler(deps: MetaLeadgenHandlerDependencies) {
  return async (req: Request, res: Response) => {
    const logger = deps.logger;
    const diagnostic = (detail: Parameters<typeof emitMetaWebhookDiagnostic>[1]) =>
      emitMetaWebhookDiagnostic(req, detail, logger);

    if (!deps.isConfigured()) {
      diagnostic({ stage: "configuration", reasonCode: "lead_ads_configuration_missing", httpStatus: 503 });
      return void res.sendStatus(503);
    }

    const signature = req.get("x-hub-signature-256") ?? "";
    if (!signature) {
      diagnostic({ stage: "signature", reasonCode: "signature_header_absent", httpStatus: 401 });
      return void res.sendStatus(401);
    }
    if (!SIGNATURE_HEADER.test(signature)) {
      diagnostic({ stage: "signature", reasonCode: "signature_header_malformed", httpStatus: 401 });
      return void res.sendStatus(401);
    }
    if (!Buffer.isBuffer(req.rawBody)) {
      diagnostic({ stage: "signature", reasonCode: "signature_raw_body_unavailable", httpStatus: 401 });
      return void res.sendStatus(401);
    }
    if (!deps.verifySignature(req.rawBody, signature)) {
      diagnostic({ stage: "signature", reasonCode: "signature_mismatch", httpStatus: 401 });
      return void res.sendStatus(401);
    }

    try {
      if (!await deps.isSchemaReady()) {
        diagnostic({ stage: "schema", reasonCode: "meta_schema_not_ready", httpStatus: 503 });
        return void res.sendStatus(503);
      }
    } catch {
      diagnostic({ stage: "schema", reasonCode: "meta_schema_check_failed", httpStatus: 503 });
      return void res.sendStatus(503);
    }

    let body: unknown;
    try {
      body = Buffer.isBuffer(req.rawBody) ? JSON.parse(req.rawBody.toString("utf8")) : req.body;
    } catch {
      diagnostic({ stage: "raw_body", reasonCode: "raw_body_invalid_json", httpStatus: 400 });
      return void res.sendStatus(400);
    }

    const parsed = parseNotifications(body);
    if (!parsed.notifications.length) {
      diagnostic({
        stage: "notification",
        reasonCode: parsed.reasonCode ?? "notification_payload_invalid",
        httpStatus: 400,
      });
      return void res.sendStatus(400);
    }

    const expectedPage = deps.expectedPageId()?.trim();
    if (parsed.notifications.some((notification) => notification.pageId !== expectedPage)) {
      diagnostic({ stage: "page_validation", reasonCode: "configured_page_id_mismatch", httpStatus: 403 });
      return void res.sendStatus(403);
    }

    for (const notification of parsed.notifications) {
      let lead: MetaFetchedLead;
      try {
        lead = await deps.fetchLead(notification.leadId);
      } catch (error) {
        const failure = graphFetchFailure(error);
        diagnostic({
          stage: "graph_fetch",
          reasonCode: failure.reasonCode,
          httpStatus: safeMetaWebhookFailureStatus(error),
          ...(failure.upstreamHttpStatus === undefined ? {} : { upstreamHttpStatus: failure.upstreamHttpStatus }),
          errorCategory: failure.errorCategory,
          ...(failure.upstreamErrorType === undefined ? {} : { upstreamErrorType: failure.upstreamErrorType }),
          ...(failure.upstreamErrorCode === undefined ? {} : { upstreamErrorCode: failure.upstreamErrorCode }),
          ...(failure.upstreamErrorSubcode === undefined ? {} : { upstreamErrorSubcode: failure.upstreamErrorSubcode }),
          ...(failure.upstreamIsTransient === undefined ? {} : { upstreamIsTransient: failure.upstreamIsTransient }),
          ...(failure.classificationFallbackCode === undefined ? {} : { classificationFallbackCode: failure.classificationFallbackCode }),
        });
        return void res.status(safeMetaWebhookFailureStatus(error)).json({
          message: "Meta lead notification could not be processed. It is safe for Meta to retry.",
        });
      }

      const created = typeof lead.created_time === "string" ? new Date(lead.created_time) : null;
      try {
        await deps.persistLead({
          metaLeadId: notification.leadId,
          pageId: notification.pageId,
          formId: typeof lead.form_id === "string" ? lead.form_id : notification.formId,
          adId: typeof lead.ad_id === "string" ? lead.ad_id : null,
          adsetId: typeof lead.adset_id === "string" ? lead.adset_id : null,
          campaignId: typeof lead.campaign_id === "string" ? lead.campaign_id : null,
          leadCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
          fieldData: lead.field_data,
        });
      } catch (error) {
        const status = safeMetaWebhookFailureStatus(error);
        diagnostic({ stage: "persistence", reasonCode: "database_persistence_failed", httpStatus: status });
        return void res.status(status).json({
          message: "Meta lead notification could not be processed. It is safe for Meta to retry.",
        });
      }
    }

    emitMetaWebhookSuccess(req, logger);
    return void res.sendStatus(200);
  };
}
