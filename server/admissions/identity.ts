import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { admissionsLeadTouchpoints, admissionsMetaLeadLinks } from "@shared/admissions-schema";
import { admissionsLeads, inquiries, type InsertCounsellingInquiry, type NewInquiry } from "@shared/schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { recordRegistrationFollowUp } from "./follow-up";
import { enqueueMetaEvent, hasMarketingConsent, linkVisitorConsentToLead, metaSchemaReady, recordLeadTouchpoint, type MetaAttribution } from "../meta/events";
import { metaLeadIdempotencyKey, normalizeMetaFieldDataWithDiagnostics } from "../meta/config";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AdmissionsDatabase = Pick<typeof db, "transaction" | "select" | "insert" | "update" | "execute">;
export type MarketingCaptureContext = {
  visitorKeyHash?: string;
  eventSourceUrl?: string | null;
  attribution?: MetaAttribution;
};

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
export async function resolveLead(tx: Transaction, phone: string, name: string) {
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

/**
 * Creates or reuses the canonical phone-keyed lead and exactly one existing CRM
 * inquiry anchor. It never marks VSL registration or questionnaire completion.
 */
export async function upsertIntegrationLead(input: {
  phone: string;
  name: string;
  source?: string;
  programInterest?: string;
}, now = new Date(), database: AdmissionsDatabase = db) {
  const canonicalPhone = normalizeIndianMobile(input.phone);
  if (!canonicalPhone) throw new Error("invalid_indian_mobile");
  return database.transaction(async (tx) => {
    let lead = await resolveLead(tx, canonicalPhone, input.name);
    if (!lead.entrySource && input.source) {
      [lead] = await tx.update(admissionsLeads).set({
        entrySource: input.source.slice(0, 80),
      }).where(eq(admissionsLeads.id, lead.id)).returning();
    }
    const [existingInquiry] = await tx.select({ id: inquiries.id }).from(inquiries)
      .where(eq(inquiries.leadId, lead.id)).orderBy(desc(inquiries.id)).limit(1);
    let inquiryId = existingInquiry?.id ?? null;
    if (!existingInquiry) {
      const [inquiry] = await tx.insert(inquiries).values({
        leadId: lead.id,
        name: lead.name,
        email: "",
        phone: lead.canonicalPhone,
        programInterest: input.programInterest?.slice(0, 200) || "Professional Barista Executive Program",
        message: "Initial enquiry received through the WhatsApp admissions assistant.",
        submissionSource: "avni_whatsapp",
      }).returning({ id: inquiries.id });
      inquiryId = inquiry.id;
    }
    return { lead, inquiryId, inquiryCreated: !existingInquiry, canonicalPhone };
  });
}

export async function registerVslLead(
  input: { phone: string; name: string; entryPath: string; entryHost: string; whatsappAdmissionsConsent?:boolean },
  now = new Date(),
  database: AdmissionsDatabase = db,
  marketing: MarketingCaptureContext = {},
) {
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
    let metaEventId: string | null = null;
    if (await metaSchemaReady(tx)) {
      if (marketing.visitorKeyHash) await linkVisitorConsentToLead(tx, marketing.visitorKeyHash, lead.id);
      const consented = marketing.visitorKeyHash ? await hasMarketingConsent(tx, marketing.visitorKeyHash) : false;
      const source = input.entryPath === "/" && !input.entryHost.startsWith("training.")
        ? "website_home_vsl" : "website_vsl";
      await recordLeadTouchpoint(tx, {
        leadId: lead.id, sourceChannel: source,
        attribution: consented ? marketing.attribution : undefined, occurredAt: now,
      });
      if (marketing.visitorKeyHash && marketing.eventSourceUrl) {
        metaEventId = await enqueueMetaEvent(tx, {
          visitorKeyHash: marketing.visitorKeyHash, leadId: lead.id,
          eventName: "VslRegistered", eventSourceUrl: marketing.eventSourceUrl,
          customData: { funnel_step: "vsl_registration" }, occurredAt: now,
        });
      }
    }
    return { ...updated, metaEventId };
  });
}

