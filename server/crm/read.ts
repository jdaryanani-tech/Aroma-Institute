import { CRM_STAGES, type CrmActivity, type CrmDetail, type CrmFilters, type CrmList, type CrmOverview } from "@shared/crm";
import { crmModelSql, inspectCrmSchema, iso, leadDto, schemaWarnings, type CrmSchema, type SqlDb } from "./model";
import { CrmError } from "./evidence";
import { readSupabaseConversationPage } from "../db/supabase-avni-readonly";

export async function findPerson(db: SqlDb, c: CrmSchema, id: string) {
  // Inquiry aliases continue resolving after an unambiguous registration links the record.
  const { rows: [row] } = await db.query(`${crmModelSql(c)} SELECT * FROM model WHERE id=$1
    OR EXISTS(SELECT 1 FROM unnest(inquiry_ids) a(inquiry_id) WHERE 'inquiry:'||a.inquiry_id=$1) LIMIT 1`, [id]);
  if (!row) throw new CrmError(404, "Lead not found.");
  return row;
}

export async function listCrm(db: SqlDb, filters: CrmFilters): Promise<CrmList> {
  const c = await inspectCrmSchema(db);
  const sql = crmModelSql(c);
  const values: unknown[] = [];
  const where: string[] = [];
  const add = (expression: string, value: unknown) => { values.push(value); where.push(expression.replace("?", `$${values.length}`)); };
  if (filters.q) {
    const textIndex = values.push(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
    const digits = /^[+0-9 ().-]+$/.test(filters.q) ? filters.q.replace(/\D/g,"") : "";
    if(digits.length>=3) {
      const phoneIndex=values.push(`%${digits}%`);
      where.push(`(search_text ILIKE $${textIndex} ESCAPE '\\' OR phone_search LIKE $${phoneIndex})`);
    } else where.push(`search_text ILIKE $${textIndex} ESCAPE '\\'`);
  }
  if (filters.stage) add("stage=?", filters.stage);
  if (filters.program) add("?=ANY(programs)", filters.program);
  if (filters.source) add("?=ANY(sources)", filters.source);
  if (filters.dateFrom) add("(last_activity_at AT TIME ZONE 'Asia/Kolkata')::date>=?::date", filters.dateFrom);
  if (filters.dateTo) add("(last_activity_at AT TIME ZONE 'Asia/Kolkata')::date<=?::date", filters.dateTo);
  if (filters.owner === "unassigned") where.push("owner_id IS NULL");
  else if (filters.owner) add("owner_id=?::integer", filters.owner);
  if (filters.followUp === "none") where.push("follow_up_at IS NULL");
  if (filters.followUp === "overdue") where.push("follow_up_at<now()");
  if (filters.followUp === "upcoming") where.push("follow_up_at>now()");
  if (filters.followUp === "today") where.push("(follow_up_at AT TIME ZONE 'Asia/Kolkata')::date=(now() AT TIME ZONE 'Asia/Kolkata')::date");
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sort = ({ recent: "last_activity_at DESC NULLS LAST", oldest: "last_activity_at ASC NULLS LAST",
    name: "lower(display_name) ASC", followup: "follow_up_at ASC NULLS LAST" } as Record<string, string>)[filters.sort || "recent"];
  const page = filters.page || 1, pageSize = filters.pageSize || 20;
  const [items, total, stats, counts, options, owners] = await Promise.all([
    db.query(`${sql} SELECT * FROM model ${filter} ORDER BY ${sort},id LIMIT $${values.length+1} OFFSET $${values.length+2}`,
      [...values, pageSize, (page-1)*pageSize]),
    db.query(`${sql} SELECT count(*)::integer total FROM model ${filter}`, values),
    db.query(`${sql} SELECT
      count(*) FILTER(WHERE identity_status IN ('linked','unique_phone'))::integer identified_people,
      count(*) FILTER(WHERE identity_status IN ('ambiguous','unmatchable'))::integer unresolved_records,
      coalesce(sum(inquiry_count),0)::integer total_enquiries,
      count(*) FILTER(WHERE identity_status IN ('linked','unique_phone') AND registered_at IS NOT NULL)::integer registered_people,
      count(*) FILTER(WHERE identity_status IN ('linked','unique_phone') AND video_started)::integer video_started,
      count(*) FILTER(WHERE identity_status IN ('linked','unique_phone') AND video_watched)::integer video_watched,
      count(*) FILTER(WHERE identity_status IN ('linked','unique_phone') AND has_verified_form)::integer verified_forms,
      count(*) FILTER(WHERE identity_status IN ('linked','unique_phone') AND registered_at IS NOT NULL AND has_verified_form)::integer registered_with_form,
      count(*) FILTER(WHERE identity_status IN ('linked','unique_phone') AND registered_at IS NOT NULL AND NOT has_verified_form)::integer registered_without_form
      FROM model`),
    db.query(`${sql} SELECT stage,count(*)::integer count FROM model WHERE identity_status IN ('linked','unique_phone') GROUP BY stage`),
    db.query(`${sql} SELECT
      ARRAY(SELECT DISTINCT unnest(programs) FROM model ORDER BY 1) programs,
      ARRAY(SELECT DISTINCT unnest(sources) FROM model ORDER BY 1) sources`),
    db.query(`SELECT u.id,coalesce(u.display_name,'Admin #'||u.id) name FROM lms_users u
      JOIN lms_user_roles r ON r.user_id=u.id AND r.role='admin' WHERE u.is_active ORDER BY name`),
  ]);
  const s = stats.rows[0];
  const stageCounts = Object.fromEntries(Object.keys(CRM_STAGES).map(k => [k, 0])) as CrmOverview["stageCounts"];
  for (const row of counts.rows) stageCounts[row.stage as keyof typeof stageCounts] = row.count;
  return {
    items: items.rows.map(leadDto), page, pageSize, total: total.rows[0].total,
    totalPages: Math.ceil(total.rows[0].total/pageSize),
    overview: { identifiedPeople:s.identified_people, unresolvedRecords:s.unresolved_records,
      totalEnquiries:s.total_enquiries, stageCounts, registeredPeople:s.registered_people,
      videoStarted:s.video_started, videoWatched:s.video_watched, verifiedForms:s.verified_forms,
      registeredWithForm:s.registered_with_form, registeredWithoutForm:s.registered_without_form,
      registeredToFormPercent:s.registered_people ? Math.round(100*s.registered_with_form/s.registered_people) : null,
      enrolledPercent:s.identified_people ? Math.round(100*stageCounts.enrolled/s.identified_people) : null },
    options: { ...options.rows[0], owners:owners.rows },
    capabilities:c, warnings:schemaWarnings(c),
  };
}

export async function detailCrm(db: SqlDb, id: string): Promise<CrmDetail> {
  const c = await inspectCrmSchema(db), row = await findPerson(db, c, id), lead = leadDto(row);
  const ids: number[] = row.inquiry_ids;
  const { rows: [metaSchema] } = await db.query(`SELECT
    to_regclass('admissions_lead_touchpoints') IS NOT NULL AS touchpoints,
    to_regclass('admissions_marketing_consent_events') IS NOT NULL AS consent,
    to_regclass('admissions_meta_lead_links') IS NOT NULL AS leadLinks,
    to_regclass('admissions_meta_event_outbox') IS NOT NULL AS outbox`);
  const marketingAvailable = !!metaSchema?.touchpoints && !!metaSchema?.consent && !!metaSchema?.leadLinks && !!metaSchema?.outbox;
  const [{ rows: inquiries }, { rows: attempts }, { rows: activities }, { rows: events },
    { rows: bookings }] = await Promise.all([
    db.query("SELECT to_jsonb(i) data FROM inquiries i WHERE id=ANY($1::integer[]) ORDER BY id DESC", [ids]),
    c.deliveryAttempts ? db.query("SELECT * FROM counselling_delivery_attempts WHERE inquiry_id=ANY($1::integer[]) ORDER BY attempted_at", [ids]) : Promise.resolve({rows:[]}),
    c.crmPersistence ? db.query(`SELECT a.*,coalesce(u.display_name,'Admin #'||a.actor_id) actor_name
      FROM admissions_crm_activities a JOIN lms_users u ON u.id=a.actor_id
      WHERE inquiry_id=ANY($1::integer[]) ORDER BY occurred_at,id`, [ids]) : Promise.resolve({rows:[]}),
    c.videoTracking && lead.leadId ? db.query("SELECT * FROM admissions_vsl_events WHERE lead_id=$1 ORDER BY occurred_at,event", [lead.leadId]) : Promise.resolve({rows:[]}),
    c.calendarBookingVerification ? db.query(`SELECT id,title,status,starts_at,ends_at,owner_id,source_type,confirmation_message_id
      FROM calendar_events WHERE (lead_id=$1 OR inquiry_id=ANY($2::integer[])) AND source_type='counselling_booking'
      ORDER BY starts_at,id`, [lead.leadId, ids]) : Promise.resolve({rows:[]}),
  ]);
  const marketingRows = marketingAvailable ? await Promise.all([
    db.query(`SELECT source_channel,source,medium,campaign,campaign_id,ad_id,adset_id,form_id,meta_lead_id,occurred_at
      FROM admissions_lead_touchpoints WHERE lead_id=$1 OR inquiry_id=ANY($2::integer[]) ORDER BY occurred_at,id`, [lead.leadId, ids]),
    lead.leadId ? db.query(`SELECT consent_status,occurred_at FROM admissions_marketing_consent_events
      WHERE lead_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`, [lead.leadId]) : Promise.resolve({rows:[]}),
    db.query(`SELECT event_id,event_name,state,attempt_count,last_attempt_at,response_at,http_status,last_error
      FROM admissions_meta_event_outbox WHERE lead_id=$1 OR inquiry_id=ANY($2::integer[])
      ORDER BY event_time,event_id`, [lead.leadId, ids]),
    db.query(`SELECT meta_lead_id,state,error_code,received_at FROM admissions_meta_lead_links
      WHERE lead_id=$1 OR inquiry_id=ANY($2::integer[]) ORDER BY received_at,meta_lead_id`, [lead.leadId, ids]),
  ]) : [{rows:[]}, {rows:[]}, {rows:[]}, {rows:[]}];
  const marketing: CrmDetail["marketing"] = {
    available: marketingAvailable,
    consentStatus: marketingRows[1].rows[0]?.consent_status ?? null,
    consentAt: iso(marketingRows[1].rows[0]?.occurred_at),
    touchpoints: marketingRows[0].rows.map((t: any) => ({
      sourceChannel:t.source_channel,source:t.source,medium:t.medium,campaign:t.campaign,
      campaignId:t.campaign_id,adId:t.ad_id,adsetId:t.adset_id,formId:t.form_id,
      metaLeadId:t.meta_lead_id,occurredAt:iso(t.occurred_at)!,
    })),
    metaLeadLinks: marketingRows[3].rows.map((m: any) => ({
      metaLeadId:m.meta_lead_id,state:m.state,errorCode:m.error_code,receivedAt:iso(m.received_at)!,
    })),
    capiDeliveries: marketingRows[2].rows.map((e: any) => ({
      eventId:e.event_id,eventName:e.event_name,state:e.state,attemptCount:e.attempt_count,
      lastAttemptAt:iso(e.last_attempt_at),responseAt:iso(e.response_at),httpStatus:e.http_status,lastError:e.last_error,
    })),
  };
  const timeline: CrmActivity[] = activities.map(a => ({
    id:a.id,type:a.type,title:({stage:"Lifecycle changed",owner:"Owner changed",followup:"Follow-up changed",note:"Internal note"} as Record<string,string>)[a.type] || a.type,
    at:iso(a.occurred_at), actorId:a.actor_id, actorName:a.actor_name, source:"staff",body:a.body,data:a.data,
  }));
  const submissions = inquiries.map(({data:i}) => {
    timeline.push({id:`inquiry:${i.id}`,type:"inquiry",title:`Inquiry #${i.id} saved`,at:iso(i.counselling_submitted_at),actorId:null,
      actorName:null,source:"inquiry",body:i.counselling_submitted_at ? null : "Original submission timestamp was not recorded.",data:{inquiryId:i.id}});
    if (i.counselling_answers && i.counselling_submitted_at) timeline.push({
      id:`form:${i.id}`,type:"verified_form",title:"Form Submitted — saved questionnaire",at:iso(i.counselling_submitted_at),
      actorId:null,actorName:null,source:"verified_system",body:"Verified from the saved inquiry, not webhook acknowledgement.",
      data:{to:"form_submitted",inquiryId:i.id},
    });
    return {
      id:i.id,name:i.name,email:i.email,phone:i.phone,programInterest:i.program_interest,message:i.message,
      counsellingAnswers:i.counselling_answers,counsellingSubmittedAt:iso(i.counselling_submitted_at),
      counsellingDeliveryStatus:i.counselling_delivery_status,counsellingDeliveryAttempts:i.counselling_delivery_attempts,
      counsellingDeliveryLastAttemptAt:iso(i.counselling_delivery_last_attempt_at),
      counsellingDeliveryLastResult:i.counselling_delivery_last_result,
      counsellingDeliveryLastVerifiedAt:iso(i.counselling_delivery_last_verified_at),
      deliveryAttemptHistory: attempts.filter(a=>a.inquiry_id===i.id).map(a=>({
        id:a.id,attemptNumber:a.attempt_number,attemptedAt:iso(a.attempted_at)!,responseAt:iso(a.response_at),
        httpStatus:a.http_status,deliveryState:a.delivery_state,errorSummary:a.error_summary,
      })),
    };
  });
  for (const a of attempts) timeline.push({
    id:`delivery:${a.id}`,type:"delivery",title:`Webhook delivery: ${a.delivery_state}`,at:iso(a.attempted_at),
    actorId:null,actorName:null,source:"verified_system",body:a.error_summary,
    data:{inquiryId:a.inquiry_id,httpStatus:a.http_status,responseAt:iso(a.response_at),bookingConfirmed:false},
  });
  for (const e of events) timeline.push({
    id:e.id,type:"video",title:e.event==="completed" ? "Video completion observed" : `Video milestone: ${e.event}`,
    at:iso(e.occurred_at),actorId:null,actorName:null,source:"verified_system",body:null,
    data:{event:e.event,positionSeconds:e.position_seconds,durationSeconds:e.duration_seconds},
  });
  for (const booking of bookings) timeline.push({
    id:`calendar:${booking.id}`,type:"calendar_booking",
    title:`Counselling appointment ${booking.status}`,
    at:iso(booking.starts_at),actorId:booking.owner_id,actorName:null,source:"verified_system",
    body:booking.status === "cancelled" ? "Cancelled in the AICHM Calendar." : "Persisted AICHM Calendar booking.",
    data:{bookingReference:booking.id,startsAt:iso(booking.starts_at),endsAt:iso(booking.ends_at),confirmedByMessageId:booking.confirmation_message_id},
  });
  for (const t of marketing.touchpoints) timeline.push({
    id:`touchpoint:${t.metaLeadId ?? t.occurredAt}:${t.sourceChannel}`,type:"source",
    title:`Lead source: ${t.sourceChannel}`,at:t.occurredAt,actorId:null,actorName:null,
    source:"verified_system",body:[t.campaign,t.medium].filter(Boolean).join(" · ") || null,
    data:{source:t.source,campaignId:t.campaignId,adId:t.adId,formId:t.formId,metaLeadId:t.metaLeadId},
  });
  for (const delivery of marketing.capiDeliveries) timeline.push({
    id:`meta-delivery:${delivery.eventId}`,type:"meta_delivery",title:`Meta CAPI ${delivery.state}: ${delivery.eventName}`,
    at:delivery.responseAt ?? delivery.lastAttemptAt,actorId:null,actorName:null,
    source:"verified_system",body:delivery.lastError,
    data:{httpStatus:delivery.httpStatus,attemptCount:delivery.attemptCount},
  });
  if (marketing.consentStatus && marketing.consentAt) timeline.push({
    id:`marketing-consent:${lead.leadId}`,type:"marketing_consent",
    title:`Meta measurement consent ${marketing.consentStatus}`,at:marketing.consentAt,
    actorId:null,actorName:null,source:"verified_system",body:"Recorded from the optional marketing measurement control.",
    data:{policyVersion:"meta-measurement-v1"},
  });
  let journey: CrmDetail["journey"] = null;
  if(c.identityTracking && lead.leadId) {
    const {rows:[l]} = await db.query("SELECT * FROM admissions_leads WHERE id=$1", [lead.leadId]);
    if(l) {
      journey = {leadId:l.id,registeredAt:iso(l.registered_at),lastRegisteredAt:iso(l.last_registered_at),
        entrySource:l.entry_source,entryPath:l.entry_path,entryHost:l.entry_host,questionnaireStatus:l.questionnaire_status,
        questionnaireCompletedAt:iso(l.questionnaire_completed_at),
        videoObservedPercent:l.video_observed_percent ?? 0,videoLastMilestone:l.video_last_milestone ?? null,
        videoLastEventAt:iso(l.video_last_event_at),videoCompletedAt:iso(l.video_completed_at),
        legacyMatchStatus:l.legacy_match_status,
        linkedInquiryIds:ids,events:events.map(e=>({event:e.event,occurredAt:iso(e.occurred_at)!,positionSeconds:e.position_seconds,durationSeconds:e.duration_seconds}))};
      if(l.registered_at) timeline.push({id:`registration:${l.id}`,type:"registration",title:"VSL registration saved",
        at:iso(l.registered_at),actorId:null,actorName:null,source:"verified_system",body:l.entry_source,data:{entryPath:l.entry_path}});
    }
  }
  timeline.sort((a,b)=>(a.at ? new Date(a.at).getTime():0)-(b.at ? new Date(b.at).getTime():0) || a.id.localeCompare(b.id));
  let conversationHistory: CrmDetail["conversationHistory"] = {
    state: lead.leadId ? (c.chatHistory ? "unavailable" : "not_configured") : "unlinked",
    items: [], nextCursor: null,
  };
  if (lead.leadId && c.chatHistory) {
    try {
      conversationHistory = {
        state: "available",
        ...await readSupabaseConversationPage(lead.leadId, undefined, 50),
      };
    } catch {
      conversationHistory = { state: "unavailable", items: [], nextCursor: null };
    }
  }
  const capabilities = { ...c, chatHistory: conversationHistory.state === "available" };
  const warnings = schemaWarnings({ ...c, chatHistory: conversationHistory.state !== "not_configured" });
  if (conversationHistory.state === "unavailable") warnings.push("Supabase conversation history could not be reached; Replit remains the operational database.");
  return {lead,inquiries:submissions,journey,activities:timeline,capabilities,warnings,conversationHistory,marketing};
}

export async function readCrmConversationPage(
  db: SqlDb,
  id: string,
  cursor: string | undefined,
  limit: number,
) {
  const c = await inspectCrmSchema(db);
  const row = await findPerson(db, c, id);
  const lead = leadDto(row);
  if (!lead.leadId) return { state: "unlinked" as const, items: [], nextCursor: null };
  if (!c.chatHistory) return { state: "not_configured" as const, items: [], nextCursor: null };
  try {
    return { state: "available" as const, ...await readSupabaseConversationPage(lead.leadId, cursor, limit) };
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_conversation_cursor") {
      throw new CrmError(400, "Conversation history cursor is invalid.");
    }
    throw new CrmError(503, "Supabase conversation history is unavailable.");
  }
}
