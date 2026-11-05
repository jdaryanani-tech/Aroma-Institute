import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { inquiries } from "@shared/schema";
import { admissionsLeads, admissionsLeadContactPreferences as preferences,
  admissionsRegistrationOutbox as outbox, admissionsVideoEvents } from "@shared/admissions-schema";
import { VSL_WHATSAPP_CONSENT_TEXT, VSL_WHATSAPP_CONSENT_VERSION } from "@shared/vsl-consent";
import { normalizeIndianMobile } from "@shared/indian-mobile";

export type FollowUpDatabase = Pick<typeof db,"execute"|"select"|"insert"|"update"|"transaction">;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Lead = typeof admissionsLeads.$inferSelect;
export async function followUpSchemaReady(database: Pick<FollowUpDatabase,"execute"> = db) {
  const result=await database.execute<{ready:boolean}>(sql`SELECT
    to_regclass('admissions_lead_contact_preferences') IS NOT NULL AND
    to_regclass('admissions_registration_outbox') IS NOT NULL AS ready`);
  return result.rows[0]?.ready === true;
}
export async function admissionsIntegrationSchemaReady(database: Pick<FollowUpDatabase,"execute"> = db) {
  const result=await database.execute<{ready:boolean}>(sql`SELECT
    to_regclass('admissions_leads') IS NOT NULL AND
    to_regclass('admissions_vsl_playbacks') IS NOT NULL AND
    to_regclass('admissions_vsl_events') IS NOT NULL AND
    to_regclass('admissions_lead_contact_preferences') IS NOT NULL AND
    to_regclass('admissions_registration_outbox') IS NOT NULL AND
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='admissions_leads' AND column_name='video_observed_percent') AND
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='inquiries' AND column_name='submission_idempotency_key') AS ready`);
  return result.rows[0]?.ready===true;
}

export function consentView(row?: typeof preferences.$inferSelect) {
  return {
    status:row?.consentStatus ?? "not_recorded",
    recordedAt:row?.consentRecordedAt?.toISOString() ?? null,
    source:row?.consentSource ?? null,text:row?.consentText ?? null,version:row?.consentVersion ?? null,
    optedOut:!!row?.optedOutAt || row?.consentStatus==="opted_out",
    optedOutAt:row?.optedOutAt?.toISOString() ?? null,optOutSource:row?.optOutSource ?? null,
    allowed:row?.consentStatus==="granted" && !row?.optedOutAt,
  };
}

/** Called within the identity transaction, under its canonical-phone advisory lock. */
export async function recordRegistrationFollowUp(tx:Transaction,lead:Lead,firstRegistration:boolean,optIn:boolean,now:Date) {
  if(!await followUpSchemaReady(tx)) return false; // Stage 1 stays available pending migration.
  let [receipt]=await tx.select().from(preferences).where(eq(preferences.leadId,lead.id)).for("update");
  const protectedChoice=receipt?.optedOutAt || receipt?.consentStatus==="opted_out" || receipt?.consentStatus==="granted";
  if(!receipt || (!protectedChoice && optIn)) {
    const values={
      leadId:lead.id,consentStatus:optIn ? "granted" : "not_provided",
      consentRecordedAt:now,consentSource:"vsl_registration",
      consentText:VSL_WHATSAPP_CONSENT_TEXT,consentVersion:VSL_WHATSAPP_CONSENT_VERSION,statusUpdatedAt:now,
    };
    [receipt]=await tx.insert(preferences).values(values).onConflictDoUpdate({
      target:preferences.leadId,set:values,
    }).returning();
  }
  if(firstRegistration) {
    const eventId=`vsl-registration:${lead.id}`;
    const consent=consentView(receipt);
    await tx.insert(outbox).values({
      leadId:lead.id,idempotencyKey:eventId,createdAt:now,availableAt:now,
      payload:{
        schemaVersion:1,event:"vsl.registered",eventId,leadId:lead.id,
        phone:lead.canonicalPhone,name:lead.name,registeredAt:lead.registeredAt?.toISOString(),
        source:lead.entrySource,entryPath:lead.entryPath,entryHost:lead.entryHost,
        consentToContact:consent.allowed,consent,
      },
    }).onConflictDoNothing();
  }
  return true;
}

