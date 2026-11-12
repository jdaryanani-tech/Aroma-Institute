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
  result_lead_id: string;
  result_assignee_user_id: number | null;
  result_version: number;
  result_request_id: string;
  result_changed_at: Date | string;
  result_replayed: boolean;
};

export function mapCrmAssignmentDatabaseError(error: unknown): CrmError | null {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "42501") return new CrmError(403, "The assignment request is not authorized.");
  if (code === "P0002") return new CrmError(404, "Lead not found.");
  if (code === "P0003" || code === "23505") {
    return new CrmError(409, "The assignment changed or this request ID was already used.");
  }
  if (code === "P0004") return new CrmError(400, "Choose a different assignee or assignment state.");
  if (code === "22023") return new CrmError(400, "Invalid assignment request.");
  return null;
}

export async function assignCrmLead(
  pool: Pick<Pool, "query">,
  leadId: string,
  input: CrmAssignmentUpdate,
  principal: CrmPrincipal,
) {
  if (crmAccessLevel(principal) !== "admin") {
    await recordCrmDeniedAttempt(pool, principal, "assignment_write");
    throw new CrmError(403, "Only administrators can manage CRM assignments.");
  }

  try {
    const { rows: [result] } = await pool.query<AssignmentRow>(
      `SELECT * FROM public.aichm_assign_crm_lead(
        $1::uuid,$2::integer,$3::integer,$4::text,$5::uuid,$6::integer
      )`,
      [leadId, principal.id, input.assigneeUserId, input.reason, input.requestId, input.expectedVersion],
    );
    if (!result) throw new Error("CRM_ASSIGNMENT_FUNCTION_RETURNED_NO_RESULT");
    return {
      leadId: result.result_lead_id,
      assigneeUserId: result.result_assignee_user_id,
      version: result.result_version,
      requestId: result.result_request_id,
      changedAt: new Date(result.result_changed_at).toISOString(),
      replayed: result.result_replayed,
    };
  } catch (error) {
    const mapped = mapCrmAssignmentDatabaseError(error);
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "42501") {
      await recordCrmDeniedAttempt(pool, principal, "assignment_actor_or_target_rejected");
    }
    if (mapped) throw mapped;
    throw error;
  }
}
