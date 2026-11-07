import type { Express, RequestHandler } from "express";
import { z, ZodError } from "zod";
import { pool } from "../db";
import { requireLmsRole, requireLmsUser } from "../lms/auth";
import { sameOriginCapture } from "../admissions/routes";
import { CRM_STAGES } from "@shared/crm";
import { CrmError, updateCrmSchema } from "./evidence";
import { detailCrm, listCrm, readCrmConversationPage } from "./read";
import { updateCrm } from "./write";
import { VSL_DISPATCH_ENABLED_ENV, VSL_WEBHOOK_URL_ENV, isTrustedVslWebhookUrl, isVslDispatchEnabled } from "../admissions/outbox-dispatcher";
import { VSL_WEBHOOK_SECRET_ENV } from "../admissions/follow-up-routes";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(new Date(v).getTime())&&new Date(v).toISOString().slice(0,10)===v);
const querySchema=z.object({
  q:z.string().trim().max(160).optional(),
  stage:z.enum(Object.keys(CRM_STAGES) as [keyof typeof CRM_STAGES,...(keyof typeof CRM_STAGES)[]]).optional(),
  program:z.string().max(200).optional(),source:z.string().max(100).optional(),
  dateFrom:date.optional(),dateTo:date.optional(),followUp:z.enum(["overdue","today","upcoming","none"]).optional(),
  owner:z.string().regex(/^(unassigned|[1-9]\d*)$/).optional(),
  sort:z.enum(["recent","oldest","name","followup"]).default("recent"),
  page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine(q=>!q.dateFrom||!q.dateTo||q.dateFrom<=q.dateTo,"Start date must not follow end date.");
const idSchema=z.string().regex(/^(lead:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|inquiry:[1-9]\d*)$/i);
const conversationQuerySchema=z.object({
  cursor:z.string().max(512).optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50),
}).strict();

// Dependency injection is used by isolated tests, never selected by a public request or environment flag.
export function registerCrmRoutes(app: Express, dependencies = { db: pool, connectionPool: pool, authenticate: requireLmsUser }) {
  app.use("/api/admin/crm", (_req,res,next)=>{
    res.setHeader("Cache-Control","private, no-store, max-age=0");
    res.vary("Cookie"); next();
  },dependencies.authenticate,requireLmsRole("admin"));
  const handle=(fn:RequestHandler):RequestHandler=>async(req,res,next)=>{
    try { await fn(req,res,next); } catch(error) {
      if(error instanceof ZodError) return res.status(400).json({message:"Invalid CRM request. Check the supplied fields."});
      if(error instanceof CrmError) return res.status(error.status).json({message:error.message});
      console.error("[crm] database request failed"); // Never log request bodies, notes, contacts or SQL.
      return res.status(503).json({message:"CRM is temporarily unavailable. No unconfirmed changes should be assumed saved; refresh before retrying."});
    }
  };
  app.get("/api/admin/crm/leads",handle(async(req,res)=>{
    res.json(await listCrm(dependencies.db,querySchema.parse(req.query)));
  }));
  app.get("/api/admin/crm/leads/:id",handle(async(req,res)=>{
    res.json(await detailCrm(dependencies.db,idSchema.parse(req.params.id)));
  }));
  app.get("/api/admin/crm/leads/:id/conversations",handle(async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store, max-age=0");
    const query=conversationQuerySchema.parse(req.query);
    res.json(await readCrmConversationPage(
      dependencies.db,idSchema.parse(req.params.id),query.cursor,query.limit,
    ));
  }));
  app.get("/api/admin/crm/avni-health",handle(async(_req,res)=>{
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
  app.patch("/api/admin/crm/leads/:id",sameOriginCapture,handle(async(req,res)=>{
    res.json(await updateCrm(dependencies.connectionPool,idSchema.parse(req.params.id),updateCrmSchema.parse(req.body),req.lmsUser!.id));
  }));
}
