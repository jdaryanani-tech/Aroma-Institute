import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { inquiries } from "@shared/schema";
import { admissionsLeads, admissionsLeadContactPreferences as preferences,
  admissionsConversationDispatchGrants as dispatchGrants,
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
async function dispatchGrantSchemaReady(database: Pick<FollowUpDatabase,"execute">) {
  const result=await database.execute<{ready:boolean}>(sql`SELECT
    to_regclass('admissions_conversation_dispatch_grants') IS NOT NULL AND
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='admissions_lead_contact_preferences' AND column_name='consent_epoch') AS ready`);
  return result.rows[0]?.ready===true;
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

type ConsentPreferenceViewRow=Pick<typeof preferences.$inferSelect,
  "consentStatus"|"consentRecordedAt"|"consentSource"|"consentText"|"consentVersion"|
  "statusUpdatedAt"|"optedOutAt"|"optOutSource"> & {consentEpoch?:number};

function asDate(value:Date|string|null|undefined):Date|null {
  if(value==null) return null;
  return value instanceof Date ? value : new Date(value);
}

function normalizeReceiptDates<T extends {consentRecordedAt?:Date|string|null;statusUpdatedAt?:Date|string|null;optedOutAt?:Date|string|null}>(
  row:T|undefined,
):T|undefined {
  return row ? ({
    ...row,
    consentRecordedAt:asDate(row.consentRecordedAt),
    statusUpdatedAt:asDate(row.statusUpdatedAt),
    optedOutAt:asDate(row.optedOutAt),
    ...("consentEpoch" in row ? {consentEpoch:Number(row.consentEpoch)} : {}),
  } as T) : undefined;
}

export function consentView(row?: ConsentPreferenceViewRow) {
  return {
    status:row?.consentStatus ?? "not_recorded",
    recordedAt:asDate(row?.consentRecordedAt)?.toISOString() ?? null,
    source:row?.consentSource ?? null,text:row?.consentText ?? null,version:row?.consentVersion ?? null,
    optedOut:!!row?.optedOutAt || row?.consentStatus==="opted_out",
    optedOutAt:asDate(row?.optedOutAt)?.toISOString() ?? null,optOutSource:row?.optOutSource ?? null,
    allowed:row?.consentStatus==="granted" && !row?.optedOutAt,
  };
}

async function readConsentPreference(leadId:string,database:Pick<FollowUpDatabase,"execute">) {
  const protocolReady=await dispatchGrantSchemaReady(database);
  if(protocolReady) {
    const result=await database.execute<ConsentPreferenceViewRow>(sql`SELECT
      consent_status AS "consentStatus",consent_recorded_at AS "consentRecordedAt",
      consent_source AS "consentSource",consent_text AS "consentText",
      consent_version AS "consentVersion",status_updated_at AS "statusUpdatedAt",
      opted_out_at AS "optedOutAt",opt_out_source AS "optOutSource",
      consent_epoch AS "consentEpoch"
      FROM admissions_lead_contact_preferences WHERE lead_id=${leadId}`);
    return normalizeReceiptDates(result.rows[0]) as ConsentPreferenceViewRow|undefined;
  }
  const result=await database.execute<ConsentPreferenceViewRow>(sql`SELECT
    consent_status AS "consentStatus",consent_recorded_at AS "consentRecordedAt",
    consent_source AS "consentSource",consent_text AS "consentText",
    consent_version AS "consentVersion",status_updated_at AS "statusUpdatedAt",
    opted_out_at AS "optedOutAt",opt_out_source AS "optOutSource"
    FROM admissions_lead_contact_preferences WHERE lead_id=${leadId}`);
  return result.rows[0] ? {...normalizeReceiptDates(result.rows[0]),consentEpoch:0} as ConsentPreferenceViewRow : undefined;
}

async function counsellingFormsByPhone(canonicalPhone:string,database:FollowUpDatabase) {
  const normalized=sql<string>`regexp_replace(${inquiries.phone}, '[^0-9]', '', 'g')`;
  return database.select({
    id:inquiries.id,leadId:inquiries.leadId,name:inquiries.name,
    submittedAt:inquiries.counsellingSubmittedAt,answers:inquiries.counsellingAnswers,
    source:inquiries.submissionSource,
  }).from(inquiries).where(and(
    isNotNull(inquiries.counsellingAnswers),
    sql`btrim(${inquiries.phone}) ~ '^\\+?[0-9[:space:]().-]+$'`,
    sql`${normalized} IN (${canonicalPhone}, ${canonicalPhone.slice(2)}, ${`0${canonicalPhone.slice(2)}`})`,
  )).orderBy(sql`${inquiries.counsellingSubmittedAt} DESC NULLS LAST`,desc(inquiries.id)).limit(2);
}

/** Called within the identity transaction, under its canonical-phone advisory lock. */
export async function recordRegistrationFollowUp(tx:Transaction,lead:Lead,firstRegistration:boolean,optIn:boolean,now:Date) {
  if(!await followUpSchemaReady(tx)) return false; // Stage 1 stays available pending migration.
  const protocolReady=await dispatchGrantSchemaReady(tx);
  type ReceiptRow={
    consentStatus:"not_provided"|"granted"|"opted_out";
    optedOutAt:Date|null;
    consentEpoch:number;
    consentRecordedAt:Date|null;
    consentSource:string|null;
    consentText:string|null;
    consentVersion:string|null;
    optOutSource:string|null;
  };
  let receipt:ReceiptRow|undefined;
  if(protocolReady) {
    const result=await tx.execute<ReceiptRow>(sql`SELECT consent_status AS "consentStatus",
      opted_out_at AS "optedOutAt",consent_epoch AS "consentEpoch",
      consent_recorded_at AS "consentRecordedAt",consent_source AS "consentSource",
      consent_text AS "consentText",consent_version AS "consentVersion",
      opt_out_source AS "optOutSource"
      FROM admissions_lead_contact_preferences WHERE lead_id=${lead.id} FOR UPDATE`);
    receipt=normalizeReceiptDates(result.rows[0]);
  } else {
    const result=await tx.execute<Omit<ReceiptRow,"consentEpoch">&{consentEpoch?:never}>(sql`SELECT
      consent_status AS "consentStatus",opted_out_at AS "optedOutAt",
      consent_recorded_at AS "consentRecordedAt",consent_source AS "consentSource",
      consent_text AS "consentText",consent_version AS "consentVersion",
      opt_out_source AS "optOutSource"
      FROM admissions_lead_contact_preferences WHERE lead_id=${lead.id} FOR UPDATE`);
    receipt=result.rows[0] ? {...normalizeReceiptDates(result.rows[0]),consentEpoch:0} as ReceiptRow : undefined;
  }
  const protectedChoice=receipt?.optedOutAt || receipt?.consentStatus==="opted_out" || receipt?.consentStatus==="granted";
  if(!receipt || (!protectedChoice && optIn)) {
    const nextStatus=optIn ? "granted" : "not_provided";
    const previousAllowed=receipt?.consentStatus==="granted" && !receipt.optedOutAt;
    const nextAllowed=nextStatus==="granted";
    const previousOptedOut=receipt?.consentStatus==="opted_out" || !!receipt?.optedOutAt;
    const nextOptedOut=false;
    const effectiveChange=previousAllowed!==nextAllowed || previousOptedOut!==nextOptedOut;
    const values={
      leadId:lead.id,consentStatus:nextStatus,
      consentRecordedAt:now,consentSource:"vsl_registration",
      consentText:VSL_WHATSAPP_CONSENT_TEXT,consentVersion:VSL_WHATSAPP_CONSENT_VERSION,statusUpdatedAt:now,
      ...(protocolReady ? {consentEpoch:(receipt?.consentEpoch??0)+(effectiveChange?1:0)} : {}),
    };
    await tx.insert(preferences).values(values).onConflictDoUpdate({target:preferences.leadId,set:values});
    receipt={
      consentStatus:nextStatus,optedOutAt:null,consentEpoch:(receipt?.consentEpoch??0)+(protocolReady&&effectiveChange?1:0),
      consentRecordedAt:now,consentSource:"vsl_registration",consentText:VSL_WHATSAPP_CONSENT_TEXT,
      consentVersion:VSL_WHATSAPP_CONSENT_VERSION,optOutSource:null,
    };
    if(protocolReady&&effectiveChange) {
      await tx.update(dispatchGrants).set({state:"revoked",completedAt:now,safeOutcome:"send_denied"})
        .where(and(eq(dispatchGrants.leadId,lead.id),eq(dispatchGrants.state,"issued")));
    }
  }
  if(firstRegistration) {
    const eventId=`vsl-registration:${lead.id}`;
    const consent={
      status:receipt?.consentStatus ?? "not_recorded",
      recordedAt:receipt?.consentRecordedAt?.toISOString() ?? null,
      source:receipt?.consentSource ?? null,text:receipt?.consentText ?? null,
      version:receipt?.consentVersion ?? null,
      optedOut:!!receipt?.optedOutAt || receipt?.consentStatus==="opted_out",
      optedOutAt:receipt?.optedOutAt?.toISOString() ?? null,optOutSource:receipt?.optOutSource ?? null,
      allowed:receipt?.consentStatus==="granted" && !receipt?.optedOutAt,
    };
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
    const protocolReady=await dispatchGrantSchemaReady(tx);
    type ExistingReceipt={consentStatus:"not_provided"|"granted"|"opted_out";optedOutAt:Date|null;consentEpoch:number};
    let prior:ExistingReceipt|undefined;
    if(protocolReady) {
      const result=await tx.execute<ExistingReceipt>(sql`SELECT consent_status AS "consentStatus",
        opted_out_at AS "optedOutAt",consent_epoch AS "consentEpoch"
        FROM admissions_lead_contact_preferences WHERE lead_id=${leadId} FOR UPDATE`);
      prior=result.rows[0] ? {
        ...result.rows[0],optedOutAt:asDate(result.rows[0].optedOutAt),
        consentEpoch:Number(result.rows[0].consentEpoch),
      } : undefined;
    } else {
      const result=await tx.execute<Omit<ExistingReceipt,"consentEpoch">&{consentEpoch?:never}>(sql`SELECT
        consent_status AS "consentStatus",opted_out_at AS "optedOutAt"
        FROM admissions_lead_contact_preferences WHERE lead_id=${leadId} FOR UPDATE`);
      prior=result.rows[0] ? {...result.rows[0],optedOutAt:asDate(result.rows[0].optedOutAt),consentEpoch:0} : undefined;
    }
    const wasOptedOut=prior?.consentStatus==="opted_out" || !!prior?.optedOutAt;
    const effectiveChange=!wasOptedOut;
    const values={
      leadId,consentStatus:"opted_out" as const,optedOutAt:now,optOutSource:source,statusUpdatedAt:now,
      ...(protocolReady ? {consentEpoch:(prior?.consentEpoch??0)+(effectiveChange?1:0)} : {}),
    };
    await tx.insert(preferences).values({
      ...values,
    }).onConflictDoUpdate({target:preferences.leadId,set:{
      consentStatus:"opted_out",optedOutAt:sql`coalesce(${preferences.optedOutAt},${now})`,
      optOutSource:sql`coalesce(${preferences.optOutSource},${source})`,statusUpdatedAt:now,
      ...(protocolReady ? {consentEpoch:values.consentEpoch} : {}),
    }});
    if(protocolReady&&effectiveChange) {
      await tx.update(dispatchGrants).set({state:"revoked",completedAt:now,safeOutcome:"send_denied"})
        .where(and(eq(dispatchGrants.leadId,leadId),eq(dispatchGrants.state,"issued")));
    }
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
  if(lead) {
    const status=await buildLeadStatus(lead,database);
    const hasSavedForm=!!status.questionnaire.latestSubmission;
    const phoneForms=hasSavedForm?[]:await counsellingFormsByPhone(canonicalPhone,database);
    if(!hasSavedForm&&phoneForms.length===1&&(!phoneForms[0].leadId||phoneForms[0].leadId===lead.id)) {
      const form=phoneForms[0];
      const q29=form.answers?.consentToContact===true?true:form.answers?.consentToContact===false?false:null;
      return {
        ...status,
        questionnaire:{status:"completed",completedAt:form.submittedAt?.toISOString()??null,
          latestSubmission:{submissionId:form.id,submittedAt:form.submittedAt?.toISOString()??null,answers:form.answers,source:form.source}},
        consent:{...status.consent,counsellingQuestion29:{
          consentToContact:q29,recordedAt:form.submittedAt?.toISOString()??null,inquiryId:form.id,
          source:"counselling_question_29",allowed:q29===true&&!status.consent.optedOut,
        }},
      };
    }
    return {
      ...status,
      questionnaire:{
        ...status.questionnaire,
        status:hasSavedForm?"completed":phoneForms.length?"review_required":"not_submitted",
        completedAt:hasSavedForm?status.questionnaire.completedAt:null,
      },
    };
  }
  const legacy=await counsellingFormsByPhone(canonicalPhone,database);
  if(legacy.length>1) return {
    leadId:null,phone:canonicalPhone,name:null,registeredAt:null,
    video:{observedPercent:0,lastMilestone:null,lastEventAt:null,completedAt:null,milestones:[]},
    questionnaire:{status:"review_required",completedAt:null,latestSubmission:null},
    consent:{whatsappAdmissions:consentView(),counsellingQuestion29:{consentToContact:null,recordedAt:null,inquiryId:null,source:null,allowed:false},optedOut:false,optedOutAt:null},
  };
  if(!legacy[0]) return {
    leadId:null,phone:canonicalPhone,name:null,registeredAt:null,
    video:{observedPercent:0,lastMilestone:null,lastEventAt:null,completedAt:null,milestones:[]},
    questionnaire:{status:"not_submitted",completedAt:null,latestSubmission:null},
    consent:{whatsappAdmissions:consentView(),counsellingQuestion29:{consentToContact:null,recordedAt:null,inquiryId:null,source:null,allowed:false},optedOut:false,optedOutAt:null},
  };
  const form=legacy[0];
  const question29=form.answers?.consentToContact===true?true:form.answers?.consentToContact===false?false:null;
  return {
    leadId:form.leadId,phone:canonicalPhone,name:form.name,registeredAt:null,
    video:{observedPercent:0,lastMilestone:null,lastEventAt:null,completedAt:null,milestones:[]},
    questionnaire:{status:"completed",completedAt:form.submittedAt?.toISOString()??null,
      latestSubmission:{submissionId:form.id,submittedAt:form.submittedAt?.toISOString()??null,answers:form.answers,source:form.source}},
    consent:{whatsappAdmissions:consentView(),counsellingQuestion29:{consentToContact:question29,
      recordedAt:form.submittedAt?.toISOString()??null,inquiryId:form.id,source:"counselling_question_29",
      allowed:question29===true},optedOut:false,optedOutAt:null},
  };
}

async function buildLeadStatus(lead:Lead,database:FollowUpDatabase) {
  const receipt=await readConsentPreference(lead.id,database);
  const [form]=await database.select({
    id:inquiries.id,at:inquiries.counsellingSubmittedAt,
    consent:sql<unknown>`${inquiries.counsellingAnswers}->'consentToContact'`,
    answers:inquiries.counsellingAnswers,source:inquiries.submissionSource,
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
      latestSubmission:form ? {submissionId:form.id,submittedAt:form.at?.toISOString() ?? null,answers:form.answers,source:form.source} : null,
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
