import { randomUUID } from "node:crypto";
import type { Express, RequestHandler } from "express";
import { pool } from "../db";
import { requireLmsRole, requireLmsUser } from "../lms/auth";
import { sameOriginCapture } from "../admissions/routes";
import { saveMetaInstantLead } from "../admissions/identity";
import {
  META_CONSENT_POLICY_VERSION, buildMetaCapiPayload, capiRetryDelayMs,
  getMetaReadiness, isAcknowledgedCapiResponse,
  isValidMetaChallenge, parseMetaAllowedFormIds, verifyMetaWebhookSignature,
} from "./config";
import { safeMetaEventSourceUrl, visitorKey } from "./http";
import { enqueueMetaEvent } from "./events";
import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import { admissionsMarketingConsentEvents } from "@shared/admissions-schema";
import type { MetaFetchedLead } from "./webhook-handler";
import { createMetaLeadgenHandler } from "./webhook-handler";
import { createMetaGraphHttpError } from "./graph-error";
import { META_LEADGEN_WEBHOOK_PATH } from "./webhook-diagnostics";
import { runMetaPageSubscription, type MetaGraphFetch } from "./page-subscription";

export const META_LEAD_ADS_DIAGNOSTICS_PATH = "/api/admin/meta/lead-ads-diagnostics";

export function registerMetaLeadAdsDiagnosticsRoute(
  app: Express,
  options: {
    authenticate?: RequestHandler;
    authorizeAdmin?: RequestHandler;
    environment?: () => NodeJS.ProcessEnv;
    fetcher?: MetaGraphFetch;
  } = {},
) {
  const authenticate = options.authenticate ?? requireLmsUser;
  const authorizeAdmin = options.authorizeAdmin ?? requireLmsRole("admin");
  app.get(META_LEAD_ADS_DIAGNOSTICS_PATH, authenticate, authorizeAdmin, async (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    const environment = options.environment?.() ?? process.env;
    const diagnostic = await runMetaPageSubscription({
      META_PAGE_ID: environment.META_PAGE_ID,
      META_APP_ID: environment.META_APP_ID,
      META_PAGE_ACCESS_TOKEN: environment.META_PAGE_ACCESS_TOKEN,
      META_GRAPH_API_VERSION: environment.META_GRAPH_API_VERSION,
    }, {
      apply: false,
      confirmationMatches: false,
      fetcher: options.fetcher,
    });
    return void res.json({
      ...diagnostic,
      requestApplied: false,
      diagnosticOnly: true,
    });
  });
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

const metaLeadFields = "id,created_time,field_data,ad_id,form_id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function consentStatus(visitorKeyHash: string) {
  const [latest] = await db.select({
    status: admissionsMarketingConsentEvents.consentStatus,
    policyVersion: admissionsMarketingConsentEvents.policyVersion,
    occurredAt: admissionsMarketingConsentEvents.occurredAt,
    source: admissionsMarketingConsentEvents.source,
  }).from(admissionsMarketingConsentEvents)
    .where(eq(admissionsMarketingConsentEvents.visitorKeyHash, visitorKeyHash))
    .orderBy(desc(admissionsMarketingConsentEvents.occurredAt), desc(admissionsMarketingConsentEvents.id))
    .limit(1);
  return latest ?? null;
}

function isCurrentGrant(status: { status?: string; policyVersion?: string } | null) {
  return status?.status === "granted" && status.policyVersion === META_CONSENT_POLICY_VERSION;
}

async function fetchMetaLead(leadId: string) {
  const ready = getMetaReadiness();
  if (!ready.leadAds.configured) throw new Error("meta_not_configured");
  const version = process.env.META_GRAPH_API_VERSION!.trim();
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(leadId)}`);
  url.searchParams.set("fields", metaLeadFields);
  url.searchParams.set("access_token", process.env.META_PAGE_ACCESS_TOKEN!.trim());
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new Error("meta_graph_network_error");
  }
  if (!response.ok) throw await createMetaGraphHttpError(response.status, () => response.json());
  let body: MetaFetchedLead;
  try {
    body = await response.json() as MetaFetchedLead;
  } catch {
    throw new Error("meta_graph_invalid_json");
  }
  if (typeof body.id !== "string" || body.id !== leadId || !body.field_data) {
    throw new Error("meta_graph_invalid_lead");
  }
  if (typeof body.ad_id === "string" && body.ad_id) {
    const adUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(body.ad_id)}`);
    adUrl.searchParams.set("fields", "id,campaign_id,adset_id");
    adUrl.searchParams.set("access_token", process.env.META_PAGE_ACCESS_TOKEN!.trim());
    try {
      const adResponse = await fetch(adUrl, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (adResponse.ok) {
        const ad = await adResponse.json() as { campaign_id?: unknown; adset_id?: unknown };
        if (typeof ad.campaign_id === "string") body.campaign_id = ad.campaign_id;
        if (typeof ad.adset_id === "string") body.adset_id = ad.adset_id;
      }
    } catch {
      // Ads metadata is optional; the lead itself remains valid without it.
    }
  }
  return body;
}

