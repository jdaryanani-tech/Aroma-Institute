import { ADMISSIONS_MANUAL_CRM_STAGES, type CrmStage } from "@shared/crm";

export type CrmUiPermissions = {
  canUseCrm: boolean;
  canManageAssignments: boolean;
  canSeeGlobalDiagnostics: boolean;
  canRetryDelivery: boolean;
  canSeeAssigneeControls: boolean;
  manualStages: readonly CrmStage[] | null;
};

export function crmUiPermissions(roles: readonly string[] | undefined): CrmUiPermissions {
  const isAdmin = Boolean(roles?.includes("admin"));
  const isAdmissions = !isAdmin && Boolean(roles?.includes("admissions"));
  return {
    canUseCrm: isAdmin || isAdmissions,
    canManageAssignments: isAdmin,
    canSeeGlobalDiagnostics: isAdmin,
    canRetryDelivery: isAdmin,
    canSeeAssigneeControls: isAdmin,
    manualStages: isAdmin ? null : isAdmissions ? ADMISSIONS_MANUAL_CRM_STAGES : [],
  };
}
