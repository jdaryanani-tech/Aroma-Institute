import type { Pool } from "pg";
import {
  applicationRuntimeFailureCode,
  applicationDatabaseEndpointsMatch,
  resolveApplicationRuntimeMode,
  verifyApplicationPreMigrationPool,
  type ApplicationRuntimeMode,
} from "./application-runtime-connection";
import type { CrmForwardDatabaseIdentity } from "./crm-forward-migration-guard";
import type { CrmPreApplyRoleGate } from "./crm-forward-apply-gate";

type CandidatePool = Pick<Pool, "query"> & Pick<Pool, "end">;
type CandidatePoolFactory = (
  mode: Extract<ApplicationRuntimeMode, { kind: "least_privilege" }>,
) => CandidatePool | Promise<CandidatePool>;

export async function inspectApplicationPreMigrationRoleGate(
  environment: Record<string, string | undefined>,
  target: CrmForwardDatabaseIdentity,
  operatorConnectionUrl: string,
  createPool: CandidatePoolFactory,
): Promise<CrmPreApplyRoleGate> {
  if (environment.AICHM_APP_DATABASE_URL === undefined) {
    return { status: "blocked", reason: "APP_DATABASE_URL_NOT_CONFIGURED" };
  }

  let candidatePool: CandidatePool | undefined;
  try {
    const mode = resolveApplicationRuntimeMode(environment);
    if (
      mode.kind !== "least_privilege" ||
      mode.expectedDatabase !== target.databaseName ||
      !applicationDatabaseEndpointsMatch(mode.connectionString, operatorConnectionUrl)
    ) {
      return { status: "blocked", reason: "APP_DATABASE_TARGET_MISMATCH" };
    }
    candidatePool = await createPool(mode);
    await verifyApplicationPreMigrationPool(candidatePool, {
      databaseName: target.databaseName,
      databaseOid: target.databaseOid,
    });
    return { status: "ready", reason: null };
  } catch (error) {
    return {
      status: "blocked",
      reason: applicationRuntimeFailureCode(error) ?? "APP_DATABASE_PREMIGRATION_ROLE_CHECK_FAILED",
    };
  } finally {
    if (candidatePool) await candidatePool.end().catch(() => undefined);
  }
}
