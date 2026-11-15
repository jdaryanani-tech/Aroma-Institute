import { randomUUID } from "node:crypto";
import type { Express, RequestHandler } from "express";
import { z, ZodError } from "zod";
import { pool } from "../db";
import { requireLmsUser } from "../lms/auth";
import { sameOriginCapture } from "../admissions/routes";
import { saveMetaInstantLead } from "../admissions/identity";
import { CRM_STAGES } from "@shared/crm";
import { CrmError, updateCrmSchema } from "./evidence";
import { detailCrm, listCrm, readCrmConversationPage, readCrmMetaCaptureStatus } from "./read";
import { readCrmSourceAnalytics } from "./source-analytics";
import { updateCrm } from "./write";
import { VSL_DISPATCH_ENABLED_ENV, VSL_WEBHOOK_URL_ENV, isTrustedVslWebhookUrl, isVslDispatchEnabled } from "../admissions/outbox-dispatcher";
import { VSL_WEBHOOK_SECRET_ENV } from "../admissions/follow-up-routes";
import { crmAccessLevel, recordCrmDeniedAttempt, type CrmPrincipal } from "./authorization";
import { assignCrmLead, crmAssignmentUpdateSchema } from "./assignment";
import { createMetaBackfillService, safeMetaBackfillError, type MetaBackfillService } from "../meta/backfill";
import type { SqlDb } from "./model";
import type { MetaBackfillTotals } from "@shared/meta-backfill";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(new Date(v).getTime())&&new Date(v).toISOString().slice(0,10)===v);
const querySchema=z.object({
  q:z.string().trim().max(160).optional(),
  stage:z.enum(Object.keys(CRM_STAGES) as [keyof typeof CRM_STAGES,...(keyof typeof CRM_STAGES)[]]).optional(),
  program:z.string().max(200).optional(),source:z.string().max(100).optional(),
  dateFrom:date.optional(),dateTo:date.optional(),followUp:z.enum(["overdue","today","upcoming","none"]).optional(),
  assignee:z.string().regex(/^(unassigned|[1-9]\d*)$/).optional(),
  sort:z.enum(["recent","oldest","name","followup"]).default("recent"),
  page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine(q=>!q.dateFrom||!q.dateTo||q.dateFrom<=q.dateTo,"Start date must not follow end date.");
const idSchema=z.string().regex(/^(lead:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|inquiry:[1-9]\d*)$/i);
const canonicalLeadIdSchema=z.string().uuid();
const conversationQuerySchema=z.object({
  cursor:z.string().max(512).optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const metaBackfillFormsSchema=z.object({
  formIds:z.array(z.string().regex(/^[0-9]{1,40}$/)).min(1).max(50),
  startDate:z.string().max(10),
  endDate:z.string().max(10),
}).strict();
const metaBackfillContinuationSchema=z.object({
  continuationToken:z.string().min(1).max(128_000),
}).strict();
const metaBackfillImportSchema=metaBackfillContinuationSchema.extend({
  confirmed:z.literal(true),
  count:z.number().int().positive().max(10_000_000),
}).strict();
const safeCountKeys = ["fetched", "alreadyPresent", "eligibleNew", "validPhone", "phoneReview", "imported", "importReview", "failed"] as const;
function safeCounts(value: unknown): MetaBackfillTotals {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    fetched: safeNumber(source.fetched),
    alreadyPresent: safeNumber(source.alreadyPresent),
    eligibleNew: safeNumber(source.eligibleNew),
    validPhone: safeNumber(source.validPhone),
    phoneReview: safeNumber(source.phoneReview),
    imported: safeNumber(source.imported),
    importReview: safeNumber(source.importReview),
    failed: safeNumber(source.failed),
  };
}
function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function safeMetaBackfillPayload(result: unknown, correlationId: string): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { correlationId };
  const source = result as Record<string, unknown>;
  if (Array.isArray(source.forms) && !("phase" in source)) {
    return {
      correlationId,
      forms: source.forms.slice(0, 25_000).flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const form = value as Record<string, unknown>;
        if (typeof form.id !== "string" || !/^[0-9]{1,40}$/.test(form.id)) return [];
        return [{
          id: form.id,
          name: typeof form.name === "string" ? form.name.slice(0, 160) : "Untitled form",
          status: typeof form.status === "string" ? form.status.slice(0, 40) : "Unknown",
          createdAt: typeof form.createdAt === "string" ? form.createdAt.slice(0, 40) : null,
          leadsCount: typeof form.leadsCount === "number" && Number.isSafeInteger(form.leadsCount) && form.leadsCount >= 0
            ? form.leadsCount
            : null,
        }];
      }),
    };
  }
  const phase = source.phase === "preview" || source.phase === "import" ? source.phase : null;
  if (!phase) return { correlationId };
  const windowSource = source.window && typeof source.window === "object" ? source.window as Record<string, unknown> : {};
  const window = {
    timezone: "Asia/Kolkata",
    startDate: typeof windowSource.startDate === "string" ? windowSource.startDate.slice(0, 10) : "",
    endDate: typeof windowSource.endDate === "string" ? windowSource.endDate.slice(0, 10) : "",
    startUtc: typeof windowSource.startUtc === "string" ? windowSource.startUtc.slice(0, 40) : "",
    endUtcExclusive: typeof windowSource.endUtcExclusive === "string" ? windowSource.endUtcExclusive.slice(0, 40) : "",
    maximumDays: 365,
  };
  const forms = Array.isArray(source.forms) ? source.forms.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const form = value as Record<string, unknown>;
    if (typeof form.formId !== "string" || !/^[0-9]{1,40}$/.test(form.formId)) return [];
    return [{
      formId: form.formId,
      name: typeof form.name === "string" ? form.name.slice(0, 160) : "Untitled form",
      status: typeof form.status === "string" ? form.status.slice(0, 40) : "Unknown",
      ...safeCounts(form),
    }];
  }) : [];
  const totals = safeCounts(source.totals);
  return {
    correlationId,
    phase,
    state: source.state === "complete" ? "complete" : "running",
    continuationToken: typeof source.continuationToken === "string" && source.continuationToken.length <= 128_000
      ? source.continuationToken
      : "",
    expiresAt: typeof source.expiresAt === "string" ? source.expiresAt.slice(0, 40) : "",
    window,
    batchSize: 40,
    identityResolution: "determined_during_import",
    approvedImportCount: typeof source.approvedImportCount === "number" && Number.isSafeInteger(source.approvedImportCount) && source.approvedImportCount >= 0
      ? source.approvedImportCount
      : null,
    forms,
    totals,
  };
}

