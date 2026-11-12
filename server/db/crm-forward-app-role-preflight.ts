import type { Pool, PoolClient } from "pg";
import {
  applicationPreMigrationFailureDiagnosticFromError,
  applicationPreMigrationRoleChecksFromError,
  applicationRuntimeFailureCode,
  applicationDatabaseEndpointsMatch,
  APPLICATION_PRE_MIGRATION_STAGE_CODES,
  classifyApplicationPreMigrationSqlError,
  emptyApplicationPreMigrationRoleChecks,
  resolveApplicationRuntimeMode,
  verifyApplicationPreMigrationPool,
  type ApplicationPreMigrationDiagnostics,
  type ApplicationPreMigrationStageCode,
  type ApplicationRuntimeMode,
} from "./application-runtime-connection";
import {
  CRM_FORWARD_DEVELOPMENT_IDENTITY,
  type CrmForwardDatabaseIdentity,
} from "./crm-forward-migration-guard";
import type { CrmPreApplyRoleGate } from "./crm-forward-apply-gate";

type CandidatePool = Pick<Pool, "connect"> & Pick<Pool, "end">;
type CandidateClient = Pick<PoolClient, "query"> & Pick<PoolClient, "release">;
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
  let candidateClient: CandidateClient | undefined;
  let candidateStage: ApplicationPreMigrationStageCode =
    APPLICATION_PRE_MIGRATION_STAGE_CODES.candidatePoolConnection;
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

    try {
      candidatePool = await createPool(mode);
      candidateStage = APPLICATION_PRE_MIGRATION_STAGE_CODES.candidatePoolConnection;
      candidateClient = await candidatePool.connect();
      const roleChecks = await verifyApplicationPreMigrationPool(
        candidateClient,
        {
          databaseName: target.databaseName,
          databaseOid: target.databaseOid,
        },
        { setStage: stage => { candidateStage = stage; } },
      );
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
        reason: applicationRuntimeFailureCode(error) ?? "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE",
        diagnostics,
        failureDiagnostic:
          applicationPreMigrationFailureDiagnosticFromError(error) ?? {
            stageCode: candidateStage,
            categoryCode: classifyApplicationPreMigrationSqlError(error),
          },
      };
    }
  } catch (error) {
    return {
      status: "blocked",
      reason: applicationRuntimeFailureCode(error) ?? "APP_DATABASE_PREMIGRATION_ROLE_CHECK_FAILED",
      diagnostics,
    };
  } finally {
    try {
      candidateClient?.release();
    } catch {
      // Cleanup errors must not replace the sanitized preflight result.
    }
    if (candidatePool) await candidatePool.end().catch(() => undefined);
  }
}
