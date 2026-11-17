import type { Express, RequestHandler } from "express";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { admissionsCaptureLimits } from "@shared/admissions-schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { db, pool } from "../db";
import { upsertIntegrationLead } from "../admissions/identity";
import {
  admissionsIntegrationSchemaReady,
  readLeadFollowUpByPhone,
  readLeadFollowUpStatus,
  recordWhatsAppOptOut,
} from "../admissions/follow-up";
import { crmModelSql, inspectCrmSchema, iso } from "../crm/model";
import { requireLmsRole, requireLmsUser } from "../lms/auth";
import { isSupabaseAvniReadConfigured } from "../db/supabase-avni-readonly";
import { createAvniDiagnosticsHandler } from "./avni-diagnostics";
import { registerAvniCrmFollowUpRoutes } from "../crm/avni-follow-up-routes";
import {
  N8N_INTEGRATION_SECRET_ENV, N8N_INTEGRATION_SECRET_HEADER, verifyN8nIntegrationSecret,
} from "./n8n-auth";

export const N8N_VSL_SECRET_ENV = N8N_INTEGRATION_SECRET_ENV;
export const N8N_VSL_SECRET_HEADER = N8N_INTEGRATION_SECRET_HEADER;
const canonicalPhone = z.string().trim().max(32).refine(
  (value) => normalizeIndianMobile(value) !== null,
  "A valid Indian mobile number is required.",
);

export function verifyAvniIntegrationSecret(supplied: string, expected: string | undefined) {
  return verifyN8nIntegrationSecret(supplied, expected);
}

export const avniIntegrationAuth: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Vary", N8N_VSL_SECRET_HEADER);
  const expected = process.env[N8N_VSL_SECRET_ENV];
  if (!expected?.trim()) return void res.status(503).json({ message: "AVNI integration is not configured." });
  if (!verifyAvniIntegrationSecret(req.get(N8N_VSL_SECRET_HEADER) ?? "", expected)) {
    return void res.status(401).json({ message: "Integration authentication required." });
  }
  try {
    const key = createHash("sha256").update(`avni:${req.ip ?? "unknown"}`).digest("hex");
    const now = new Date();
    const cutoff = new Date(now.getTime() - 60_000);
    const [bucket] = await db.insert(admissionsCaptureLimits).values({
      keyHash: key, windowStartedAt: now, attempts: 1,
    }).onConflictDoUpdate({
      target: admissionsCaptureLimits.keyHash,
      set: {
        windowStartedAt: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN ${now} ELSE ${admissionsCaptureLimits.windowStartedAt} END`,
        attempts: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN 1 ELSE LEAST(${admissionsCaptureLimits.attempts}+1,121) END`,
      },
    }).returning({ attempts: admissionsCaptureLimits.attempts });
    if (bucket.attempts > 120) {
      res.setHeader("Retry-After", "60");
      return void res.status(429).json({ message: "Too many integration requests." });
    }
    return next();
  } catch {
    return void res.status(503).json({ message: "AVNI integration is temporarily unavailable." });
  }
};

