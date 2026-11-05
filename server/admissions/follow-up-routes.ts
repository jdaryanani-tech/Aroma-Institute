import type { Express, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { followUpSchemaReady, readLeadFollowUpStatus, type FollowUpDatabase } from "./follow-up";
import { db } from "../db";

export const VSL_WEBHOOK_SECRET_ENV = "N8N_VSL_REGISTRATION_WEBHOOK_SECRET";
export const VSL_WEBHOOK_HEADER = "x-aichm-webhook-secret";
const digest=(value:string)=>createHash("sha256").update(value).digest();

export function registerFollowUpStatusRoute(app:Express,options:{
  database?:FollowUpDatabase;getSecret?:()=>string|undefined;
}={}) {
  const database=options.database ?? db;
  // Bounded in-memory throttling: this read-only integration route does not write
  // rate-limit records or grant access through the public applicant session.
  const buckets=new Map<string,{start:number;count:number}>();
  const authenticate:RequestHandler=(req,res,next)=>{
    res.setHeader("Cache-Control","private, no-store");
    res.setHeader("Vary",VSL_WEBHOOK_HEADER);
    const expected=(options.getSecret?.() ?? process.env[VSL_WEBHOOK_SECRET_ENV])?.trim();
    if(!expected) return void res.status(503).json({message:"Lead-status integration is not configured."});
    const supplied=req.get(VSL_WEBHOOK_HEADER) ?? "";
    if(supplied.length>1024 || !timingSafeEqual(digest(supplied),digest(expected)))
      return void res.status(401).json({message:"Integration authentication required."});
    const key=req.ip ?? "unknown",now=Date.now();
    let bucket=buckets.get(key);
    if(!bucket || now-bucket.start>=60000) {
      if(buckets.size>=10000) buckets.clear();
      bucket={start:now,count:0};buckets.set(key,bucket);
    }
    if(++bucket.count>120) {
      res.setHeader("Retry-After","60");
      return void res.status(429).json({message:"Too many status requests."});
    }
    next();
  };
  app.get("/api/integrations/n8n/leads/:leadId/status",authenticate,async(req,res)=>{
    const parsed=z.string().uuid().safeParse(req.params.leadId);
    if(!parsed.success) return void res.status(400).json({message:"A stable lead UUID is required."});
    try {
      if(!await followUpSchemaReady(database))
        return void res.status(503).json({message:"Lead-status schema is not ready."});
      const status=await readLeadFollowUpStatus(parsed.data,database);
      if(!status) return void res.status(404).json({message:"Lead not found."});
      return void res.json(status);
    } catch {return void res.status(503).json({message:"Lead status is temporarily unavailable."});}
  });
}
