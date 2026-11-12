import type { Pool } from "pg";
import {
  applicationPreMigrationRoleChecksFromError,
  applicationRuntimeFailureCode,
  applicationDatabaseEndpointsMatch,
  emptyApplicationPreMigrationRoleChecks,
  resolveApplicationRuntimeMode,
  verifyApplicationPreMigrationPool,
  type ApplicationPreMigrationDiagnostics,
  type ApplicationRuntimeMode,
} from "./application-runtime-connection";
import {
  CRM_FORWARD_DEVELOPMENT_IDENTITY,
  type CrmForwardDatabaseIdentity,
} from "./crm-forward-migration-guard";
import type { CrmPreApplyRoleGate } from "./crm-forward-apply-gate";

type CandidatePool = Pick<Pool, "query"> & Pick<Pool, "end">;
type CandidatePoolFactory = (
  mode: Extract<ApplicationRuntimeMode, { kind: "least_privilege" }>,
) => CandidatePool | Promise<CandidatePool>;

function isPinnedDevelopmentIdentity(target: CrmForwardDatabaseIdentity): boolean {
  return target.databaseName === CRM_FORWARD_DEVELOPMENT_IDENTITY.databaseName &&
    target.databaseOid === CRM_FORWARD_DEVELOPMENT_IDENTITY.databaseOid &&
    target.databaseUser === CRM_FORWARD_DEVELOPMENT_IDENTITY.databaseUser &&
    target.systemIdentifier === CRM_FORWARD_DEVELOPMENT_IDENTITY.systemIdentifier &&
    target.inRecovery === false &&
    target.defaultTransactionReadOnly === false;
}

function initialDiagnostics(
  target: CrmForwardDatabaseIdentity,
): ApplicationPreMigrationDiagnostics {
  return {
    ...emptyApplicationPreMigrationRoleChecks(),
    endpointMatches: false,
    pinnedDevelopmentIdentityMatches: isPinnedDevelopmentIdentity(target),
  };
}

export async function inspectApplicationPreMigrationRoleGate(
  environment: Record<string, string | undefined>,
  target: CrmForwardDatabaseIdentity,
  operatorConnectionUrl: string,
  createPool: CandidatePoolFactory,
): Promise<CrmPreApplyRoleGate> {
  const diagnostics = initialDiagnostics(target);
  if (environment.AICHM_APP_DATABASE_URL === undefined) {
    return {
      status: "blocked",
      reason: "APP_DATABASE_URL_NOT_CONFIGURED",
      diagnostics,
    };
  }

  let candidatePool: CandidatePool | undefined;
  try {
    if (!diagnostics.pinnedDevelopmentIdentityMatches) {
      return {
        status: "blocked",
        reason: "APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH",
        diagnostics,
      };
    }

    const mode = resolveApplicationRuntimeMode(environment);
    if (mode.kind !== "least_privilege") {
      return { status: "blocked", reason: "APP_DATABASE_TARGET_MISMATCH", diagnostics };
    }
    diagnostics.endpointMatches =
      mode.expectedDatabase === target.databaseName &&
      applicationDatabaseEndpointsMatch(mode.connectionString, operatorConnectionUrl);
    if (!diagnostics.endpointMatches) {
      return { status: "blocked", reason: "APP_DATABASE_TARGET_MISMATCH", diagnostics };
    }

    candidatePool = await createPool(mode);
    try {
      const roleChecks = await verifyApplicationPreMigrationPool(candidatePool, {
        databaseName: target.databaseName,
        databaseOid: target.databaseOid,
      });
      Object.assign(diagnostics, roleChecks);
      diagnostics.pinnedDevelopmentIdentityMatches =
        diagnostics.pinnedDevelopmentIdentityMatches &&
        roleChecks.candidateDatabaseIdentityMatches;
      return { status: "ready", reason: null, diagnostics };
    } catch (error) {
      const roleChecks = applicationPreMigrationRoleChecksFromError(error);
      if (roleChecks) {
        Object.assign(diagnostics, roleChecks);
        diagnostics.pinnedDevelopmentIdentityMatches =
          diagnostics.pinnedDevelopmentIdentityMatches &&
          roleChecks.candidateDatabaseIdentityMatches;
      }
      return {
        status: "blocked",
        reason: applicationRuntimeFailureCode(error) ?? "APP_DATABASE_PREMIGRATION_ROLE_CHECK_FAILED",
        diagnostics,
      };
    }
  } catch (error) {
    return {
      status: "blocked",
      reason: applicationRuntimeFailureCode(error) ?? "APP_DATABASE_PREMIGRATION_ROLE_CHECK_FAILED",
      diagnostics,
    };
  } finally {
    if (candidatePool) await candidatePool.end().catch(() => undefined);
  }
}