// Dependency injection is used by isolated tests, never selected by a public request or environment flag.
export function registerCrmRoutes(app: Express, dependencies: {
  db: SqlDb;
  connectionPool: SqlDb;
  authenticate: RequestHandler;
  metaBackfill?: MetaBackfillService;
} = { db: pool, connectionPool: pool, authenticate: requireLmsUser }) {
  app.use("/api/admin/crm", (_req,res,next)=>{
    res.setHeader("Cache-Control","private, no-store, max-age=0");
    res.vary("Cookie"); next();
  },dependencies.authenticate,async(req,res,next)=>{
    const user=req.lmsUser as CrmPrincipal|undefined;
    const access=crmAccessLevel(user);
    if(access!=="denied") return next();
    await recordCrmDeniedAttempt(dependencies.db,user,"crm_route");
    return res.status(user?403:401).json({message:"CRM access denied."});
  });
  const requireAdmin:RequestHandler=async(req,res,next)=>{
    if(req.lmsUser?.roles.includes("admin")) return next();
    await recordCrmDeniedAttempt(dependencies.db,req.lmsUser as CrmPrincipal|undefined,"crm_admin_route");
    return res.status(req.lmsUser?403:401).json({message:"Administrator access required."});
  };
  const handle=(fn:RequestHandler):RequestHandler=>async(req,res,next)=>{
    try { await fn(req,res,next); } catch(error) {
      if(error instanceof ZodError) return res.status(400).json({message:"Invalid CRM request. Check the supplied fields."});
      if(error instanceof CrmError) return res.status(error.status).json({message:error.message});
      console.error("[crm] database request failed"); // Never log request bodies, notes, contacts or SQL.
      return res.status(503).json({message:"CRM is temporarily unavailable. No unconfirmed changes should be assumed saved; refresh before retrying."});
    }
  };
  const metaBackfill = dependencies.metaBackfill ?? createMetaBackfillService({
    isSchemaReady: async () => {
      const { rows: [schema] } = await dependencies.db.query(`SELECT
        to_regclass('admissions_meta_lead_links') IS NOT NULL AS links,
        to_regclass('admissions_lead_touchpoints') IS NOT NULL AS touchpoints`);
      return Boolean(schema?.links && schema?.touchpoints);
    },
    findExistingMetaLeadIds: async (ids) => {
      if (!ids.length) return new Set<string>();
      const { rows } = await dependencies.db.query(
        "SELECT meta_lead_id FROM admissions_meta_lead_links WHERE meta_lead_id=ANY($1::text[])",
        [ids],
      );
      return new Set(rows.map((row: { meta_lead_id: string }) => row.meta_lead_id));
    },
    persistLead: (input) => saveMetaInstantLead(input),
  });
  const withMetaBackfill = async (
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
    phase: string,
    action: (correlationId: string) => Promise<unknown>,
  ) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.vary("Cookie");
    const correlationId = randomUUID();
    try {
      const result = await action(correlationId);
      return res.json(safeMetaBackfillPayload(result, correlationId));
    } catch (error) {
      const safe = safeMetaBackfillError(error);
      const code = "code" in safe.body ? safe.body.code : "backfill_unavailable";
      console.info("[meta-backfill]", JSON.stringify({ correlationId, phase, code }));
      const body = { ...safe.body } as Record<string, unknown>;
      if (body.progress) {
        const progress = safeMetaBackfillPayload(body.progress, correlationId);
        delete progress.correlationId;
        body.progress = progress;
      }
      return res.status(safe.status).json({ ...body, correlationId });
    }
  };
  app.get("/api/admin/crm/meta-backfill/forms", requireAdmin, async (req, res) => {
    await withMetaBackfill(req, res, "forms", (correlationId) => metaBackfill.listForms(correlationId));
  });
  app.post("/api/admin/crm/meta-backfill/preview/start", sameOriginCapture, requireAdmin, async (req, res) => {
    const input = metaBackfillFormsSchema.safeParse(req.body);
    if (!input.success) return void res.status(400).setHeader("Cache-Control", "private, no-store, max-age=0")
      .json({ code: "request_invalid", message: "Choose valid forms and a bounded date range." });
    await withMetaBackfill(req, res, "preview", (correlationId) =>
      metaBackfill.startPreview(req.lmsUser!.id, input.data, correlationId));
  });
  app.post("/api/admin/crm/meta-backfill/preview/continue", sameOriginCapture, requireAdmin, async (req, res) => {
    const input = metaBackfillContinuationSchema.safeParse(req.body);
    if (!input.success) return void res.status(400).setHeader("Cache-Control", "private, no-store, max-age=0")
      .json({ code: "request_invalid", message: "The preview continuation is invalid." });
    await withMetaBackfill(req, res, "preview", (correlationId) =>
      metaBackfill.continuePreview(req.lmsUser!.id, input.data.continuationToken, correlationId));
  });
  app.post("/api/admin/crm/meta-backfill/import/start", sameOriginCapture, requireAdmin, async (req, res) => {
    const input = metaBackfillImportSchema.safeParse(req.body);
    if (!input.success) return void res.status(400).setHeader("Cache-Control", "private, no-store, max-age=0")
      .json({ code: "request_invalid", message: "Confirm the exact previewed import count." });
    await withMetaBackfill(req, res, "import", (correlationId) =>
      metaBackfill.startImport(req.lmsUser!.id, input.data.continuationToken, {
        confirmed: input.data.confirmed,
        count: input.data.count,
      }, correlationId));
  });
  app.post("/api/admin/crm/meta-backfill/import/continue", sameOriginCapture, requireAdmin, async (req, res) => {
    const input = metaBackfillContinuationSchema.safeParse(req.body);
    if (!input.success) return void res.status(400).setHeader("Cache-Control", "private, no-store, max-age=0")
      .json({ code: "request_invalid", message: "The import continuation is invalid." });
    await withMetaBackfill(req, res, "import", (correlationId) =>
      metaBackfill.continueImport(req.lmsUser!.id, input.data.continuationToken, correlationId));
  });
  app.get("/api/admin/crm-meta-status/:id",(req,res,next)=>{
    res.setHeader("Cache-Control","private, no-store, max-age=0");
    res.vary("Cookie");
    next();
  },dependencies.authenticate,handle(async(req,res)=>{
    const principal=req.lmsUser as CrmPrincipal|undefined;
    const access=crmAccessLevel(principal);
    if(access==="denied") {
      return void res.status(principal?403:401).json({message:"CRM access denied."});
    }
    res.json(await readCrmMetaCaptureStatus(
      dependencies.db,
      idSchema.parse(req.params.id),
      principal!,
    ));
  }));
  app.get("/api/admin/crm/leads",handle(async(req,res)=>{
    res.json(await listCrm(dependencies.db,querySchema.parse(req.query),req.lmsUser as CrmPrincipal));
  }));
  app.get("/api/admin/crm/leads/:id",handle(async(req,res)=>{
    res.json(await detailCrm(dependencies.db,idSchema.parse(req.params.id),req.lmsUser as CrmPrincipal));
  }));
  app.get("/api/admin/crm/leads/:id/conversations",handle(async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store, max-age=0");
    const query=conversationQuerySchema.parse(req.query);
    res.json(await readCrmConversationPage(
      dependencies.db,idSchema.parse(req.params.id),query.cursor,query.limit,req.lmsUser as CrmPrincipal,
    ));
  }));
  app.get("/api/admin/crm/avni-health",requireAdmin,handle(async(_req,res)=>{
    const {rows:[schema]}=await dependencies.db.query(`SELECT
      to_regclass('admissions_leads') IS NOT NULL AS lead_identity,
      to_regclass('admissions_vsl_playbacks') IS NOT NULL AS playback_sessions,
      to_regclass('admissions_vsl_events') IS NOT NULL AS playback_events,
      to_regclass('admissions_lead_contact_preferences') IS NOT NULL AS consent_preferences,
      to_regclass('admissions_registration_outbox') IS NOT NULL AS event_outbox,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='inquiries' AND column_name='submission_idempotency_key') AS questionnaire_idempotency,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='admissions_leads' AND column_name='video_observed_percent') AS video_summary`);
    const outboxReady=Boolean(schema.event_outbox);
    const {rows:queue}=outboxReady
      ? await dependencies.db.query(`SELECT state,count(*)::int count FROM admissions_registration_outbox GROUP BY state`)
      : {rows:[]};
    const counts:Record<string,number>={pending:0,sending:0,acknowledged:0,failed:0};
    for(const row of queue) counts[row.state]=row.count;
    const url=process.env[VSL_WEBHOOK_URL_ENV] ?? "";
    const secretPresent=!!process.env[VSL_WEBHOOK_SECRET_ENV]?.trim();
    const schemaReady=Object.values(schema).every(Boolean);
    res.json({
      schema:{...schema,ready:schemaReady},
      webhook:{
        urlPresent:!!url,urlValid:!!url&&isTrustedVslWebhookUrl(url),
        secretPresent,dispatchRequested:process.env[VSL_DISPATCH_ENABLED_ENV]==="true",
        dispatcherActive:isVslDispatchEnabled(),
      },
      outbox:outboxReady?counts:null,
    });
  }));
  app.get("/api/admin/crm/source-analytics",requireAdmin,handle(async(_req,res)=>{
    res.json(await readCrmSourceAnalytics(dependencies.db));
  }));
  app.patch("/api/admin/crm/leads/:id",sameOriginCapture,handle(async(req,res)=>{
    res.json(await updateCrm(
      dependencies.connectionPool as typeof pool,
      idSchema.parse(req.params.id),
      updateCrmSchema.parse(req.body),
      req.lmsUser as CrmPrincipal,
    ));
  }));
  app.put("/api/admin/crm/leads/:leadId/assignment",sameOriginCapture,requireAdmin,handle(async(req,res)=>{
    const leadId=canonicalLeadIdSchema.parse(req.params.leadId);
    const input=crmAssignmentUpdateSchema.parse(req.body);
    res.json(await assignCrmLead(
      dependencies.connectionPool as typeof pool,
      leadId,
      input,
      req.lmsUser as CrmPrincipal,
    ));
  }));
}
