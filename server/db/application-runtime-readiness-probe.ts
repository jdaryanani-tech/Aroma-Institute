import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  inspectApplicationDatabaseEndpointPolicy,
  inspectApplicationDatabaseStartupPreflight,
  applicationRuntimeFailureCode,
  verifyApplicationRuntimePool,
  type ApplicationRuntimeMode,
} from "./application-runtime-connection";
import {
  assertCrmRuntimeRoleSeparationPostconditions,
  CRM_RUNTIME_REQUIRED_SCHEMA_TABLES,
} from "./crm-runtime-role-postconditions";

export const APPLICATION_DATABASE_READINESS_PROBE_TIMEOUT_MS = 1_000;
export const APPLICATION_DATABASE_READINESS_CONNECT_TIMEOUT_MS = 2_000;
export const APPLICATION_DATABASE_READINESS_TOTAL_TIMEOUT_MS = 8_000;

export type ApplicationDatabaseReadinessSafeCode =
  | "probe_passed"
  | "endpoint_policy_failed"
  | "tls_policy_failed"
  | "endpoint_mismatch"
  | "distinct_application_login_required"
  | "least_privilege_mode_required"
  | "probe_timeout"
  | "read_only_transaction_required"
  | "tls_not_active"
  | "schema_markers_missing"
  | "role_contract_unavailable"
  | "runtime_login_not_approved"
  | "effective_grants_not_approved"
  | "database_metadata_unavailable";

export type ApplicationDatabaseReadinessProbeReport = {
  endpointPolicyPassed: boolean;
  tlsPolicyPassed: boolean;
  endpointsMatch: boolean;
  distinctApplicationLogin: boolean;
  tlsConnectionRequired: boolean;
  tlsActive: boolean | null;
  runtimeLoginVerified: boolean;
  effectiveMinimumGrantsVerified: boolean;
  schemaMarkersVerified: boolean;
  safeCode: ApplicationDatabaseReadinessSafeCode;
};

type DiagnosticClient = Pick<PoolClient, "query" | "release">;
type Queryable = Pick<Pool, "query">;
type SafeTimeoutError = Error & { code: "APPLICATION_READINESS_PROBE_TIMEOUT" };