async function dispatchOneMetaEvent() {
  const readiness = getMetaReadiness();
  if (!readiness.capi.enabled) return { state: "disabled" as const };

  const client = await pool.connect();
  let event: {
    event_id: string; visitor_key_hash: string; event_name: string; event_time: Date;
    event_source_url: string; custom_data: Record<string, string | number | boolean>;
    attempt_count: number; lock_token: string;
  } | undefined;
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE admissions_meta_event_outbox SET state='failed',available_at=now(),
      last_error='delivery_lease_expired',locked_at=NULL,lock_token=NULL
      WHERE state='sending' AND locked_at < now()-interval '2 minutes' AND attempt_count<8`);
    await client.query(`
      UPDATE admissions_meta_event_outbox e SET state='suppressed', last_error='marketing_consent_not_active'
      WHERE e.state IN ('pending','failed') AND e.available_at<=now()
        AND NOT EXISTS (
          SELECT 1 FROM admissions_marketing_consent_events c
          WHERE c.visitor_key_hash=e.visitor_key_hash
            AND c.policy_version=$1 AND c.consent_status='granted'
            AND c.id=(SELECT c2.id FROM admissions_marketing_consent_events c2
              WHERE c2.visitor_key_hash=e.visitor_key_hash ORDER BY c2.occurred_at DESC,c2.id DESC LIMIT 1)
        )`, [META_CONSENT_POLICY_VERSION]);
    const lockToken = randomUUID();
    const claimed = await client.query(`
      UPDATE admissions_meta_event_outbox SET state='sending',attempt_count=attempt_count+1,
        last_attempt_at=now(),locked_at=now(),lock_token=$1
      WHERE event_id=(SELECT e.event_id FROM admissions_meta_event_outbox e
        WHERE e.state IN ('pending','failed') AND e.available_at<=now() AND e.attempt_count<8
          AND EXISTS (SELECT 1 FROM admissions_marketing_consent_events c
            WHERE c.visitor_key_hash=e.visitor_key_hash AND c.policy_version=$2 AND c.consent_status='granted'
              AND c.id=(SELECT c2.id FROM admissions_marketing_consent_events c2
                WHERE c2.visitor_key_hash=e.visitor_key_hash ORDER BY c2.occurred_at DESC,c2.id DESC LIMIT 1))
        ORDER BY e.available_at,e.event_time FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING event_id,visitor_key_hash,event_name,event_time,event_source_url,custom_data,attempt_count,lock_token`,
      [lockToken, META_CONSENT_POLICY_VERSION]);
    event = claimed.rows[0];
    if (!event) {
      await client.query("COMMIT");
      return { state: "idle" as const };
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return { state: "failed" as const, reason: "claim_failed" };
  } finally {
    client.release();
  }

  if (!event) return { state: "idle" as const };
  try {
    const { rows: [latest] } = await pool.query(`SELECT consent_status,policy_version
      FROM admissions_marketing_consent_events WHERE visitor_key_hash=$1
      ORDER BY occurred_at DESC,id DESC LIMIT 1`, [event.visitor_key_hash]);
    if (latest?.consent_status !== "granted" || latest?.policy_version !== META_CONSENT_POLICY_VERSION) {
      await pool.query(`UPDATE admissions_meta_event_outbox SET state='suppressed',
        last_error='marketing_consent_not_active',locked_at=NULL,lock_token=NULL
        WHERE event_id=$1 AND lock_token=$2`, [event.event_id, event.lock_token]);
      return { state: "suppressed" as const };
    }
  } catch {
    await pool.query(`UPDATE admissions_meta_event_outbox SET state='failed',
      last_error='consent_check_failed',available_at=now(),locked_at=NULL,lock_token=NULL
      WHERE event_id=$1 AND lock_token=$2`, [event.event_id, event.lock_token]).catch(() => undefined);
    return { state: "failed" as const, reason: "consent_check_failed" };
  }
  let status: number | null = null;
  let result = "network_error";
  let sent = false;
  try {
    const version = process.env.META_GRAPH_API_VERSION!.trim();
    const pixelId = process.env.META_PIXEL_ID!.trim();
    const token = process.env.META_CAPI_ACCESS_TOKEN!.trim();
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}/events`);
    url.searchParams.set("access_token", token);
    const response = await fetch(url, {
      method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildMetaCapiPayload({
        eventName: event.event_name, eventTime: event.event_time, eventId: event.event_id,
        eventSourceUrl: event.event_source_url, customData: event.custom_data,
      })),
    });
    status = response.status;
    const body = await response.json().catch(() => null) as { events_received?: unknown } | null;
    sent = isAcknowledgedCapiResponse(response.status, body);
    result = sent ? "acknowledged" : response.ok ? "invalid_acknowledgement" : `http_${response.status}`;
  } catch {
    result = "network_error";
  }
  const now = new Date();
    const delayMs = capiRetryDelayMs(event.attempt_count);
  const state = sent ? "sent" : event.attempt_count >= 8 ? "failed" : "failed";
  await pool.query(`
    UPDATE admissions_meta_event_outbox SET state=$1,http_status=$2,response_at=$3,last_error=$4,
      available_at=$5,locked_at=NULL,lock_token=NULL
    WHERE event_id=$6 AND lock_token=$7`,
  [state, status, now, sent ? null : result, new Date(now.getTime() + delayMs), event.event_id, event.lock_token])
    .catch(() => undefined);
  return { state: sent ? "sent" as const : "failed" as const, httpStatus: status, result };
}