export function registerAvniIntegrationRoutes(app: Express) {

  const schemaReady = () => admissionsIntegrationSchemaReady(db);
  registerAvniCrmFollowUpRoutes(app, avniIntegrationAuth, pool);
  const readCrmFollowUpState = async (leadId: string) => {
    const capabilities = await inspectCrmSchema(pool);
    const { rows: [row] } = await pool.query(
      `${crmModelSql(capabilities)}
       SELECT model.stage,model.version,model.follow_up_at
       FROM model WHERE model.lead_id=$1::uuid LIMIT 1`,
      [leadId],
    );
    if (!row) return null;
    const followUpAt = iso(row.follow_up_at);
    return {
      stage: row.stage,
      expectedVersion: Number(row.version),
      followUpAt,
      followUpDue: followUpAt !== null && Date.parse(followUpAt) <= Date.now(),
    };
  };

  app.get("/api/admin/integrations/avni/status", requireLmsUser, requireLmsRole("admin"), async (_req, res) => {
    const names = [
      "N8N_VSL_REGISTRATION_WEBHOOK_SECRET",
      "N8N_VSL_REGISTRATION_WEBHOOK_URL",
      "N8N_VSL_DISPATCH_ENABLED",
      "AICHM_VAPID_PUBLIC_KEY",
      "AICHM_VAPID_PRIVATE_KEY",
      "SUPABASE_AVNI_READONLY_DATABASE_URL",
      "SUPABASE_DB_SSL_CA",
    ];
    const configured = Object.fromEntries(names.map((name) => [name, Boolean(process.env[name]?.trim())]));
    let schemaReady = false, calendarReady = false;
    try {
      schemaReady = await admissionsIntegrationSchemaReady(db);
      calendarReady = (await pool.query(`SELECT
        to_regclass('calendar_events') IS NOT NULL AND
        to_regclass('calendar_event_attendees') IS NOT NULL AND
        to_regclass('calendar_reminder_jobs') IS NOT NULL AND
        to_regclass('calendar_integration_requests') IS NOT NULL AS ready`)).rows[0]?.ready === true;
    } catch { /* report unavailable, never expose driver details */ }
    return void res.json({
      sourceOfTruth: "replit_postgresql",
      configured,
      missing: names.filter((name) => !configured[name]),
      avniSchemaReady: schemaReady,
      calendarSchemaReady: calendarReady,
      reminderRunnerCommandAvailable: true,
      schedulerHookupRequired: true,
      transcriptStore: "supabase",
      supabaseConversationReaderConfigured: isSupabaseAvniReadConfigured(),
      supabaseRuntimeBusinessData: false,
    });
  });

  app.get(
    "/api/integrations/n8n/diagnostics",
    createAvniDiagnosticsHandler({
      checkOperationalApiReady: () => admissionsIntegrationSchemaReady(db),
    }),
  );

  app.get("/api/integrations/n8n/health", avniIntegrationAuth, async (_req, res) => {
    try {
      const ready = await schemaReady();
      return void res.status(ready ? 200 : 503).json({
        ready, sourceOfTruth: "replit_postgresql", transcriptStore: "supabase",
        conversationReaderConfigured: isSupabaseAvniReadConfigured(),
      });
    } catch {
      return void res.status(503).json({ ready: false, sourceOfTruth: "replit_postgresql" });
    }
  });

  app.post("/api/integrations/n8n/leads/upsert", avniIntegrationAuth, async (req, res) => {
    const parsed = z.object({
      phone: canonicalPhone,
      name: z.string().trim().min(2).max(120),
      source: z.string().trim().min(1).max(80).default("avni_whatsapp"),
      programInterest: z.string().trim().min(1).max(200).default("Professional Barista Executive Program"),
    }).strict().safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ message: "A valid phone and name are required." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const result = await upsertIntegrationLead(parsed.data);
      const journey = await readLeadFollowUpByPhone(result.canonicalPhone);
      const crm = await readCrmFollowUpState(result.lead.id);
      if (!crm) return void res.status(503).json({ message: "CRM follow-up state is unavailable." });
      return void res.status(result.inquiryCreated ? 201 : 200).json({
        leadId: result.lead.id,
        inquiryId: result.inquiryId,
        inquiryCreated: result.inquiryCreated,
        crm,
        registeredAt: journey?.registeredAt ?? null,
        video: journey?.video ?? null,
        questionnaire: journey?.questionnaire ? {
          status: journey.questionnaire.status,
          completedAt: journey.questionnaire.completedAt,
        } : null,
      });
    } catch {
      return void res.status(503).json({ message: "Lead could not be saved." });
    }
  });

  app.get("/api/integrations/n8n/leads/:leadId/context", avniIntegrationAuth, async (req, res) => {
    const leadId = z.string().uuid().safeParse(req.params.leadId);
    if (!leadId.success) return void res.status(400).json({ message: "A stable lead UUID is required." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const status = await readLeadFollowUpStatus(leadId.data);
      if (!status) return void res.status(404).json({ message: "Lead not found." });
      const crm = await readCrmFollowUpState(leadId.data);
      if (!crm) return void res.status(404).json({ message: "Lead not found." });
      return void res.json({
        leadId: status.leadId,
        crm,
        registeredAt: status.registeredAt,
        video: status.video,
        questionnaire: status.questionnaire,
        consent: status.consent,
        enrollment: { status: "unavailable", verified: false },
        payment: { status: "unavailable", verified: false, source: null },
      });
    } catch {
      return void res.status(503).json({ message: "Lead operational context is temporarily unavailable." });
    }
  });

  app.post("/api/integrations/n8n/leads/whatsapp-opt-out", avniIntegrationAuth, async (req, res) => {
    const parsed = z.object({ phone: canonicalPhone }).strict().safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: "invalid_phone" });
    try {
      if (!await schemaReady()) return void res.status(503).json({ code: "opt_out_unavailable" });
      const canonicalPhone = normalizeIndianMobile(parsed.data.phone);
      if (!canonicalPhone) return void res.status(400).json({ code: "invalid_phone" });
      const { rows } = await pool.query(
        "SELECT id FROM admissions_leads WHERE canonical_phone=$1 LIMIT 2",
        [canonicalPhone],
      );
      if (rows.length === 0) return void res.status(404).json({ code: "canonical_lead_not_found" });
      if (rows.length !== 1) return void res.status(409).json({ code: "ambiguous_canonical_lead" });
      if (!await recordWhatsAppOptOut(rows[0].id, "n8n")) {
        return void res.status(404).json({ code: "canonical_lead_not_found" });
      }
      return void res.json({ status: "opted_out" });
    } catch {
      return void res.status(503).json({ code: "opt_out_unavailable" });
    }
  });

  app.post("/api/integrations/n8n/conversations/messages", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Replit no longer accepts conversation transcripts. Supabase is the conversation source of truth.",
    });
  });

  app.patch("/api/integrations/n8n/conversations/messages/:messageId/delivery", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Delivery state is owned by Supabase; Replit does not store transcript delivery records.",
    });
  });

  app.get("/api/integrations/n8n/leads/:leadId/conversations", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Conversation history is read from Supabase by the authorized CRM view; n8n owns message storage.",
    });
  });

  app.post("/api/integrations/n8n/conversations/read", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Conversation history is stored in Supabase and is not returned by Replit's operational API.",
    });
  });
}
