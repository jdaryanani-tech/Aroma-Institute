export type CrmPreApplyRoleGate = {
  status: "ready" | "blocked";
  reason: string | null;
};

/**
 * Keep the pre-apply decision immediately in front of the callback that may
 * create the migration ledger or execute migration SQL.
 */
export async function runAfterCrmPreApplyRoleGate<T>(
  inspect: () => Promise<CrmPreApplyRoleGate>,
  apply: () => Promise<T>,
): Promise<T> {
  const gate = await inspect();
  if (gate.status !== "ready") {
    throw new Error(gate.reason ?? "CRM_FORWARD_APP_ROLE_PRECONDITION_FAILED");
  }
  return apply();
}