let workerStarted = false;
export function startMetaCapiWorker() {
  if (workerStarted || process.env.NODE_ENV !== "production" || !getMetaReadiness().capi.enabled) return false;
  workerStarted = true;
  const timer = setInterval(() => {
    void dispatchOneMetaEvent().catch(() => undefined);
  }, 20_000);
  timer.unref();
  return true;
}

export function registerMetaRoutes(app: Express) {
  startMetaCapiWorker();

  app.get("/api/marketing/consent", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const state = await consentStatus(visitorKey(req));
      return void res.json({
        status: state?.status ?? "unknown",
        policyVersion: state?.policyVersion ?? null,
        updatedAt: state?.occurredAt?.toISOString?.() ?? null,
      });
    } catch {
      return void res.json({ status: "unavailable", policyVersion: null, updatedAt: null });
    }
  });

  app.post("/api/marketing/consent", sameOriginCapture, async (req, res) => {
    const status = req.body?.status;
    if (!["granted", "denied", "withdrawn"].includes(status)) {
      return void res.status(400).json({ message: "Choose a valid marketing measurement preference." });
    }
    const visitorKeyHash = visitorKey(req);
    const sourcePath = safeMetaEventSourceUrl(req, "/")
      ? new URL(safeMetaEventSourceUrl(req, "/")!).pathname : "/";
    const source = "public_consent_control";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO admissions_marketing_consent_events
        (visitor_key_hash,consent_status,occurred_at,policy_version,source,source_path)
        VALUES($1,$2,now(),$3,$4,$5)`,
      [visitorKeyHash, status, META_CONSENT_POLICY_VERSION, source, sourcePath]);
      if (status !== "granted") {
        await client.query(`UPDATE admissions_meta_event_outbox SET state='suppressed',
          last_error='marketing_consent_withdrawn',locked_at=NULL,lock_token=NULL
          WHERE visitor_key_hash=$1 AND state IN ('pending','failed')`, [visitorKeyHash]);
      }
      await client.query("COMMIT");
      await new Promise<void>((resolve, reject) => {
        req.session.save((error) => error ? reject(error) : resolve());
      });
      return void res.json({ saved: true, status, policyVersion: META_CONSENT_POLICY_VERSION });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return void res.status(503).json({ message: "Marketing preference could not be saved." });
    } finally {
      client.release();
    }
  });

  app.get("/api/marketing/pixel-config", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!safeMetaEventSourceUrl(req, "/")) {
      return void res.json({ enabled: false });
    }
    try {
      const state = await consentStatus(visitorKey(req));
      const pixelId = process.env.META_PIXEL_ID?.trim();
      if (!isCurrentGrant(state) || !pixelId) return void res.json({ enabled: false });
      return void res.json({ enabled: true, pixelId });
    } catch {
      return void res.json({ enabled: false });
    }
  });

  app.post("/api/marketing/pageview", sameOriginCapture, async (req, res) => {
    const eventId = typeof req.body?.eventId === "string" ? req.body.eventId : "";
    const sourceUrl = safeMetaEventSourceUrl(req, "/");
    if (!UUID.test(eventId) || !sourceUrl) return void res.status(400).json({ message: "Invalid page event." });
    try {
      const id = await db.transaction((tx) => enqueueMetaEvent(tx, {
        eventId, visitorKeyHash: visitorKey(req), eventName: "PageView", eventSourceUrl: sourceUrl,
      }));
      if (!id) return void res.status(403).json({ message: "Marketing consent is not active." });
      return void res.json({ saved: true, eventId: id });
    } catch {
      return void res.status(503).json({ message: "Page event could not be saved." });
    }
  });

  app.get("/api/webhooks/meta/leadgen", (req, res) => {
    const config = getMetaReadiness();
    if (!config.leadAds.configured) return void res.sendStatus(503);
    const mode = req.query["hub.mode"];
    const supplied = typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"] : "";
    const challenge = typeof req.query["hub.challenge"] === "string" ? req.query["hub.challenge"] : "";
    if (!isValidMetaChallenge(mode, challenge, supplied, process.env.META_WEBHOOK_VERIFY_TOKEN)) {
      return void res.sendStatus(403);
    }
    return void res.status(200).type("text/plain").send(challenge);
  });

  app.post(META_LEADGEN_WEBHOOK_PATH, createMetaLeadgenHandler({
    isConfigured: () => getMetaReadiness().leadAds.configured,
    allowedFormIds: () => parseMetaAllowedFormIds(process.env.META_ALLOWED_FORM_IDS),
    verifySignature: (rawBody, signature) =>
      verifyMetaWebhookSignature(rawBody, signature, process.env.META_APP_SECRET),
    isSchemaReady: async () => {
      const { rows: [schema] } = await pool.query("SELECT to_regclass('admissions_meta_lead_links') IS NOT NULL AS ready");
      return !!schema?.ready;
    },
    expectedPageId: () => process.env.META_PAGE_ID?.trim(),
    fetchLead: fetchMetaLead,
    persistLead: saveMetaInstantLead,
  }));

  app.get("/api/admin/meta/status", requireLmsUser, requireLmsRole("admin"), async (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const readiness = getMetaReadiness();
    try {
      const schema = await pool.query(`SELECT
        to_regclass('admissions_marketing_consent_events') IS NOT NULL AS consent,
        to_regclass('admissions_lead_touchpoints') IS NOT NULL AS touchpoints,
        to_regclass('admissions_meta_lead_links') IS NOT NULL AS lead_links,
        to_regclass('admissions_meta_event_outbox') IS NOT NULL AS capi_outbox`);
      const counts = schema.rows[0].capi_outbox
        ? await pool.query("SELECT state,count(*)::int count FROM admissions_meta_event_outbox GROUP BY state")
        : { rows: [] };
      return void res.json({
        schemaReady: Object.values(schema.rows[0]).every(Boolean),
        missingConfiguration: {
          pixel: readiness.pixel.missing,
          capi: readiness.capi.missing,
          leadAds: readiness.leadAds.missing,
          ...(readiness.capi.configured && !readiness.capi.enabled ? { capiFlag: "META_CAPI_ENABLED=true in production" } : {}),
        },
        pixelConfigured: readiness.pixel.configured,
        capiEnabled: readiness.capi.enabled,
        leadAdsConfigured: readiness.leadAds.configured,
        outbox: Object.fromEntries(counts.rows.map((r: { state: string; count: number }) => [r.state, r.count])),
        webhookPath: "/api/webhooks/meta/leadgen",
      });
    } catch {
      return void res.json({
        schemaReady: false,
        missingConfiguration: {
          pixel: readiness.pixel.missing, capi: readiness.capi.missing, leadAds: readiness.leadAds.missing,
        },
        pixelConfigured: readiness.pixel.configured,
        capiEnabled: readiness.capi.enabled,
        leadAdsConfigured: readiness.leadAds.configured,
        outbox: null,
        webhookPath: "/api/webhooks/meta/leadgen",
      });
    }
  });
  registerMetaLeadAdsDiagnosticsRoute(app);
}
