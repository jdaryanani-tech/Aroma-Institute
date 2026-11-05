import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { admissionsLeads, inquiries, type InsertCounsellingInquiry } from "@shared/schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { recordRegistrationFollowUp } from "./follow-up";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AdmissionsDatabase = Pick<typeof db, "transaction" | "select" | "insert" | "update" | "execute">;

async function latestCounsellingInquiryForPhone(tx:Transaction,canonicalPhone:string) {
  const normalized=sql<string>`regexp_replace(${inquiries.phone}, '[^0-9]', '', 'g')`;
  const [inquiry]=await tx.select().from(inquiries).where(and(
    isNotNull(inquiries.counsellingAnswers),
    sql`btrim(${inquiries.phone}) ~ '^\\+?[0-9[:space:]().-]+$'`,
    sql`${normalized} IN (${canonicalPhone}, ${canonicalPhone.slice(2)}, ${`0${canonicalPhone.slice(2)}`})`,
  )).orderBy(sql`${inquiries.counsellingSubmittedAt} DESC NULLS LAST`,desc(inquiries.id)).limit(1);
  return inquiry;
}

/** Never rewrites historical answers or merges ambiguous historical rows. */
async function resolveLead(tx: Transaction, phone: string, name: string) {
  const canonicalPhone = normalizeIndianMobile(phone);
  if (!canonicalPhone) throw new Error("invalid_indian_mobile");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`admissions:${canonicalPhone}`}))`);
  let [lead] = await tx.select().from(admissionsLeads).where(eq(admissionsLeads.canonicalPhone, canonicalPhone));
  if (!lead) {
    [lead] = await tx.insert(admissionsLeads).values({ canonicalPhone, name }).returning();
  }
  // Compare only normalized, valid Indian mobiles. Select minimal legacy metadata.
  const normalized = sql<string>`regexp_replace(${inquiries.phone}, '[^0-9]', '', 'g')`;
  const candidates = await tx.select({
    id: inquiries.id, submittedAt: inquiries.counsellingSubmittedAt,
    hasAnswers: sql<boolean>`${inquiries.counsellingAnswers} IS NOT NULL`,
  }).from(inquiries).where(and(
    isNull(inquiries.leadId),
    sql`btrim(${inquiries.phone}) ~ '^\\+?[0-9[:space:]().-]+$'`,
    sql`${normalized} IN (${canonicalPhone}, ${canonicalPhone.slice(2)})`,
  )).limit(2);
  if (candidates.length === 1) {
    await tx.update(inquiries).set({ leadId: lead.id }).where(and(
      eq(inquiries.id, candidates[0].id), isNull(inquiries.leadId),
    ));
    const legacy = candidates[0];
    [lead] = await tx.update(admissionsLeads).set({
      legacyMatchStatus: "linked_unique",
      ...(legacy.hasAnswers && lead.questionnaireStatus !== "completed" ? {
        questionnaireStatus: "completed", questionnaireCompletedAt: legacy.submittedAt,
      } : {}),
    }).where(eq(admissionsLeads.id, lead.id)).returning();
  } else if (candidates.length > 1) {
    [lead] = await tx.update(admissionsLeads).set({ legacyMatchStatus: "ambiguous" })
      .where(eq(admissionsLeads.id, lead.id)).returning();
  }
  return lead;
}

export async function registerVslLead(input: { phone: string; name: string; entryPath: string; entryHost: string; whatsappAdmissionsConsent?:boolean }, now = new Date(), database: AdmissionsDatabase = db) {
  return database.transaction(async (tx) => {
    const lead = await resolveLead(tx, input.phone, input.name);
    const [updated] = await tx.update(admissionsLeads).set({
      registeredAt: lead.registeredAt ?? now,
      lastRegisteredAt: now,
      entrySource: lead.entrySource ?? "vsl_registration",
      entryPath: lead.entryPath ?? input.entryPath,
      entryHost: lead.entryHost ?? input.entryHost,
    }).where(eq(admissionsLeads.id, lead.id)).returning();
    const [existing] = await tx.select({ id: inquiries.id }).from(inquiries)
      .where(eq(inquiries.leadId, lead.id)).limit(1);
    // Keep registration-only leads visible in the existing inquiry dashboard.
    if (!existing) await tx.insert(inquiries).values({
      leadId: lead.id, name: input.name, phone: lead.canonicalPhone,
      email: "watch@aromainstitute.in", programInterest: "Aroma LEAP",
      message: "Requested free Aroma LEAP training from the VSL landing page",
    });
    await recordRegistrationFollowUp(tx,updated,!lead.registeredAt,input.whatsappAdmissionsConsent===true,now);
    return updated;
  });
}

export async function saveLinkedCounsellingInquiry(data: InsertCounsellingInquiry, now: Date, database: AdmissionsDatabase = db) {
  return database.transaction(async (tx) => {
    const lead = await resolveLead(tx, data.phone, data.name);
    const [inquiry] = await tx.insert(inquiries).values({
      ...data, leadId: lead.id, counsellingSubmittedAt: now,
      counsellingDeliveryStatus: "pending", counsellingDeliveryAttempts: 0,
    }).returning();
    await tx.update(admissionsLeads).set({
      questionnaireStatus: "completed", questionnaireCompletedAt: now,
    }).where(eq(admissionsLeads.id, lead.id));
    return inquiry;
  });
}

export async function saveExternalCounsellingInquiry(input: {
  leadId: string;
  idempotencyKey: string;
  payloadHash: string;
  data: InsertCounsellingInquiry;
}, now = new Date(), database: AdmissionsDatabase = db) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`avni-counselling:${input.idempotencyKey}`}))`);
    const [existing] = await tx.select().from(inquiries)
      .where(eq(inquiries.submissionIdempotencyKey, input.idempotencyKey)).limit(1);
    if (existing) {
      if (existing.leadId !== input.leadId || existing.submissionPayloadHash !== input.payloadHash) {
        throw new Error("idempotency_conflict");
      }
      return { inquiry: existing, duplicate: true,alreadySubmitted:true };
    }

    const [lead] = await tx.select().from(admissionsLeads).where(eq(admissionsLeads.id, input.leadId)).limit(1);
    if (!lead) throw new Error("lead_not_found");
    if (normalizeIndianMobile(input.data.phone) !== lead.canonicalPhone) throw new Error("phone_mismatch");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`admissions:${lead.canonicalPhone}`}))`);
    const existingSubmission=await latestCounsellingInquiryForPhone(tx,lead.canonicalPhone);
    if(existingSubmission) return {inquiry:existingSubmission,duplicate:true,alreadySubmitted:true};

    const [inquiry] = await tx.insert(inquiries).values({
      ...input.data,
      leadId: lead.id,
      counsellingSubmittedAt: now,
      counsellingDeliveryStatus: "not_applicable",
      counsellingDeliveryAttempts: 0,
      submissionSource: "avni_whatsapp",
      submissionIdempotencyKey: input.idempotencyKey,
      submissionPayloadHash: input.payloadHash,
    }).returning();
    await tx.update(admissionsLeads).set({
      questionnaireStatus: "completed",
      questionnaireCompletedAt: now,
    }).where(eq(admissionsLeads.id, lead.id));
    return { inquiry, duplicate: false,alreadySubmitted:false };
  });
}

export async function saveExternalCounsellingInquiryByPhone(input:{
  phone:string;
  idempotencyKey:string;
  payloadHash:string;
  data:InsertCounsellingInquiry;
},now=new Date(),database:AdmissionsDatabase=db) {
  return database.transaction(async tx=>{
    const canonicalPhone=normalizeIndianMobile(input.phone);
    if(!canonicalPhone||normalizeIndianMobile(input.data.phone)!==canonicalPhone) throw new Error("phone_mismatch");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`avni-counselling:${input.idempotencyKey}`}))`);
    const [existing]=await tx.select().from(inquiries)
      .where(eq(inquiries.submissionIdempotencyKey,input.idempotencyKey)).limit(1);
    if(existing) {
      if(existing.submissionPayloadHash!==input.payloadHash) throw new Error("idempotency_conflict");
      return {inquiry:existing,duplicate:true,alreadySubmitted:true};
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`admissions:${canonicalPhone}`}))`);
    const existingSubmission=await latestCounsellingInquiryForPhone(tx,canonicalPhone);
    if(existingSubmission) return {inquiry:existingSubmission,duplicate:true,alreadySubmitted:true};
    const lead=await resolveLead(tx,canonicalPhone,input.data.name);
    const [inquiry]=await tx.insert(inquiries).values({
      ...input.data,
      leadId:lead.id,
      counsellingSubmittedAt:now,
      counsellingDeliveryStatus:"not_applicable",
      counsellingDeliveryAttempts:0,
      submissionSource:"avni_whatsapp",
      submissionIdempotencyKey:input.idempotencyKey,
      submissionPayloadHash:input.payloadHash,
    }).returning();
    await tx.update(admissionsLeads).set({
      questionnaireStatus:"completed",questionnaireCompletedAt:now,
    }).where(eq(admissionsLeads.id,lead.id));
    return {inquiry,duplicate:false,alreadySubmitted:false};
  });
}