function timeoutError(): SafeTimeoutError {
  return Object.assign(new Error("application_readiness_probe_timeout"), {
    code: "APPLICATION_READINESS_PROBE_TIMEOUT" as const,
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function remainingTimeout(deadlineAt: number, maximumMs: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw timeoutError();
  return Math.max(1, Math.min(maximumMs, remaining));
}

function safeCodeFromError(error: unknown): ApplicationDatabaseReadinessSafeCode {
  if (
    typeof error === "object" && error !== null &&
    "code" in error &&
    (error.code === "APPLICATION_READINESS_PROBE_TIMEOUT" ||
      error.code === "APP_DATABASE_READINESS_QUERY_TIMEOUT")
  ) return "probe_timeout";
  const runtimeCode = applicationRuntimeFailureCode(error);
  if (runtimeCode === "APP_DATABASE_RUNTIME_IDENTITY_REJECTED") {
    return "runtime_login_not_approved";
  }
  if (runtimeCode === "APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY") {
    return "effective_grants_not_approved";
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : null;
  if (typeof code === "string" && /^CRM_RUNTIME_[A-Z0-9_]+$/.test(code)) {
    return "effective_grants_not_approved";
  }
  return "database_metadata_unavailable";
}

function report(
  config: Pick<
    ApplicationDatabaseReadinessProbeReport,
    | "endpointPolicyPassed"
    | "tlsPolicyPassed"
    | "endpointsMatch"
    | "distinctApplicationLogin"
    | "tlsConnectionRequired"
  >,
  values: Partial<ApplicationDatabaseReadinessProbeReport> = {},
): ApplicationDatabaseReadinessProbeReport {
  return {
    ...config,
    tlsActive: null,
    runtimeLoginVerified: false,
    effectiveMinimumGrantsVerified: false,
    schemaMarkersVerified: false,
    safeCode: "database_metadata_unavailable",
    ...values,
  };
}

async function connectWithin(
  connect: () => Promise<DiagnosticClient>,
  timeoutMs: number,
  deadlineAt: number,
): Promise<DiagnosticClient> {
  const pending = connect();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DiagnosticClient>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError());
    }, remainingTimeout(deadlineAt, timeoutMs));
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (error) {
    if (timedOut) void pending.then(client => client.release()).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function queryWithin<T extends QueryResultRow>(
  client: DiagnosticClient,
  text: string,
  values: unknown[] = [],
  timeoutMs = APPLICATION_DATABASE_READINESS_PROBE_TIMEOUT_MS,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<{ rows: T[] }> {
  const effectiveTimeout = remainingTimeout(deadlineAt, timeoutMs);
  const pending = client.query<T>(text, values) as Promise<{ rows: T[] }>;
  return withTimeout(
    pending,
    effectiveTimeout,
  );
}

export async function probeApplicationRuntimeDatabaseReadiness(input: {
  environment: Record<string, string | undefined>;
  mode: ApplicationRuntimeMode;
  runtimeRoleMigrationSql: string;
  connect: () => Promise<DiagnosticClient>;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Injectable boundary for tests; production uses the existing approved verifier. */
  verifyRuntime?: (
    client: Queryable,
    mode: ApplicationRuntimeMode,
    options: {
      expectedTransactionReadOnly: true;
      onQueryError: (error: unknown) => void;
    },
  ) => Promise<{ status: "least_privilege_verified" | "least_privilege_not_enabled" }>;
  verifyApprovedGrants?: (
    client: Queryable,
    schema: string,
    migrationSql: string,
  ) => Promise<void>;
}): Promise<ApplicationDatabaseReadinessProbeReport> {
  const endpointPolicy = inspectApplicationDatabaseEndpointPolicy(input.environment);
  const startupPreflight = inspectApplicationDatabaseStartupPreflight(input.environment, {
    checked: false,
    passed: false,
  });
  const config = {
    endpointPolicyPassed: endpointPolicy.hostPolicySatisfied,
    tlsPolicyPassed: endpointPolicy.requiredTlsPolicySatisfied,
    endpointsMatch: startupPreflight.endpointDatabaseOptionsMatch,
    distinctApplicationLogin: startupPreflight.distinctLoginConfigured,
    tlsConnectionRequired:
      startupPreflight.platform.hostClassification === "approved_replit_managed_neon" ||
      startupPreflight.application.hostClassification === "approved_replit_managed_neon",
  };

  if (!config.endpointPolicyPassed) {
    return report(config, { safeCode: "endpoint_policy_failed" });
  }
  if (!config.tlsPolicyPassed) {
    return report(config, { safeCode: "tls_policy_failed" });
  }
  if (!config.endpointsMatch) {
    return report(config, { safeCode: "endpoint_mismatch" });
  }
  if (!config.distinctApplicationLogin) {
    return report(config, { safeCode: "distinct_application_login_required" });
  }
  if (input.mode.kind !== "least_privilege") {
    return report(config, { safeCode: "least_privilege_mode_required" });
  }

  let client: DiagnosticClient | null = null;
  let transactionStarted = false;
  let destroyClient = false;
  const deadlineAt = Date.now() + Math.max(
    500,
    Math.min(input.totalTimeoutMs ?? APPLICATION_DATABASE_READINESS_TOTAL_TIMEOUT_MS, 10_000),
  );
  const statementTimeoutMs = Math.max(
    250,
    Math.min(input.statementTimeoutMs ?? APPLICATION_DATABASE_READINESS_PROBE_TIMEOUT_MS, 1_500),
  );
  try {
    client = await connectWithin(
      input.connect,
      Math.max(
        250,
        Math.min(input.connectTimeoutMs ?? APPLICATION_DATABASE_READINESS_CONNECT_TIMEOUT_MS, 3_000),
      ),
      deadlineAt,
    );

    await queryWithin(client, "BEGIN READ ONLY", [], statementTimeoutMs, deadlineAt);
    transactionStarted = true;
    await queryWithin(
      client,
      `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`,
      [],
      statementTimeoutMs,
      deadlineAt,
    );
    await queryWithin(client, "SET LOCAL lock_timeout = '400ms'", [], statementTimeoutMs, deadlineAt);

    const transaction = await queryWithin<{ read_only: string }>(
      client,
      "SELECT current_setting('transaction_read_only') AS read_only",
      [],
      statementTimeoutMs,
      deadlineAt,
    );
    if (transaction.rows[0]?.read_only !== "on") {
      return report(config, { safeCode: "read_only_transaction_required" });
    }

    const tls = await queryWithin<{ tls_active: boolean }>(
      client,
      `SELECT COALESCE((
        SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()
      ), false) AS tls_active`,
      [],
      statementTimeoutMs,
      deadlineAt,
    );
    const tlsActive = tls.rows[0]?.tls_active === true;
    if (config.tlsConnectionRequired && !tlsActive) {
      return report(config, { tlsActive, safeCode: "tls_not_active" });
    }

    const schema = await queryWithin<{ markers_verified: boolean }>(
      client,
      `SELECT COALESCE(bool_and(
        pg_catalog.to_regclass(pg_catalog.format('%I.%I','public',required.table_name)) IS NOT NULL
      ), false) AS markers_verified
      FROM pg_catalog.unnest($1::text[]) AS required(table_name)`,
      [[...CRM_RUNTIME_REQUIRED_SCHEMA_TABLES]],
      statementTimeoutMs,
      deadlineAt,
    );
    const schemaMarkersVerified = schema.rows[0]?.markers_verified === true;
    if (!schemaMarkersVerified) {
      return report(config, {
        tlsActive,
        schemaMarkersVerified,
        safeCode: "schema_markers_missing",
      });
    }
    if (!input.runtimeRoleMigrationSql.trim()) {
      return report(config, {
        tlsActive,
        schemaMarkersVerified,
        safeCode: "role_contract_unavailable",
      });
    }

    let queryError: unknown = null;
    const boundedClient = {
      query: (text: string, values?: unknown[]) =>
        queryWithin(client!, text, values, statementTimeoutMs, deadlineAt),
    } as unknown as Queryable;
    const verifyRuntime = input.verifyRuntime ?? (async (queryable, mode, options) =>
      verifyApplicationRuntimePool(queryable as Pick<Pool, "query">, mode, undefined, options));
    const verifyApprovedGrants = input.verifyApprovedGrants ??
      assertCrmRuntimeRoleSeparationPostconditions;
    try {
      const result = await verifyRuntime(boundedClient, input.mode, {
        expectedTransactionReadOnly: true,
        onQueryError: error => { queryError = error; },
      });
      if (result.status !== "least_privilege_verified") {
        return report(config, {
          tlsActive,
          runtimeLoginVerified: false,
          schemaMarkersVerified,
          safeCode: "runtime_login_not_approved",
        });
      }
      try {
        await verifyApprovedGrants(boundedClient, "public", input.runtimeRoleMigrationSql);
      } catch (error) {
        const safeCode = queryError
          ? safeCodeFromError(queryError)
          : safeCodeFromError(error);
        return report(config, {
          tlsActive,
          runtimeLoginVerified: true,
          effectiveMinimumGrantsVerified: false,
          schemaMarkersVerified,
          safeCode,
        });
      }
      return report(config, {
        tlsActive,
        runtimeLoginVerified: true,
        effectiveMinimumGrantsVerified: true,
        schemaMarkersVerified,
        safeCode: "probe_passed",
      });
    } catch (error) {
      const safeCode = queryError
        ? safeCodeFromError(queryError)
        : safeCodeFromError(error);
      const runtimeCode = applicationRuntimeFailureCode(error);
      return report(config, {
        tlsActive,
        runtimeLoginVerified: runtimeCode === "APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY",
        effectiveMinimumGrantsVerified: false,
        schemaMarkersVerified,
        safeCode,
      });
    }
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "APPLICATION_READINESS_PROBE_TIMEOUT"
    ) destroyClient = true;
    return report(config, { safeCode: safeCodeFromError(error) });
  } finally {
    if (client) {
      if (transactionStarted) {
        try {
          await queryWithin(client, "ROLLBACK", [], Math.min(statementTimeoutMs, 500));
        } catch {
          destroyClient = true;
        }
      }
      client.release(destroyClient ? true : undefined);
    }
  }
}
