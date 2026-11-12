import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  crmForwardEffectivePort,
  requireCrmForwardConnectionUrl,
} from "../server/db/crm-forward-migration-guard";
import {
  createCrmAppRoleProvisionError,
  CRM_APP_ROLE_STAGE_CODES,
  formatCrmAppRoleFailureDiagnostic,
  isStrongAlphanumericAppRolePassword,
  parseCrmAppRoleProvisionMode,
  runCrmAppRoleProvisioning,
  selectCrmAppRoleFailure,
  CRM_APP_ROLE_CONFIRM_ENV,
  CRM_APP_ROLE_PASSWORD_ENV,
  type CrmAppRoleStageCode,
  type CrmAppRoleProvisionMode,
} from "../server/db/crm-app-role-provisioning";

function operatorPoolConfig(connectionUrl: string, effectivePort: number) {
  const url = new URL(connectionUrl);
  return {
    host: url.hostname,
    port: effectivePort,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    application_name: "aichm_crm_app_role_provisioner",
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 8_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  };
}

function modeFromArgs(args: string[], environment: Record<string, string | undefined>): CrmAppRoleProvisionMode {
  return parseCrmAppRoleProvisionMode(args, environment);
}

const correlationId = randomUUID();
let lastStageCode: CrmAppRoleStageCode = CRM_APP_ROLE_STAGE_CODES.argumentValidation;

async function run(): Promise<void> {
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  let output: unknown;
  let hasPrimaryFailure = false;
  let primaryFailure: unknown;
  let primaryStageCode: CrmAppRoleStageCode | undefined;
  let hasCleanupFailure = false;
  let cleanupFailure: unknown;
  const setStage = (stage: CrmAppRoleStageCode) => {
    lastStageCode = stage;
  };
  const recordCleanupFailure = (error: unknown) => {
    if (!hasCleanupFailure) {
      cleanupFailure = error;
      hasCleanupFailure = true;
    }
  };

  try {
    setStage(CRM_APP_ROLE_STAGE_CODES.argumentValidation);
    const mode = modeFromArgs(process.argv.slice(2), process.env);
    const password = process.env[CRM_APP_ROLE_PASSWORD_ENV];
    if (mode === "apply") {
      setStage(CRM_APP_ROLE_STAGE_CODES.passwordReadiness);
      if (!isStrongAlphanumericAppRolePassword(password)) {
        throw createCrmAppRoleProvisionError(password
          ? "CRM_APP_ROLE_PASSWORD_FORMAT_REJECTED"
          : "CRM_APP_ROLE_PASSWORD_SECRET_REQUIRED");
      }
    }

    setStage(CRM_APP_ROLE_STAGE_CODES.urlParsing);
    // This guard returns only the dedicated AICHM URL. DATABASE_URL is used
    // only as its existing in-memory endpoint comparison reference.
    const dedicatedUrl = requireCrmForwardConnectionUrl(process.env);
    const effectivePort = crmForwardEffectivePort(new URL(dedicatedUrl));

    setStage(CRM_APP_ROLE_STAGE_CODES.poolCreation);
    pool = new Pool(operatorPoolConfig(dedicatedUrl, effectivePort));

    setStage(CRM_APP_ROLE_STAGE_CODES.poolConnection);
    client = await pool.connect();
    output = await runCrmAppRoleProvisioning(
      client,
      mode,
      password,
      mode === "apply" ? process.env[CRM_APP_ROLE_CONFIRM_ENV] : undefined,
      {
        setStage,
        onCleanupFailure: recordCleanupFailure,
      },
    );
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
    primaryStageCode = lastStageCode;
  } finally {
    setStage(CRM_APP_ROLE_STAGE_CODES.cleanup);
    try {
      client?.release();
    } catch {
      recordCleanupFailure(createCrmAppRoleProvisionError("CRM_APP_ROLE_CLIENT_CLEANUP_FAILED"));
    }
    try {
      if (pool) await pool.end();
    } catch {
      recordCleanupFailure(createCrmAppRoleProvisionError("CRM_APP_ROLE_POOL_CLEANUP_FAILED"));
    }
  }

  const selectedFailure = selectCrmAppRoleFailure({
    hasPrimaryFailure,
    primaryError: primaryFailure,
    primaryStageCode,
    hasCleanupFailure,
    cleanupError: cleanupFailure,
  });

  if (selectedFailure) {
    console.error(JSON.stringify(formatCrmAppRoleFailureDiagnostic({
      correlationId,
      stageCode: selectedFailure.stageCode,
      error: selectedFailure.error,
      cleanupError: selectedFailure.cleanupError,
    })));
    process.exitCode = 1;
    return;
  }

  const result = output as { status?: string };
  console.log(JSON.stringify({ ...(output as object), correlationId }));
  if (result.status === "preview") process.exitCode = 0;
}

void run().catch(() => {
  console.error(JSON.stringify(formatCrmAppRoleFailureDiagnostic({
    correlationId,
    stageCode: lastStageCode,
    error: createCrmAppRoleProvisionError("CRM_APP_ROLE_PROVISION_FAILED"),
  })));
  process.exitCode = 1;
});
