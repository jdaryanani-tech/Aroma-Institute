import type { CrmDetail, CrmUpdate } from "@shared/crm";
import type { Pool, PoolClient } from "pg";
import { CrmError, validateStageEvidence } from "./evidence";
import { CrmLeadScopeDeniedError, findPerson, detailCrm } from "./read";
import { inspectCrmSchema, leadDto } from "./model";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import {
  crmAccessLevel,
  recordCrmDeniedAttempt,
  requireCrmAccess,
  validateAdmissionsUpdate,
  type CrmPrincipal,
} from "./authorization";

export type CrmAutomationWrite = {
  eventHash: string;
  action: "pause" | "delivery";
  expectedFollowUpAt?: string;
  followUpKind?: "pause_checkin" | "routine";
};

async function updateCrmTransaction(
  pool: Pick<Pool,"connect" | "query">,
  id:string,
  update:CrmUpdate,
  principal:CrmPrincipal,
  automation?: CrmAutomationWrite,
):Promise<{ detail: CrmDetail; replayed: boolean }> {
  const access = requireCrmAccess(principal);
  const db: PoolClient = await pool.connect();
  let released = false;
  let deniedAuditAction: string | undefined;
  try {
    await db.query("BEGIN");
    const c = await inspectCrmSchema(db);
    if(!c.crmPersistence) throw new CrmError(503,"CRM migration is pending. No changes were saved.");
    const beforeLock = await findPerson(db,c,id,principal,{auditDeniedAttempt:false});
    const lockKey = normalizeIndianMobile(beforeLock.phone) || beforeLock.id;
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[lockKey]);
    const row = await findPerson(db,c,id,principal,{auditDeniedAttempt:false}), lead=leadDto(row);
    if (automation) {
      const { rows: [existing] } = await db.query(
        `SELECT id FROM admissions_crm_activities
         WHERE inquiry_id=ANY($1::integer[]) AND data->>'automationEventHash'=$2 LIMIT 1`,
        [row.inquiry_ids, automation.eventHash],
      );
      if (existing) {
        const result = await detailCrm(db,row.id,principal);
        await db.query("COMMIT");
        return { detail: result, replayed: true };
      }
    }
    if(lead.version!==update.expectedVersion) throw new CrmError(409,"This lead changed since you opened it. Refresh and review before saving.");
    let pauseEventHash: string | null = null;
    if (automation?.action === "pause" && ["lost", "enrolled"].includes(lead.stage)) {
      throw new CrmError(409,"Terminal CRM stages cannot be reopened by AVNI.");
    }
    if (automation?.action === "delivery") {
      if (!automation.followUpKind || !automation.expectedFollowUpAt ||
          !lead.followUpAt ||
          new Date(lead.followUpAt).getTime() !== new Date(automation.expectedFollowUpAt).getTime() ||
          new Date(lead.followUpAt).getTime() > Date.now() ||
          ["lost", "enrolled"].includes(lead.stage)) {
        throw new CrmError(409,"The due follow-up changed or is no longer eligible.");
      }
      const { rows: [pause] } = await db.query(
        `SELECT data->>'automationEventHash' AS event_hash, occurred_at
         FROM admissions_crm_activities
         WHERE inquiry_id=ANY($1::integer[]) AND data->>'automationAction'='pause'
         ORDER BY occurred_at DESC,id DESC LIMIT 1`,
        [row.inquiry_ids],
      );
      if (pause?.event_hash && lead.stage === "nurture") {
        const { rows: [state] } = await db.query(
          `SELECT
             EXISTS(SELECT 1 FROM admissions_crm_activities
               WHERE inquiry_id=ANY($1::integer[]) AND data->>'automationAction'='delivery'
                 AND data->>'automationFollowUpKind'='pause_checkin'
                 AND data->>'pauseEventHash'=$2) AS delivered,
             EXISTS(SELECT 1 FROM admissions_crm_activities
               WHERE inquiry_id=ANY($1::integer[]) AND occurred_at>$3
                 AND data->>'automationAction' IS NULL
                 AND (type='followup' OR (type='stage' AND data->>'to'<>'nurture'))) AS reengaged`,
          [row.inquiry_ids, pause.event_hash, pause.occurred_at],
        );
        const pauseCheckInPending = !state?.delivered && !state?.reengaged;
        if ((automation.followUpKind === "pause_checkin") !== pauseCheckInPending) {
          throw new CrmError(409,"The follow-up workflow changed; refresh the due list before retrying.");
        }
        if (pauseCheckInPending) pauseEventHash = pause.event_hash;
      } else if (automation.followUpKind === "pause_checkin") {
        throw new CrmError(409,"The one-time pause check-in is no longer pending.");
      }
    }
    if (access === "admissions") {
      if (!c.canonicalAssignments) throw new CrmError(503, "Canonical CRM assignments are unavailable.");
      const forbidden = validateAdmissionsUpdate(update);
      if (forbidden) {
        deniedAuditAction = `stage_${forbidden}`;
        throw new CrmError(403, "Admissions users cannot change this CRM stage.");
      }
    }
    validateStageEvidence(lead,update);
    if(!update.note && !automation && (!update.stage || update.stage===lead.stage) &&
        (update.followUpAt===undefined || update.followUpAt===lead.followUpAt))
      throw new CrmError(400,"No changes to save.");
    const anchor = row.profile_anchor ?? row.inquiry_ids[0];
    const stage = update.stage && update.stage!==lead.stage
      ? update.stage : (lead.stageSource==="admin" ? lead.stage : null);
    let evidence: Record<string,unknown> | null = update.stage && update.stage!==lead.stage
      ? {...update.evidence,reason:update.reason,recordedBy:principal.id,selfReported:update.evidence?.kind==="prospect_confirmation"}
      : lead.stageEvidence;
    if(update.stage==="form_submitted" && update.stage!==lead.stage) {
      const {rows:forms}=await db.query(`SELECT id FROM inquiries WHERE id=ANY($1::integer[])
        AND counselling_answers IS NOT NULL AND counselling_submitted_at IS NOT NULL`,[row.inquiry_ids]);
      evidence={...evidence,verifiedInquiryIds:forms.map(f=>f.id)};
    }
    if(update.stage==="vsl_watched" && update.evidence?.kind==="tracked_video")
      evidence={...evidence,verifiedLeadId:lead.leadId,milestone:lead.lastVideoMilestone,completed:lead.videoCompleted};
    const followUpAt = update.followUpAt===undefined ? lead.followUpAt : update.followUpAt;
    const automationData = automation ? {
      automationEventHash: automation.eventHash,
      automationAction: automation.action,
      automationFollowUpKind: automation.action === "pause"
        ? "pause_checkin"
        : automation.followUpKind,
      ...(pauseEventHash ? { pauseEventHash } : {}),
    } : {};
    // A metadata-only edit must not freeze a derived system stage or pretend an admin chose it.
    // The old per-inquiry owner_id is intentionally left untouched and is not used for authorization.
    await db.query(`INSERT INTO admissions_crm_profiles(inquiry_id,stage,stage_evidence,follow_up_at,updated_by,version)
      VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(inquiry_id) DO UPDATE SET stage=EXCLUDED.stage,
      stage_evidence=EXCLUDED.stage_evidence,follow_up_at=EXCLUDED.follow_up_at,
      updated_by=EXCLUDED.updated_by,updated_at=now(),version=admissions_crm_profiles.version+1`,
      [anchor,stage,evidence ? JSON.stringify(evidence) : null,followUpAt,principal.id]);
    const audit = async(type:string,body:string|null,data:Record<string,unknown>) =>
      db.query("INSERT INTO admissions_crm_activities(inquiry_id,type,actor_id,body,data) VALUES($1,$2,$3,$4,$5)",[anchor,type,principal.id,body,JSON.stringify(data)]);
    if(update.stage && update.stage!==lead.stage) await audit("stage",update.reason!,{from:lead.stage,to:stage,evidence,...automationData});
    else if(automation?.action==="pause" && update.reason) await audit("note",update.reason,automationData);
    if(update.followUpAt!==undefined && update.followUpAt!==lead.followUpAt) await audit("followup",null,{from:lead.followUpAt,to:followUpAt,...automationData});
    if(update.note) await audit("note",update.note,{});
    const result=await detailCrm(db,row.id,principal);
    await db.query("COMMIT");
    return { detail: result, replayed: false };
  } catch(error) {
    let rollbackError: Error | undefined;
    try {
      await db.query("ROLLBACK");
    } catch (failure) {
      rollbackError = failure instanceof Error ? failure : new Error("CRM update rollback failed");
    }

    const auditAction = error instanceof CrmLeadScopeDeniedError ? "lead_update" : deniedAuditAction;
    if (auditAction || rollbackError) {
      // Release the rolled-back transaction first so the audit write obtains a
      // separate pool connection and cannot be rolled back with the denied edit.
      db.release(rollbackError);
      released = true;
      if (auditAction) await recordCrmDeniedAttempt(pool, principal, auditAction);
    }
    throw error;
  } finally {
    if (!released) db.release();
  }
}

export async function updateCrm(
  pool: Pick<Pool,"connect" | "query">,
  id:string,
  update:CrmUpdate,
  principal:CrmPrincipal,
):Promise<CrmDetail> {
  return (await updateCrmTransaction(pool,id,update,principal)).detail;
}

export async function updateCrmAutomated(
  pool: Pick<Pool,"connect" | "query">,
  id:string,
  update:CrmUpdate,
  principal:CrmPrincipal,
  automation: CrmAutomationWrite,
):Promise<{ detail: CrmDetail; replayed: boolean }> {
  return updateCrmTransaction(pool,id,update,principal,automation);
}
