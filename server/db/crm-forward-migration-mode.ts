export const CRM_FORWARD_APPLY_FLAG = "--apply-crm-migrations";
export const CRM_FORWARD_APPLY_CONFIRM_ENV = "AICHM_CRM_FORWARD_APPLY_CONFIRM";
export const CRM_FORWARD_APPLY_CONFIRM_VALUE = "APPLY_CRM_FORWARD_MIGRATIONS_TO_PINNED_DEVELOPMENT";
export const CRM_FORWARD_APP_PREFLIGHT_FLAG = "--preflight-app-role";

export type CrmForwardMigrationMode = "preview" | "apply" | "preflight-app-role";

export function parseCrmForwardMigrationMode(
  args: string[],
  environment: Record<string, string | undefined>,
): CrmForwardMigrationMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview")) return "preview";
  if (args.length === 1 && args[0] === CRM_FORWARD_APP_PREFLIGHT_FLAG) return "preflight-app-role";
  if (
    args.length === 1 &&
    args[0] === CRM_FORWARD_APPLY_FLAG &&
    environment[CRM_FORWARD_APPLY_CONFIRM_ENV] === CRM_FORWARD_APPLY_CONFIRM_VALUE
  ) return "apply";
  if (args.length === 1 && args[0] === CRM_FORWARD_APPLY_FLAG) {
    throw new Error("CRM_FORWARD_EXPLICIT_APPLY_CONFIRMATION_REQUIRED");
  }
  throw new Error("CRM_FORWARD_ARGUMENTS_REJECTED");
}
