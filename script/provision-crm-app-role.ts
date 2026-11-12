import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  crmForwardEffectivePort,
  requireCrmForwardConnectionUrl,
} from "../server/db/crm-forward-migration-guard";
import {
  createCrmAppRoleProvisionError,
  isStrongAlphanumericAppRolePassword,
  parseCrmAppRoleProvisionMode,
  runCrmAppRoleProvisioning,
  sanitizedCrmAppRoleErrorCode,
  CRM_APP_ROLE_PASSWORD_ENV,
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

async function run(): Promise<void> {
  const correlationId = randomUUID();
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  let output: unknown;
  let failed = false;
  let failure: unknown;
  try {
    const mode = modeFromArgs(process.argv.slice(2), process.env);
    const password = process.env[CRM_APP_ROLE_PASSWORD_ENV];
    if (mode === "apply" && !isStrongAlphanumericAppRolePassword(password)) {
      throw createCrmAppRoleProvisionError(password
        ? "CRM_APP_ROLE_PASSWORD_FORMAT_REJECTED"
        : "CRM_APP_ROLE_PASSWORD_SECRET_REQUIRED");
    }

    // This guard returns only the dedicated AICHM URL. DATABASE_URL is used
    // only as its existing in-memory endpoint comparison reference.
    const dedicatedUrl = requireCrmForwardConnectionUrl(process.env);
    const effectivePort = crmForwardEffectivePort(new URL(dedicatedUrl));
    pool = new Pool(operatorPoolConfig(dedicatedUrl, effectivePort));
    client = await pool.connect();
    output = await runCrmAppRoleProvisioning(
      client,
      mode,
      password,
      process.env[CRM_APP_ROLE_CONFIRM_ENV],
    );
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      client?.release();
    } catch {
      failed = true;
      failure = createCrmAppRoleProvisionError("CRM_APP_ROLE_CLIENT_CLEANUP_FAILED");
    }
    try {
      if (pool) await pool.end();
    } catch {
      failed = true;
      failure = createCrmAppRoleProvisionError("CRM_APP_ROLE_POOL_CLEANUP_FAILED");
    }
  }

  if (failed) {
    const code = sanitizedCrmAppRoleErrorCode(failure);
    console.error(JSON.stringify({ status: "blocked", code, correlationId }));
    process.exitCode = 1;
    return;
  }

  const result = output as { status?: string };
  console.log(JSON.stringify({ ...(output as object), correlationId }));
  if (result.status === "preview") process.exitCode = 0;
}

void run().catch(() => {
  console.error(JSON.stringify({
    status: "blocked",
    code: "CRM_APP_ROLE_PROVISION_FAILED",
    correlationId: "unavailable",
  }));
  process.exitCode = 1;
});