export async function saveWebsiteInquiry(
  data: NewInquiry,
  now: Date,
  database: AdmissionsDatabase = db,
  marketing: MarketingCaptureContext = {},
) {
  return database.transaction(async (tx) => {
    const canonicalPhone = normalizeIndianMobile(data.phone);
    const lead = canonicalPhone ? await resolveLead(tx, data.phone, data.name) : null;
    const [inquiry] = await tx.insert(inquiries).values({ ...data, leadId: lead?.id ?? null }).returning();
    let metaEventId: string | null = null;
    if (await metaSchemaReady(tx)) {
      if (lead && marketing.visitorKeyHash) await linkVisitorConsentToLead(tx, marketing.visitorKeyHash, lead.id);
      const consented = marketing.visitorKeyHash ? await hasMarketingConsent(tx, marketing.visitorKeyHash) : false;
      await recordLeadTouchpoint(tx, {
        leadId: lead?.id ?? null, inquiryId: inquiry.id, sourceChannel: "website_enquiry",
        attribution: consented ? marketing.attribution : undefined, occurredAt: now,
      });
      if (marketing.visitorKeyHash && marketing.eventSourceUrl) {
        metaEventId = await enqueueMetaEvent(tx, {
          visitorKeyHash: marketing.visitorKeyHash, leadId: lead?.id ?? null, inquiryId: inquiry.id,
          eventName: "Lead", eventSourceUrl: marketing.eventSourceUrl,
          customData: { funnel_step: "enquiry_submitted" }, occurredAt: now,
        });
      }
    }
    return { inquiry, leadId: lead?.id ?? null, metaEventId };
  });
}

export async function saveLinkedCounsellingInquiry(
  data: InsertCounsellingInquiry,
  now: Date,
  database: AdmissionsDatabase = db,
  marketing: MarketingCaptureContext = {},
) {
  return database.transaction(async (tx) => {
    const lead = await resolveLead(tx, data.phone, data.name);
    const [inquiry] = await tx.insert(inquiries).values({
      ...data, leadId: lead.id, counsellingSubmittedAt: now,
      counsellingDeliveryStatus: "pending", counsellingDeliveryAttempts: 0,
    }).returning();
    await tx.update(admissionsLeads).set({
      questionnaireStatus: "completed", questionnaireCompletedAt: now,
    }).where(eq(admissionsLeads.id, lead.id));
    let metaEventId: string | null = null;
    if (await metaSchemaReady(tx)) {
      if (marketing.visitorKeyHash) await linkVisitorConsentToLead(tx, marketing.visitorKeyHash, lead.id);
      const consented = marketing.visitorKeyHash ? await hasMarketingConsent(tx, marketing.visitorKeyHash) : false;
      await recordLeadTouchpoint(tx, {
        leadId: lead.id, inquiryId: inquiry.id, sourceChannel: "website_counselling",
        attribution: consented ? marketing.attribution : undefined, occurredAt: now,
      });
      if (marketing.visitorKeyHash && marketing.eventSourceUrl) {
        metaEventId = await enqueueMetaEvent(tx, {
          visitorKeyHash: marketing.visitorKeyHash, leadId: lead.id, inquiryId: inquiry.id,
          eventName: "CounsellingSubmitted", eventSourceUrl: marketing.eventSourceUrl,
          customData: { funnel_step: "counselling_submitted" }, occurredAt: now,
        });
      }
    }
    return { ...inquiry, metaEventId };
  });
}

