import type { CrmCapabilities, CrmLead, CrmStage } from "@shared/crm";
import type { QueryResultRow } from "pg";

export type SqlDb = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };
export type CrmSchema = CrmCapabilities & { deliveryAttempts: boolean };

export async function inspectCrmSchema(db: SqlDb): Promise<CrmSchema> {
  const { rows: [r] } = await db.query(`SELECT
    to_regclass('admissions_leads') IS NOT NULL AS identity,
    to_regclass('admissions_vsl_events') IS NOT NULL AS video,
    to_regclass('admissions_crm_profiles') IS NOT NULL AND to_regclass('admissions_crm_activities') IS NOT NULL AS crm,
    to_regclass('counselling_delivery_attempts') IS NOT NULL AS attempts`);
  return { identityTracking: r.identity, videoTracking: r.identity && r.video,
    crmPersistence: r.crm, deliveryAttempts: r.attempts, calendarBookingVerification: false, chatHistory: false };
}

/** All optional tables are selected only after capability introspection, never via startup DDL. */
export function crmModelSql(c: CrmSchema) {
  const leads = c.identityTracking
    ? `SELECT id,name,canonical_phone,created_at,registered_at,last_registered_at,entry_source,legacy_match_status FROM admissions_leads`
    : `SELECT NULL::uuid id,NULL::text name,NULL::text canonical_phone,NULL::timestamptz created_at,NULL::timestamptz registered_at,NULL::timestamptz last_registered_at,NULL::text entry_source,NULL::text legacy_match_status WHERE false`;
  const video = c.videoTracking
    ? `SELECT lead_id, bool_or(event='completed') completed, bool_or(event='started') started,
        bool_or(event IN ('25','50','75','90','completed')) watched,
        max(occurred_at) last_video_at,
        (array_agg(event ORDER BY CASE WHEN event='completed' THEN 100 WHEN event='started' THEN 0 ELSE event::integer END DESC))[1] milestone
       FROM admissions_vsl_events GROUP BY lead_id`
    : `SELECT NULL::uuid lead_id,false completed,false started,false watched,NULL::timestamptz last_video_at,NULL::text milestone WHERE false`;
  const profiles = c.crmPersistence
    ? `SELECT * FROM admissions_crm_profiles`
    : `SELECT NULL::integer inquiry_id,NULL::text stage,NULL::jsonb stage_evidence,NULL::integer owner_id,
       NULL::timestamptz follow_up_at,NULL::timestamptz updated_at,NULL::integer updated_by,NULL::integer version WHERE false`;
  return `WITH lead_source AS (${leads}), video_source AS (${video}), profile_source AS (${profiles}),
    normalized AS (
      SELECT i.id,i.name,i.email,i.phone,i.program_interest,i.counselling_submitted_at,
        (i.counselling_answers IS NOT NULL AND i.counselling_submitted_at IS NOT NULL) verified_form,
        CASE WHEN i.phone ~ '^\\+?[0-9 ().-]+$' THEN
          CASE WHEN regexp_replace(i.phone,'[^0-9]','','g') ~ '^[6-9][0-9]{9}$' THEN '91'||regexp_replace(i.phone,'[^0-9]','','g')
               WHEN regexp_replace(i.phone,'[^0-9]','','g') ~ '^91[6-9][0-9]{9}$' THEN regexp_replace(i.phone,'[^0-9]','','g') END
        END canonical_phone,
        ${c.identityTracking ? "(to_jsonb(i)->>'lead_id')::uuid" : "NULL::uuid"} actual_lead_id
      FROM inquiries i
    ), phone_stats AS (
      SELECT canonical_phone,count(*) FILTER(WHERE actual_lead_id IS NULL) unlinked_count
      FROM normalized WHERE canonical_phone IS NOT NULL GROUP BY canonical_phone
    ), associated AS (
      SELECT n.*,coalesce(n.actual_lead_id,
        CASE WHEN s.unlinked_count=1 AND l.legacy_match_status<>'ambiguous' THEN l.id END) resolved_lead_id,
        CASE WHEN n.actual_lead_id IS NOT NULL THEN 'linked'
             WHEN n.canonical_phone IS NULL THEN 'unmatchable'
             WHEN s.unlinked_count>1 OR l.legacy_match_status='ambiguous' THEN 'ambiguous'
             ELSE 'unique_phone' END identity_status
      FROM normalized n LEFT JOIN phone_stats s USING(canonical_phone)
      LEFT JOIN lead_source l ON l.canonical_phone=n.canonical_phone
    ), keyed AS (
      SELECT *,CASE WHEN resolved_lead_id IS NOT NULL THEN 'lead:'||resolved_lead_id ELSE 'inquiry:'||id END person_key
      FROM associated
    ), grouped AS (
      SELECT person_key id,max(resolved_lead_id::text) lead_id,array_agg(id ORDER BY id) inquiry_ids,
        (array_agg(name ORDER BY id DESC))[1] name,(array_agg(phone ORDER BY id DESC))[1] phone,
        coalesce((array_agg(email ORDER BY id DESC) FILTER(WHERE email<>''))[1],'') email,
        array_agg(DISTINCT program_interest) programs,
        string_agg(name||' '||phone||' '||coalesce(canonical_phone,'')||' '||email,' ') search_text,
        string_agg(coalesce(canonical_phone,''),' ') phone_search,
        CASE WHEN bool_or(identity_status='ambiguous') THEN 'ambiguous'
             WHEN bool_or(identity_status='linked') THEN 'linked'
             WHEN bool_or(identity_status='unique_phone') THEN 'unique_phone' ELSE 'unmatchable' END identity_status,
        count(*)::integer inquiry_count,bool_or(verified_form) has_verified_form,
        max(counselling_submitted_at) questionnaire_completed_at
      FROM keyed GROUP BY person_key
    ), model AS (
      SELECT g.*,coalesce(l.name,g.name) display_name,
        ARRAY_REMOVE(ARRAY[l.entry_source,CASE WHEN g.has_verified_form THEN 'counselling' ELSE 'website_enquiry' END],NULL) sources,
        coalesce(p.stage,CASE WHEN g.has_verified_form THEN 'form_submitted' WHEN v.watched THEN 'vsl_watched' ELSE 'new_enquiry' END) stage,
        CASE WHEN p.stage IS NOT NULL THEN 'admin' WHEN g.has_verified_form THEN 'verified_form' WHEN v.watched THEN 'verified_video' ELSE 'new' END stage_source,
        p.stage_evidence,p.owner_id,u.display_name owner_name,p.follow_up_at,
        coalesce((SELECT sum(version)::integer FROM profile_source pp WHERE pp.inquiry_id=ANY(g.inquiry_ids)),0) version,
        l.registered_at, greatest(p.updated_at,l.last_registered_at,l.created_at,g.questionnaire_completed_at,v.last_video_at) last_activity_at,
        coalesce(v.completed,false) video_completed,coalesce(v.started,false) video_started,
        coalesce(v.watched,false) video_watched,v.milestone last_video_milestone,
        p.inquiry_id profile_anchor
      FROM grouped g LEFT JOIN lead_source l ON l.id::text=g.lead_id
      LEFT JOIN video_source v ON v.lead_id::text=g.lead_id
      LEFT JOIN LATERAL(SELECT * FROM profile_source pp WHERE pp.inquiry_id=ANY(g.inquiry_ids)
        ORDER BY pp.updated_at DESC,pp.inquiry_id LIMIT 1) p ON true
      LEFT JOIN lms_users u ON u.id=p.owner_id
    )`;
}

