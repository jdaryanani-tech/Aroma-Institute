import { CRM_STAGES, type CrmActivity, type CrmDetail, type CrmFilters, type CrmList, type CrmOverview } from "@shared/crm";
import { crmModelSql, inspectCrmSchema, iso, leadDto, schemaWarnings, type CrmSchema, type SqlDb } from "./model";
import { CrmError } from "./evidence";

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
  const [{ rows: inquiries }, { rows: attempts }, { rows: activities }, { rows: events }] = await Promise.all([
    db.query("SELECT to_jsonb(i) data FROM inquiries i WHERE id=ANY($1::integer[]) ORDER BY id DESC", [ids]),
    c.deliveryAttempts ? db.query("SELECT * FROM counselling_delivery_attempts WHERE inquiry_id=ANY($1::integer[]) ORDER BY attempted_at", [ids]) : Promise.resolve({rows:[]}),
    c.crmPersistence ? db.query(`SELECT a.*,coalesce(u.display_name,'Admin #'||a.actor_id) actor_name
      FROM admissions_crm_activities a JOIN lms_users u ON u.id=a.actor_id
      WHERE inquiry_id=ANY($1::integer[]) ORDER BY occurred_at,id`, [ids]) : Promise.resolve({rows:[]}),
    c.videoTracking && lead.leadId ? db.query("SELECT * FROM admissions_vsl_events WHERE lead_id=$1 ORDER BY occurred_at,event", [lead.leadId]) : Promise.resolve({rows:[]}),
  ]);
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
  return {lead,inquiries:submissions,journey,activities:timeline,capabilities:c,warnings:schemaWarnings(c)};
}