export async function saveMetaInstantLead(input: {
  metaLeadId: string; pageId: string; formId: string | null; campaignId: string | null;
  adId: string | null; adsetId: string | null; leadCreatedAt: Date | null; fieldData: unknown;
}, now = new Date(), database: AdmissionsDatabase = db) {
  const { mapped, phoneIdentityDiagnostics } = normalizeMetaFieldDataWithDiagnostics(input.fieldData);
  const safeName = mapped.name.trim().length >= 2 ? mapped.name.trim() : "Meta form lead";
  const canonicalPhone = normalizeIndianMobile(mapped.phone);
  const safePhone = canonicalPhone ? `+${canonicalPhone}` : "";
  const safeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mapped.email) ? mapped.email : "";
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${metaLeadIdempotencyKey(input.metaLeadId)}))`);
    const [existing] = await tx.select().from(admissionsMetaLeadLinks)
      .where(eq(admissionsMetaLeadLinks.metaLeadId, input.metaLeadId)).limit(1);
    if (existing) return { duplicate: true, inquiryId: existing.inquiryId, leadId: existing.leadId };

    const lead = canonicalPhone ? await resolveLead(tx, safePhone, safeName) : null;
    const [inquiry] = await tx.insert(inquiries).values({
      leadId: lead?.id ?? null,
      name: safeName,
      email: safeEmail,
      phone: safePhone,
      programInterest: mapped.programInterest,
      message: null,
      submissionSource: "meta_instant_form",
      counsellingDeliveryStatus: "not_applicable",
    }).returning();
    const diagnosticSchemaState = await tx.execute(sql`
      SELECT count(*) = 7 AS ready
      FROM pg_attribute
      WHERE attrelid=to_regclass('admissions_meta_lead_links')
        AND attnum>0 AND NOT attisdropped
        AND attname=ANY(ARRAY[
          'phone_number_field_state','mobile_phone_field_state','whatsapp_number_field_state',
          'phone_normalization_outcome','phone_selected_field','phone_fallback_attempted',
          'phone_invalid_higher_priority_blocked_fallback'
        ]::text[])
    `) as unknown as { rows?: Array<{ ready?: boolean }> };
    const metaLinkValues: typeof admissionsMetaLeadLinks.$inferInsert = {
      metaLeadId: input.metaLeadId, pageId: input.pageId, formId: input.formId,
      campaignId: input.campaignId, adId: input.adId, adsetId: input.adsetId,
      leadCreatedAt: input.leadCreatedAt, receivedAt: now,
      leadId: lead?.id ?? null, inquiryId: inquiry.id,
      state: canonicalPhone ? "processed" : "review",
      errorCode: canonicalPhone ? null : "phone_unavailable_for_identity_link",
    };
    if (diagnosticSchemaState.rows?.[0]?.ready === true) {
      Object.assign(metaLinkValues, {
        phoneNumberFieldState: phoneIdentityDiagnostics.fieldStates.phone_number,
        mobilePhoneFieldState: phoneIdentityDiagnostics.fieldStates.mobile_phone,
        whatsappNumberFieldState: phoneIdentityDiagnostics.fieldStates.whatsapp_number,
        phoneNormalizationOutcome: phoneIdentityDiagnostics.normalizationOutcome,
        phoneSelectedField: phoneIdentityDiagnostics.selectedField,
        phoneFallbackAttempted: phoneIdentityDiagnostics.fallbackAttempted,
        phoneInvalidHigherPriorityBlockedFallback:
          phoneIdentityDiagnostics.invalidHigherPriorityBlockedFallback,
      });
    }
    await tx.insert(admissionsMetaLeadLinks).values(metaLinkValues);
    await tx.insert(admissionsLeadTouchpoints).values({
      leadId: lead?.id ?? null, inquiryId: inquiry.id,
      sourceChannel: "meta_instant_form", source: "meta",
      formId: input.formId, adId: input.adId, adsetId: input.adsetId,
      campaignId: input.campaignId, metaLeadId: input.metaLeadId,
      occurredAt: now,
    }).onConflictDoNothing();
    return { duplicate: false, inquiryId: inquiry.id, leadId: lead?.id ?? null };
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