export const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;
export function leadDto(r: QueryResultRow): CrmLead {
  return {
    id: r.id, leadId: r.lead_id, name: r.display_name, phone: r.phone, email: r.email,
    programs: r.programs, sources: r.sources, stage: r.stage as CrmStage, stageSource: r.stage_source,
    stageEvidence: r.stage_evidence, identityStatus: r.identity_status, inquiryCount: r.inquiry_count,
    registeredAt: iso(r.registered_at), questionnaireCompletedAt: iso(r.questionnaire_completed_at),
    lastActivityAt: iso(r.last_activity_at), lastVideoMilestone: r.last_video_milestone,
    videoCompleted: r.video_completed, hasVerifiedForm: r.has_verified_form, ownerId: r.owner_id,
    ownerName: r.owner_name, followUpAt: iso(r.follow_up_at), version: r.version,
  };
}
export function schemaWarnings(c: CrmSchema) {
  return [
    ...(!c.crmPersistence ? ["CRM metadata migration is pending. Leads are available read-only; editing is disabled."] : []),
    ...(!c.identityTracking ? ["Lead identity tracking migration is pending; legacy inquiry identities are shown conservatively."] : []),
    ...(!c.videoTracking ? ["Video tracking schema is unavailable; no viewing is inferred."] : []),
    ...(!c.deliveryAttempts ? ["Delivery-attempt audit schema is unavailable. Existing inquiry status is shown without inventing attempt history."] : []),
    "Chat history is not connected. This timeline contains saved inquiries, delivery attempts and recorded activities only.",
    "Verified Cal.com booking integration is not connected; Counselling Booked cannot be set.",
  ];
}
