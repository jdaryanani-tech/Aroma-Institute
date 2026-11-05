import type { Express, RequestHandler } from "express";
import { z, ZodError } from "zod";
import { pool } from "../db";
import { requireLmsRole, requireLmsUser } from "../lms/auth";
import { sameOriginCapture } from "../admissions/routes";
import { CRM_STAGES } from "@shared/crm";
import { CrmError, updateCrmSchema } from "./evidence";
import { detailCrm, listCrm } from "./read";
import { updateCrm } from "./write";

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
  app.patch("/api/admin/crm/leads/:id",sameOriginCapture,handle(async(req,res)=>{
    res.json(await updateCrm(dependencies.connectionPool,idSchema.parse(req.params.id),updateCrmSchema.parse(req.body),req.lmsUser!.id));
  }));
}
