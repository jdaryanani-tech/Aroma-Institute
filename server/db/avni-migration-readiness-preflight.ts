import type { PoolClient } from "pg";
import {
  readCrmAppRoleProvisioningState,
  validateCrmAppRoleProvisioningState,
} from "./crm-app-role-provisioning";
import { assertCrmRuntimeRoleSeparationPostconditions } from "./crm-runtime-role-postconditions";
import {
  assertAvniConversationPreflightPostconditions,
  assertAvniConversationRuntimePostconditions,
  assertAvniConversationRuntimeReadiness,
} from "./supabase-avni-conversation-runtime-postconditions";

type Queryable = Pick<PoolClient, "query">;
type QueryResult<T> = { rows: T[] };
type PreflightClient = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
};

export const AVNI_MIGRATION_SOURCE_ORDER = {
  replit: [
    "0019_avni_dispatch_grants.sql",
    "0020_avni_dispatch_authorization_fence.sql",
  ],
  supabase: [
    "20261107_aichm_two_database_contract.sql",
    "20261118_avni_conversation_runtime_v1.sql",
    "20261118_avni_conversation_runtime_v2_preflight.sql",
    "20261118_avni_human_pilot_dispatch_v3.sql",
  ],
} as const;

export type AvniDatabaseIdentityExpectation = {
  databaseName: string;
  serverAddress: string;
  serverPort: number;
  sessionUser: string;
  currentUser: string;
};

type IdentityRow = {
  database_name: string | null;
  server_address: string | null;
  server_port: number | string | null;
  session_user: string | null;
  current_user: string | null;
  in_recovery: boolean | null;
};

export type AvniPreflightTargetResult = {
  status: "ready" | "blocked" | "not_checked";
  targetIdentity: "matched_primary" | "mismatch" | "unavailable" | "not_checked";
  catalog: "verified" | "failed" | "not_checked";
  approvedRuntimeLogin: "verified" | "not_approved" | "failed" | "not_checked";
  safeCode: string | null;
};

export type AvniMigrationReadinessReport = {
  replit: AvniPreflightTargetResult;
  supabase: AvniPreflightTargetResult;
  sourceMigrationOrder: "verified" | "mismatch";
  /** 0019/0020 are intentionally manual drafts, not a Drizzle-journal claim. */
  replitLedger: "manual_unregistered" | "unexpectedly_registered";
  appliedMigrationState: "not_checked";
  dispatchEnabled: false;
};

export function validateAvniMigrationSourceOrder(input: {
  replit: readonly string[];
  supabase: readonly string[];
}): boolean {
  const same = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((item, index) => item === right[index]);
  return same(input.replit, AVNI_MIGRATION_SOURCE_ORDER.replit)
    && same(input.supabase, AVNI_MIGRATION_SOURCE_ORDER.supabase);
}

function safeErrorCode(error: unknown, prefix: string): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof code === "string" && new RegExp(`^${prefix}_[A-Z0-9_]+$`).test(code)
    ? code
    : `${prefix}_CATALOG_CHECK_FAILED`;
}

async function verifyIdentity(
  client: PreflightClient,
  expected: AvniDatabaseIdentityExpectation,
): Promise<"matched_primary" | "mismatch" | "unavailable"> {
  try {
    const { rows } = await client.query<IdentityRow>(`
      SELECT current_database()::text AS database_name,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port,
        session_user::text AS session_user,
        current_user::text AS current_user,
        pg_is_in_recovery() AS in_recovery
    `);
    const identity = rows[0];
    if (
      !identity?.database_name ||
      !identity.server_address ||
      identity.server_port === null ||
      !identity.session_user ||
      !identity.current_user ||
      identity.in_recovery === null
    ) return "unavailable";
    const matches = identity.database_name === expected.databaseName
      && identity.server_address === expected.serverAddress
      && Number(identity.server_port) === expected.serverPort
      && identity.session_user === expected.sessionUser
      && identity.current_user === expected.currentUser
      && identity.in_recovery === false;
    return matches ? "matched_primary" : "mismatch";
  } catch {
    return "unavailable";
  }
}

