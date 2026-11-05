import type { CrmDetail, CrmUpdate } from "@shared/crm";
import type { Pool, PoolClient } from "pg";
import { CrmError, validateStageEvidence } from "./evidence";
import { findPerson, detailCrm } from "./read";
import { inspectCrmSchema, leadDto } from "./model";
import { normalizeIndianMobile } from "@shared/indian-mobile";

export async function updateCrm(pool: Pick<Pool,"connect">, id:string, update:CrmUpdate, actorId:number):Promise<CrmDetail> {
  const db: PoolClient = await pool.connect();
  try {
    await db.query("BEGIN");
    const c = await inspectCrmSchema(db);
    if(!c.crmPersistence) throw new CrmError(503,"CRM migration is pending. No changes were saved.");
    const beforeLock = await findPerson(db,c,id);
    const lockKey = normalizeIndianMobile(beforeLock.phone) || beforeLock.id;
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[lockKey]);
    const row = await findPerson(db,c,id), lead=leadDto(row);
    if(lead.version!==update.expectedVersion) throw new CrmError(409,"This lead changed since you opened it. Refresh and review before saving.");
    validateStageEvidence(lead,update);
    if(!update.note && (!update.stage || update.stage===lead.stage) &&
        (update.ownerId===undefined || update.ownerId===lead.ownerId) &&
        (update.followUpAt===undefined || update.followUpAt===lead.followUpAt))
      throw new CrmError(400,"No changes to save.");
    if(update.ownerId!==undefined && update.ownerId!==null) {
      const {rows:[owner]} = await db.query(`SELECT u.id FROM lms_users u JOIN lms_user_roles r ON r.user_id=u.id
        WHERE u.id=$1 AND u.is_active AND r.role='admin'`,[update.ownerId]);
      if(!owner) throw new CrmError(400,"Owner must be an active administrator.");
    }
    const anchor = row.profile_anchor ?? row.inquiry_ids[0];
    const stage = update.stage && update.stage!==lead.stage
      ? update.stage : (lead.stageSource==="admin" ? lead.stage : null);
    let evidence: Record<string,unknown> | null = update.stage && update.stage!==lead.stage
      ? {...update.evidence,reason:update.reason,recordedBy:actorId,selfReported:update.evidence?.kind==="prospect_confirmation"}
      : lead.stageEvidence;
    if(update.stage==="form_submitted" && update.stage!==lead.stage) {
      const {rows:forms}=await db.query(`SELECT id FROM inquiries WHERE id=ANY($1::integer[])
        AND counselling_answers IS NOT NULL AND counselling_submitted_at IS NOT NULL`,[row.inquiry_ids]);
      evidence={...evidence,verifiedInquiryIds:forms.map(f=>f.id)};
    }
    if(update.stage==="vsl_watched" && update.evidence?.kind==="tracked_video")
      evidence={...evidence,verifiedLeadId:lead.leadId,milestone:lead.lastVideoMilestone,completed:lead.videoCompleted};
    const ownerId = update.ownerId===undefined ? lead.ownerId : update.ownerId;
    const followUpAt = update.followUpAt===undefined ? lead.followUpAt : update.followUpAt;
    // A metadata-only edit must not freeze a derived system stage or pretend an admin chose it.
    await db.query(`INSERT INTO admissions_crm_profiles(inquiry_id,stage,stage_evidence,owner_id,follow_up_at,updated_by,version)
      VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(inquiry_id) DO UPDATE SET stage=EXCLUDED.stage,
      stage_evidence=EXCLUDED.stage_evidence,owner_id=EXCLUDED.owner_id,follow_up_at=EXCLUDED.follow_up_at,
      updated_by=EXCLUDED.updated_by,updated_at=now(),version=admissions_crm_profiles.version+1`,
      [anchor,stage,evidence ? JSON.stringify(evidence) : null,ownerId,followUpAt,actorId]);
    const audit = async(type:string,body:string|null,data:Record<string,unknown>) =>
      db.query("INSERT INTO admissions_crm_activities(inquiry_id,type,actor_id,body,data) VALUES($1,$2,$3,$4,$5)",[anchor,type,actorId,body,JSON.stringify(data)]);
    if(update.stage && update.stage!==lead.stage) await audit("stage",update.reason!,{from:lead.stage,to:stage,evidence});
    if(update.ownerId!==undefined && update.ownerId!==lead.ownerId) await audit("owner",null,{from:lead.ownerId,to:ownerId});
    if(update.followUpAt!==undefined && update.followUpAt!==lead.followUpAt) await audit("followup",null,{from:lead.followUpAt,to:followUpAt});
    if(update.note) await audit("note",update.note,{});
    const result=await detailCrm(db,row.id);
    await db.query("COMMIT");
    return result;
  } catch(error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
