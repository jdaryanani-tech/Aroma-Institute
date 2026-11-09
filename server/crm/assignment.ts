import { z } from "zod";
import type { Pool } from "pg";
import type { CrmPrincipal } from "./authorization";
import { crmAccessLevel, recordCrmDeniedAttempt } from "./authorization";
import { CrmError } from "./evidence";

export const crmAssignmentUpdateSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  assigneeUserId: z.number().int().positive().nullable(),
  reason: z.string().trim().min(3).max(1000),
  requestId: z.string().uuid(),
}).strict();

export type CrmAssignmentUpdate = z.infer<typeof crmAssignmentUpdateSchema>;
type AssignmentRow = {
  lead_id: string;
  assignee_user_id: number | null;
  assigned_by: number;
  updated_at: Date | string;
  version: number;
};
type HistoryRow = {
  id: string;
  lead_id: string;
  previous_assignee_user_id: number | null;
  new_assignee_user_id: number | null;
  actor_user_id: number;
  changed_at: Date | string;
  reason: string;
  source: string;
  request_id: string;
  assignment_version: number;
};

function sameRequest(event: HistoryRow, leadId: string, input: CrmAssignmentUpdate, actorId: number) {
  return event.lead_id === leadId && event.actor_user_id === actorId
    && event.new_assignee_user_id === input.assigneeUserId && event.reason === input.reason;
}

export async function assignCrmLead(
  pool: Pick<Pool, "connect" | "query">,
  leadId: string,
  input: CrmAssignmentUpdate,
  principal: CrmPrincipal,
) {
  if (crmAccessLevel(principal) !== "admin") {
    await recordCrmDeniedAttempt(pool, principal, "assignment_write");
    throw new CrmError(403, "Only administrators can manage CRM assignments.");
  }

  const db = await pool.connect();
  let inTransaction = false;
  let deniedAction: string | null = null;
  try {
    await db.query("BEGIN");
    inTransaction = true;
    const { rows: [priorRequest] } = await db.query<HistoryRow>(
      `SELECT * FROM admissions_lead_assignment_history WHERE request_id=$1`,
      [input.requestId],
    );
    if (priorRequest) {
      if (!sameRequest(priorRequest, leadId, input, principal.id)) {
        throw new CrmError(409, "This request ID was already used for a different assignment.");
      }
      await db.query("COMMIT");
      inTransaction = false;
      return {
        leadId,
        assigneeUserId: priorRequest.new_assignee_user_id,
        version: priorRequest.assignment_version,
        requestId: priorRequest.request_id,
        changedAt: new Date(priorRequest.changed_at).toISOString(),
        replayed: true,
      };
    }

    const { rows: [actor] } = await db.query(
      `SELECT 1 FROM lms_users u JOIN lms_user_roles r ON r.user_id=u.id
       WHERE u.id=$1 AND u.is_active AND r.role::text='admin' FOR SHARE OF u,r`,
      [principal.id],
    );
    if (!actor) {
      deniedAction = "assignment_actor_no_longer_admin";
      throw new CrmError(403, "Administrator access is required.");
    }

    const { rows: [lead] } = await db.query(
      `SELECT id FROM admissions_leads WHERE id=$1 FOR UPDATE`,
      [leadId],
    );
    if (!lead) throw new CrmError(404, "Lead not found.");

    const { rows: [current] } = await db.query<AssignmentRow>(
      `SELECT * FROM admissions_lead_assignments WHERE lead_id=$1 FOR UPDATE`,
      [leadId],
    );
    const version = current?.version ?? 0;
    if (version !== input.expectedVersion) {
      throw new CrmError(409, "The assignment changed. Refresh before trying again.");
    }
    if ((current?.assignee_user_id ?? null) === input.assigneeUserId) {
      throw new CrmError(400, "Choose a different assignee or assignment state.");
    }

    if (input.assigneeUserId !== null) {
      const { rows: [target] } = await db.query(
        `SELECT 1 FROM lms_users u JOIN lms_user_roles r ON r.user_id=u.id
         WHERE u.id=$1 AND u.is_active AND r.role::text='admissions'
           AND NOT EXISTS(SELECT 1 FROM lms_user_roles ar WHERE ar.user_id=u.id AND ar.role::text='admin')
         FOR SHARE OF u,r`,
        [input.assigneeUserId],
      );
      if (!target) {
        deniedAction = "assignment_target_not_active_admissions";
        throw new CrmError(403, "The assignee must be an active admissions user.");
      }
    }

    const nextVersion = version + 1;
    if (current) {
      const result = await db.query(
        `UPDATE admissions_lead_assignments
         SET assignee_user_id=$2,assigned_by=$3,updated_at=now(),version=version+1
         WHERE lead_id=$1 AND version=$4`,
        [leadId, input.assigneeUserId, principal.id, version],
      );
      if (result.rowCount !== 1) throw new CrmError(409, "The assignment changed. Refresh before trying again.");
    } else {
      if (input.expectedVersion !== 0) throw new CrmError(409, "The assignment changed. Refresh before trying again.");
      await db.query(
        `INSERT INTO admissions_lead_assignments(lead_id,assignee_user_id,assigned_by,version)
         VALUES($1,$2,$3,1)`,
        [leadId, input.assigneeUserId, principal.id],
      );
    }

    const { rows: [event] } = await db.query<HistoryRow>(
      `INSERT INTO admissions_lead_assignment_history(
         lead_id,previous_assignee_user_id,new_assignee_user_id,actor_user_id,
         reason,source,request_id,assignment_version
       ) VALUES($1,$2,$3,$4,$5,'admin_ui',$6,$7)
       RETURNING *`,
      [leadId, current?.assignee_user_id ?? null, input.assigneeUserId, principal.id,
        input.reason, input.requestId, nextVersion],
    );
    await db.query("COMMIT");
    inTransaction = false;
    return {
      leadId,
      assigneeUserId: input.assigneeUserId,
      version: nextVersion,
      requestId: event.request_id,
      changedAt: new Date(event.changed_at).toISOString(),
      replayed: false,
    };
  } catch (error) {
    if (inTransaction) {
      try { await db.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      inTransaction = false;
    }
    if (deniedAction) await recordCrmDeniedAttempt(db, principal, deniedAction);
    if (error instanceof Error && (error as { code?: string }).code === "23505") {
      throw new CrmError(409, "This request ID was already used.");
    }
    throw error;
  } finally {
    db.release();
  }
}