async function withReadOnlyTransaction<T>(
  client: PreflightClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN READ ONLY");
  try {
    const { rows } = await client.query<{ read_only: string }>(
      "SELECT current_setting('transaction_read_only') AS read_only",
    );
    if (rows[0]?.read_only !== "on") throw new Error("AVNI_PREFLIGHT_TRANSACTION_NOT_READ_ONLY");
    const value = await operation();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function targetResult(
  status: AvniPreflightTargetResult["status"],
  targetIdentity: AvniPreflightTargetResult["targetIdentity"],
  catalog: AvniPreflightTargetResult["catalog"],
  approvedRuntimeLogin: AvniPreflightTargetResult["approvedRuntimeLogin"],
  safeCode: string | null,
): AvniPreflightTargetResult {
  return { status, targetIdentity, catalog, approvedRuntimeLogin, safeCode };
}

async function runTarget(
  input: {
    client: PreflightClient | null;
    expectedIdentity: AvniDatabaseIdentityExpectation | null;
    kind: "replit" | "supabase";
    replitRuntimeMigrationSql?: string;
    approvedSupabaseLoginRole?: string | null;
  },
): Promise<AvniPreflightTargetResult> {
  if (!input.client || !input.expectedIdentity) {
    return targetResult("not_checked", "not_checked", "not_checked", "not_checked", null);
  }
  let observedTargetIdentity: AvniPreflightTargetResult["targetIdentity"] = "unavailable";
  try {
    return await withReadOnlyTransaction(input.client, async () => {
      const identity = await verifyIdentity(input.client!, input.expectedIdentity!);
      observedTargetIdentity = identity;
      if (identity !== "matched_primary") {
        return targetResult(
          "blocked",
          identity,
          "not_checked",
          input.kind === "supabase" && !input.approvedSupabaseLoginRole
            ? "not_approved"
            : "not_checked",
          identity === "mismatch"
            ? `${input.kind.toUpperCase()}_TARGET_IDENTITY_MISMATCH`
            : `${input.kind.toUpperCase()}_TARGET_IDENTITY_UNAVAILABLE`,
        );
      }

      if (input.kind === "replit") {
        if (!input.replitRuntimeMigrationSql) {
          return targetResult(
            "blocked", identity, "not_checked", "not_checked",
            "REPLIT_MIGRATION_SOURCE_UNAVAILABLE",
          );
        }
        await assertCrmRuntimeRoleSeparationPostconditions(
          input.client as Queryable,
          "public",
          input.replitRuntimeMigrationSql,
        );
        const roleState = await readCrmAppRoleProvisioningState(input.client as Queryable);
        validateCrmAppRoleProvisioningState(roleState);
        return targetResult("ready", identity, "verified", "not_checked", null);
      }

      await assertAvniConversationRuntimePostconditions(input.client as Queryable, true);
      await assertAvniConversationPreflightPostconditions(input.client as Queryable);
      if (input.approvedSupabaseLoginRole) {
        await assertAvniConversationRuntimeReadiness(
          input.client as Queryable,
          input.approvedSupabaseLoginRole,
        );
        return targetResult("ready", identity, "verified", "verified", null);
      }
      return targetResult(
        "blocked", identity, "verified", "not_approved",
        "SUPABASE_RUNTIME_LOGIN_NOT_APPROVED",
      );
    });
  } catch (error) {
    return targetResult(
      "blocked",
      observedTargetIdentity,
      "failed",
      input.kind === "supabase" && !input.approvedSupabaseLoginRole
        ? "not_approved"
        : "failed",
      safeErrorCode(error, input.kind === "replit" ? "CRM_RUNTIME" : "AVNI_CONVERSATION"),
    );
  }
}

/**
 * Catalog-only readiness report. Connections and expected identities must be
 * supplied explicitly by a trusted operator; this function never reads env,
 * opens pools, runs migration/provisioning code, or returns DB identity values.
 */
export async function inspectAvniMigrationReadiness(input: {
  replit: {
    client: PreflightClient | null;
    expectedIdentity: AvniDatabaseIdentityExpectation | null;
    runtimeMigrationSql?: string;
    sourceOrder: readonly string[];
  };
  supabase: {
    client: PreflightClient | null;
    expectedIdentity: AvniDatabaseIdentityExpectation | null;
    approvedRuntimeLoginRole?: string | null;
    sourceOrder: readonly string[];
  };
  crmMigrationSqlRegisteredInDrizzleJournal: boolean;
}): Promise<AvniMigrationReadinessReport> {
  const sourceMigrationOrder = validateAvniMigrationSourceOrder({
    replit: input.replit.sourceOrder,
    supabase: input.supabase.sourceOrder,
  }) ? "verified" : "mismatch";
  if (sourceMigrationOrder === "mismatch") {
    return {
      replit: targetResult("blocked", "not_checked", "not_checked", "not_checked",
        "AVNI_MIGRATION_SOURCE_ORDER_MISMATCH"),
      supabase: targetResult("blocked", "not_checked", "not_checked", "not_checked",
        "AVNI_MIGRATION_SOURCE_ORDER_MISMATCH"),
      sourceMigrationOrder,
      replitLedger: input.crmMigrationSqlRegisteredInDrizzleJournal
        ? "unexpectedly_registered"
        : "manual_unregistered",
      appliedMigrationState: "not_checked",
      dispatchEnabled: false,
    };
  }
  const [replit, supabase] = await Promise.all([
    runTarget({
      client: input.replit.client,
      expectedIdentity: input.replit.expectedIdentity,
      kind: "replit",
      replitRuntimeMigrationSql: input.replit.runtimeMigrationSql,
    }),
    runTarget({
      client: input.supabase.client,
      expectedIdentity: input.supabase.expectedIdentity,
      kind: "supabase",
      approvedSupabaseLoginRole: input.supabase.approvedRuntimeLoginRole,
    }),
  ]);
  return {
    replit,
    supabase,
    sourceMigrationOrder,
    replitLedger: input.crmMigrationSqlRegisteredInDrizzleJournal
      ? "unexpectedly_registered"
      : "manual_unregistered",
    appliedMigrationState: "not_checked",
    dispatchEnabled: false,
  };
}