/** Internal server-side building block; intentionally no public opt-out write route. */
export async function recordWhatsAppOptOut(leadId:string,source:"admin"|"n8n"|"prospect",database:FollowUpDatabase=db,now=new Date()) {
  return database.transaction(async tx=>{
    const [lead]=await tx.select().from(admissionsLeads).where(eq(admissionsLeads.id,leadId));
    if(!lead) return false;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`admissions:${lead.canonicalPhone}`}))`);
    await tx.insert(preferences).values({
      leadId,consentStatus:"opted_out",optedOutAt:now,optOutSource:source,statusUpdatedAt:now,
    }).onConflictDoUpdate({target:preferences.leadId,set:{
      consentStatus:"opted_out",optedOutAt:sql`coalesce(${preferences.optedOutAt},${now})`,
      optOutSource:sql`coalesce(${preferences.optOutSource},${source})`,statusUpdatedAt:now,
    }});
    return true;
  });
}

export async function readLeadFollowUpStatus(leadId:string,database:FollowUpDatabase=db) {
  const [lead]=await database.select().from(admissionsLeads).where(eq(admissionsLeads.id,leadId));
  if(!lead) return null;
  return buildLeadStatus(lead,database);
}

export async function readLeadFollowUpByPhone(phone:string,database:FollowUpDatabase=db) {
  const canonicalPhone=normalizeIndianMobile(phone);
  if(!canonicalPhone) return null;
  const [lead]=await database.select().from(admissionsLeads).where(eq(admissionsLeads.canonicalPhone,canonicalPhone));
  if(!lead) return null;
  return buildLeadStatus(lead,database);
}

async function buildLeadStatus(lead:Lead,database:FollowUpDatabase) {
  const [receipt]=await database.select().from(preferences).where(eq(preferences.leadId,lead.id));
  const [form]=await database.select({
    id:inquiries.id,at:inquiries.counsellingSubmittedAt,
    consent:sql<unknown>`${inquiries.counsellingAnswers}->'consentToContact'`,
    answers:inquiries.counsellingAnswers,
  }).from(inquiries).where(and(eq(inquiries.leadId,lead.id),isNotNull(inquiries.counsellingAnswers)))
    .orderBy(sql`${inquiries.counsellingSubmittedAt} DESC NULLS LAST`,desc(inquiries.id)).limit(1);
  const events=await database.select().from(admissionsVideoEvents)
    .where(eq(admissionsVideoEvents.leadId,lead.id)).orderBy(admissionsVideoEvents.occurredAt);
  const consent=consentView(receipt);
  const question29=form?.consent===true ? true : form?.consent===false ? false : null;
  return {
    leadId:lead.id,phone:lead.canonicalPhone,name:lead.name,
    registeredAt:lead.registeredAt?.toISOString() ?? null,
    video:{
      observedPercent:lead.videoObservedPercent,
      lastMilestone:lead.videoLastMilestone,
      lastEventAt:lead.videoLastEventAt?.toISOString() ?? null,
      completedAt:lead.videoCompletedAt?.toISOString() ?? null,
      milestones:events.map(e=>({event:e.event,occurredAt:e.occurredAt.toISOString(),
        positionSeconds:e.positionSeconds,durationSeconds:e.durationSeconds})),
    },
    questionnaire:{
      status:lead.questionnaireStatus,completedAt:lead.questionnaireCompletedAt?.toISOString() ?? null,
      latestSubmission:form ? {submissionId:form.id,submittedAt:form.at?.toISOString() ?? null,answers:form.answers} : null,
    },
    consent:{
      whatsappAdmissions:consent,
      counsellingQuestion29:{
        consentToContact:question29,recordedAt:form?.at?.toISOString() ?? null,
        inquiryId:form?.id ?? null,source:form ? "counselling_question_29" : null,
        allowed:question29===true && !consent.optedOut,
      },
      optedOut:consent.optedOut,optedOutAt:consent.optedOutAt,
    },
  };
}
