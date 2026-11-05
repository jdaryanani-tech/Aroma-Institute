import type { Express, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { counsellingAnswersSchema } from "@shared/schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { counsellingQuestions } from "../../client/src/pages/counsellingQuestions";
import { saveExternalCounsellingInquiry, saveExternalCounsellingInquiryByPhone } from "./identity";
import { admissionsIntegrationSchemaReady, followUpSchemaReady, readLeadFollowUpByPhone, readLeadFollowUpStatus, type FollowUpDatabase } from "./follow-up";
import { dispatchVslRegistrationOnce, isVslDispatchEnabled } from "./outbox-dispatcher";
import { validateCounsellingAnswer } from "./questionnaire-validation";
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
  const phoneLookupSchema=z.object({phone:z.string().trim().max(32).refine(v=>normalizeIndianMobile(v)!==null)}).strict();
  const answersBodySchema=z.object({answers:counsellingAnswersSchema.strict()}).strict();
  app.post("/api/integrations/n8n/leads/lookup",authenticate,async(req,res)=>{
    const parsed=phoneLookupSchema.safeParse(req.body);
    if(!parsed.success) return void res.status(400).json({message:"A valid Indian mobile number is required."});
    try {
      if(!await admissionsIntegrationSchemaReady(database))
        return void res.status(503).json({message:"Admissions integration schema is not ready."});
      const lead=await readLeadFollowUpByPhone(parsed.data.phone,database);
      if(!lead) return void res.status(404).json({message:"Lead not found."});
      return void res.json(lead);
    } catch {return void res.status(503).json({message:"Lead status is temporarily unavailable."});}
  });
  app.get("/api/integrations/n8n/counselling/questions",authenticate,(_req,res)=>{
    return void res.json({questionCount:counsellingQuestions.length,questions:counsellingQuestions});
  });
  app.post("/api/integrations/n8n/counselling/validate-answer",authenticate,async(req,res)=>{
    const body=z.object({questionKey:z.string().min(1).max(80),value:z.unknown()}).strict().safeParse(req.body);
    if(!body.success) return void res.status(400).json({valid:false,code:"invalid_request"});
    const result=validateCounsellingAnswer(body.data.questionKey,body.data.value);
    return void res.status(result.valid?200:400).json(result);
  });
  app.post("/api/integrations/n8n/outbox/dispatch",authenticate,async(_req,res)=>{
    try {
      if(!await admissionsIntegrationSchemaReady(database))
        return void res.status(503).json({message:"Admissions integration schema is not ready."});
      const result=await dispatchVslRegistrationOnce({enabled:isVslDispatchEnabled(),database});
      return void res.json(result);
    } catch {return void res.status(503).json({message:"Admissions event dispatch is temporarily unavailable."});}
  });
  app.post("/api/integrations/n8n/leads/:leadId/counselling",authenticate,async(req,res)=>{
    const leadId=z.string().uuid().safeParse(req.params.leadId);
    const idempotencyKey=req.get("Idempotency-Key") ?? "";
    const parsed=answersBodySchema.safeParse(req.body);
    if(!leadId.success || !/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey) || !parsed.success)
      return void res.status(400).json({message:"A valid lead, idempotency key, and complete questionnaire are required."});
    try {
      if(!await admissionsIntegrationSchemaReady(database))
        return void res.status(503).json({message:"Admissions integration schema is not ready."});
      const answers=parsed.data.answers;
      const payloadHash=createHash("sha256").update(JSON.stringify(answers)).digest("hex");
      const result=await saveExternalCounsellingInquiry({
        leadId:leadId.data,idempotencyKey,payloadHash,
        data:{
          name:answers.fullName,phone:answers.mobileWhatsapp,email:answers.email,
          programInterest:"Aroma LEAP",
          message:"AVNI-assisted counselling form submission.",
          counsellingAnswers:answers,
        },
      },new Date(),database);
      return void res.status(result.duplicate ? 200 : 201).json({
        saved:true,duplicate:result.duplicate,alreadySubmitted:result.alreadySubmitted,leadId:result.inquiry.leadId,
        submissionId:result.inquiry.id,submittedAt:result.inquiry.counsellingSubmittedAt?.toISOString() ?? null,
        questionnaireStatus:"completed",
      });
    } catch(error) {
      if(error instanceof Error && error.message==="idempotency_conflict")
        return void res.status(409).json({message:"Idempotency key was already used for different data."});
      if(error instanceof Error && error.message==="lead_not_found") return void res.status(404).json({message:"Lead not found."});
      if(error instanceof Error && error.message==="phone_mismatch") return void res.status(409).json({message:"Questionnaire phone does not match this lead."});
      return void res.status(503).json({message:"Questionnaire could not be saved. No duplicate was created."});
    }
  });
  app.post("/api/integrations/n8n/counselling/submit",authenticate,async(req,res)=>{
    const idempotencyKey=req.get("Idempotency-Key") ?? "";
    const parsed=z.object({phone:z.string().trim().max(32).refine(value=>normalizeIndianMobile(value)!==null),answers:counsellingAnswersSchema.strict()})
      .strict().safeParse(req.body);
    if(!/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)||!parsed.success)
      return void res.status(400).json({message:"A valid idempotency key, Indian mobile, and complete questionnaire are required."});
    try {
      if(!await admissionsIntegrationSchemaReady(database))
        return void res.status(503).json({message:"Admissions integration schema is not ready."});
      const answers=parsed.data.answers;
      if(normalizeIndianMobile(parsed.data.phone)!==normalizeIndianMobile(answers.mobileWhatsapp))
        return void res.status(409).json({message:"The WhatsApp phone does not match the questionnaire answer."});
      const payloadHash=createHash("sha256").update(JSON.stringify(answers)).digest("hex");
      const result=await saveExternalCounsellingInquiryByPhone({
        phone:parsed.data.phone,idempotencyKey,payloadHash,
        data:{
          name:answers.fullName,phone:answers.mobileWhatsapp,email:answers.email,
          programInterest:"Aroma LEAP",
          message:"AVNI-assisted counselling form submission.",
          counsellingAnswers:answers,
        },
      },new Date(),database);
      return void res.status(result.duplicate?200:201).json({
        saved:true,duplicate:result.duplicate,alreadySubmitted:result.alreadySubmitted,
        leadId:result.inquiry.leadId,submissionId:result.inquiry.id,
        submittedAt:result.inquiry.counsellingSubmittedAt?.toISOString()??null,
        questionnaireStatus:"completed",
      });
    } catch(error) {
      if(error instanceof Error&&error.message==="idempotency_conflict")
        return void res.status(409).json({message:"Idempotency key was already used for different data."});
      if(error instanceof Error&&error.message==="phone_mismatch")
        return void res.status(409).json({message:"The WhatsApp phone does not match the questionnaire answer."});
      return void res.status(503).json({message:"Questionnaire could not be saved. No duplicate was created."});
    }
  });
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
