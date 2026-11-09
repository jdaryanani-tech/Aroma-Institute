import { ADMISSIONS_MANUAL_CRM_STAGES, type CrmStage, type CrmUpdate } from "@shared/crm";
import { CrmError } from "./evidence";
import type { SqlDb } from "./model";

export type CrmPrincipal = {
  id: number;
  roles: readonly string[];
};

export type CrmAccessLevel = "admin" | "admissions" | "denied";

export const ADMISSIONS_MANUAL_STAGES = new Set<CrmStage>(ADMISSIONS_MANUAL_CRM_STAGES);

export function crmAccessLevel(principal: CrmPrincipal | null | undefined): CrmAccessLevel {
  if (!principal) return "denied";
  if (principal.roles.includes("admin")) return "admin";
  if (principal.roles.includes("admissions")) return "admissions";
  return "denied";
}

export function canReadCanonicalLead(
  principal: CrmPrincipal,
  leadId: string | null,
  assigneeUserId: number | null,
): boolean {
  const level = crmAccessLevel(principal);
  if (level === "admin") return true;
  return level === "admissions" && leadId !== null && assigneeUserId === principal.id;
}

export function validateAdmissionsUpdate(update: CrmUpdate): string | null {
  if (update.stage !== undefined && !ADMISSIONS_MANUAL_STAGES.has(update.stage)) {
    return "stage_not_permitted";
  }
  return null;
}

export async function recordCrmDeniedAttempt(
  db: SqlDb,
  principal: CrmPrincipal | null | undefined,
  action: string,
): Promise<void> {
  if (!principal) return;
  try {
    await db.query(
      `INSERT INTO lms_audit_logs(actor_id,action,entity_type,metadata)
       VALUES($1,'crm.authorization.denied','crm_authorization',$2::jsonb)`,
      [principal.id, JSON.stringify({
        action: action.slice(0, 80),
        roles: principal.roles.filter(role =>
          ["admin", "admissions", "trainer", "student", "academic_coordinator", "operations"].includes(role),
        ),
        outcome: "denied",
      })],
    );
  } catch {
    // Authorization remains denied if the audit sink is unavailable.
  }
}

export function requireCrmAccess(principal: CrmPrincipal | null | undefined): CrmAccessLevel {
  const level = crmAccessLevel(principal);
  if (level === "denied") throw new CrmError(principal ? 403 : 401, "CRM access denied.");
  return level;
}
