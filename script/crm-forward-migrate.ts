import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  buildCrmForwardLedgerDiagnostics,
  formatCrmForwardStageFailure,
  type CrmForwardFailureStage,
} from "../server/db/crm-forward-migration-diagnostics";
import { unwrapCrmMigration } from "../server/db/crm-migration-wrapper";
import {
  assertCrmAssignmentSchemaAbsent,
  assertCrmAssignmentSchemaPostconditions,
} from "../server/db/crm-forward-migration-postconditions";
import {
  assertCrmMetaLeadAdsPostconditions,
  assertCrmMetaLeadAdsPrerequisites,
  assertCrmMetaLeadAdsSchemaAbsent,
} from "../server/db/crm-meta-migration-postconditions";
import {
  assertCrmMetaPhoneIdentityDiagnosticsPostconditions,
  assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent,
} from "../server/db/crm-meta-phone-identity-diagnostics-postconditions";
import {
  assertCrmRuntimeAssignmentFunctionAbsent,
  assertCrmRuntimeRoleSeparationPostconditions,
} from "../server/db/crm-runtime-role-postconditions";
import { inspectApplicationPreMigrationRoleGate } from "../server/db/crm-forward-app-role-preflight";
import {
  applicationRuntimeFailureCode,
  buildApplicationPoolConfig,
  resolveApplicationRuntimeMode,
  verifyApplicationRuntimePool,
} from "../server/db/application-runtime-connection";
import {
  runAfterCrmPreApplyRoleGate,
  type CrmPreApplyRoleGate,
} from "../server/db/crm-forward-apply-gate";
import {
  assertCrmForwardDevelopmentIdentity,
  crmForwardEffectivePort,
  CRM_FORWARD_DEVELOPMENT_IDENTITY,
  requireCrmForwardConnectionUrl,
  type CrmForwardDatabaseIdentity,
} from "../server/db/crm-forward-migration-guard";
import {
  parseCrmForwardMigrationMode,
  type CrmForwardMigrationMode,
} from "../server/db/crm-forward-migration-mode";

type Migration = {
  id: string;
  file: string;
  requires: string[];
  postconditions: string;
};
type Registry = {
  stream: string;
  ledger: { schema: string; table: string };
  migrations: Migration[];
};
type Queryable = Pick<PoolClient, "query">;
type MigrationArtifact = { sql: string; hash: string };
type StageSetter = (stage: CrmForwardFailureStage, migrationId?: string) => void;
type RuntimeRoleGate = CrmPreApplyRoleGate;

const REGISTRY_PATH = path.resolve("migrations/crm-forward/registry.json");
const EXPECTED_MIGRATIONS = [
  "0014_crm_canonical_assignments",
  "0015_crm_assignment_audit_invariants",
  "0016_crm_runtime_role_separation",
  "0017_meta_lead_ads_schema",
  "0018_meta_phone_identity_diagnostics",
];
const EXPECTED_FILES = [
  "../0014_crm_canonical_assignments.sql",
  "../0015_crm_assignment_audit_invariants.sql",
  "../0016_crm_runtime_role_separation.sql",
  "../0017_meta_lead_ads_schema.sql",
  "../0018_meta_phone_identity_diagnostics.sql",
];
const ADVISORY_LOCK_KEYS = [1095326536, 1128813875] as const;
const BASE_COLUMNS: Record<string, string[]> = {
  admissions_leads: ["id", "canonical_phone", "name"],
  lms_users: ["id", "is_active"],
  lms_user_roles: ["user_id", "role"],
};

function fail(code: string, cause?: unknown): never {
  const error = new Error(code) as Error & { code: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function validateRegistry(registry: Registry): void {
  const expectedRequirements = [
    ["public.admissions_leads", "public.lms_users", "public.lms_user_roles"],
    [
      "ledger:0014_crm_canonical_assignments",
      "trigger:admissions_lead_assignments_validate_trg",
      "trigger:admissions_lead_assignment_history_validate_trg",
      "trigger:admissions_lead_assignment_history_immutable_trg",
      "trigger:admissions_lead_assignment_history_no_truncate_trg",
    ],
    [
      "ledger:0015_crm_assignment_audit_invariants",
      "trigger:admissions_lead_assignments_history_required_trg",
      "table:admissions_lead_assignments",
      "table:admissions_lead_assignment_history",
    ],
    [
      "ledger:0016_crm_runtime_role_separation",
      "public.admissions_leads",
      "public.inquiries",
      "meta-schema:absent",
    ],
    [
      "ledger:0017_meta_lead_ads_schema",
      "table:admissions_meta_lead_links",
      "meta-phone-diagnostics:absent",
    ],
  ];
  const expectedPostconditions = [
    "crm_assignments_v0014",
    "crm_assignment_invariants_v0015",
    "crm_runtime_role_separation_v0016",
    "crm_meta_lead_ads_v0017",
    "crm_meta_phone_identity_diagnostics_v0018",
  ];
  if (
    registry.stream !== "aichm-crm-forward" ||
    registry.ledger.schema !== "aichm_crm_forward_meta" ||
    registry.ledger.table !== "schema_migrations" ||
    registry.migrations.length !== EXPECTED_MIGRATIONS.length ||
    registry.migrations.some((migration, index) =>
      migration.id !== EXPECTED_MIGRATIONS[index] ||
      migration.file !== EXPECTED_FILES[index] ||
      migration.postconditions !== expectedPostconditions[index] ||
      JSON.stringify(migration.requires) !== JSON.stringify(expectedRequirements[index])
    )
  ) fail("CRM_FORWARD_REGISTRY_INVALID");
}

function pgConfig(connectionUrl: string, effectivePort: number) {
  const url = new URL(connectionUrl);
  return {
    host: url.hostname,
    port: effectivePort,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    application_name: "aichm_crm_forward_migration",
    // Approved non-TLS transport is restricted by the guard to the matching
    // internal Replit Development endpoint and exact live identity check.
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 8_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  };
}

async function inspectIdentity(client: Queryable): Promise<CrmForwardDatabaseIdentity> {
  const { rows: [row] } = await client.query<{
    database_name: string;
    database_oid: string;
    database_user: string;
    system_identifier: string;
    in_recovery: boolean;
    default_transaction_read_only: boolean;
  }>(`
    SELECT current_database() AS database_name,
      d.oid::text AS database_oid,
      current_user AS database_user,
      (pg_control_system()).system_identifier::text AS system_identifier,
      pg_is_in_recovery() AS in_recovery,
      current_setting('default_transaction_read_only')::boolean AS default_transaction_read_only
    FROM pg_database d
    WHERE d.datname = current_database()
  `);
  if (!row) fail("CRM_FORWARD_DATABASE_IDENTITY_UNAVAILABLE");
  return {
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    databaseUser: row.database_user,
    systemIdentifier: row.system_identifier,
    inRecovery: row.in_recovery,
    defaultTransactionReadOnly: row.default_transaction_read_only,
  };
}

async function presentBaseTables(client: Queryable): Promise<string[]> {
  const expected = Object.entries(BASE_COLUMNS).flatMap(([table, columns]) =>
    columns.map(column => ({ table, column })),
  );
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema='public'
       AND (table_name,column_name) IN (SELECT * FROM unnest($1::text[],$2::text[]))`,
    [expected.map(item => item.table), expected.map(item => item.column)],
  );
  const found = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
  return expected
    .filter(item => !found.has(`${item.table}.${item.column}`))
    .map(item => `public.${item.table}.${item.column}`);
}

async function inspectReadOnlyRuntimeAccess(client: Queryable) {
  const { rows: [role] } = await client.query<{
    connection_role: string;
    connection_role_is_superuser: boolean;
  }>(`
    SELECT current_user AS connection_role,
      r.rolsuper AS connection_role_is_superuser
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  if (!role) fail("CRM_FORWARD_CONNECTION_ROLE_UNAVAILABLE");

  const { rows: [admissions] } = await client.query<{ active_admissions_users: number }>(`
    SELECT count(DISTINCT u.id)::integer AS active_admissions_users
    FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id = u.id
    WHERE r.role::text = 'admissions'
      AND u.is_active IS TRUE
  `);

  const { rows } = await client.query<{
    table_name: string;
    exists: boolean;
    owner: string | null;
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
    can_truncate: boolean;
  }>(`
    WITH expected(table_name) AS (
      SELECT unnest($1::text[])
    )
    SELECT e.table_name,
      c.oid IS NOT NULL AS exists,
      owner_role.rolname AS owner,
      CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(current_user, c.oid, 'SELECT') END AS can_select,
      CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(current_user, c.oid, 'INSERT') END AS can_insert,
      CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(current_user, c.oid, 'UPDATE') END AS can_update,
      CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(current_user, c.oid, 'DELETE') END AS can_delete,
      CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(current_user, c.oid, 'TRUNCATE') END AS can_truncate
    FROM expected e
    LEFT JOIN pg_class c
      ON c.relnamespace = 'public'::regnamespace
      AND c.relname = e.table_name
      AND c.relkind IN ('r', 'p')
    LEFT JOIN pg_roles owner_role ON owner_role.oid = c.relowner
    ORDER BY e.table_name
  `, [[
    "admissions_leads",
    "lms_users",
    "lms_user_roles",
    "admissions_lead_assignments",
    "admissions_lead_assignment_history",
  ]]);

  return {
    connectionRole: role.connection_role,
    connectionRoleIsSuperuser: role.connection_role_is_superuser,
    activeAdmissionsUsers: admissions?.active_admissions_users ?? 0,
    tables: rows,
  };
}

async function readExistingLedger(client: Queryable, registry: Registry) {
  const regclass = `${registry.ledger.schema}.${registry.ledger.table}`;
  const { rows: [state] } = await client.query<{
    schema_exists: boolean;
    table_exists: boolean;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS schema_exists,
       to_regclass($2) IS NOT NULL AS table_exists`,
    [registry.ledger.schema, regclass],
  );
  const schemaExists = state?.schema_exists === true;
  const tableExists = state?.table_exists === true;
  if (!tableExists) {
    return {
      schemaExists,
      tableExists,
      rows: [] as Array<{ migration_id: string; sha256: string }>,
    };
  }
  const { rows } = await client.query<{ migration_id: string; sha256: string }>(
    `SELECT migration_id,sha256 FROM ${registry.ledger.schema}.${registry.ledger.table} ORDER BY migration_id`,
  );
  return { schemaExists, tableExists, rows };
}

async function ensureLedger(
  client: Queryable,
  registry: Registry,
  assertTarget: () => Promise<void>,
): Promise<void> {
  await assertTarget();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${registry.ledger.schema}`);
  await assertTarget();
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${registry.ledger.schema}.${registry.ledger.table} (
      migration_id text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadArtifacts(registry: Registry): Promise<Map<string, MigrationArtifact>> {
  const migrationsRoot = path.resolve("migrations");
  const artifacts = new Map<string, MigrationArtifact>();
  for (const migration of registry.migrations) {
    const file = path.resolve(path.dirname(REGISTRY_PATH), migration.file);
    if (!file.startsWith(`${migrationsRoot}${path.sep}`)) fail("CRM_FORWARD_REGISTRY_PATH_REJECTED");
    const sql = await readFile(file, "utf8");
    artifacts.set(migration.id, {
      sql,
      hash: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return artifacts;
}

function artifact(artifacts: Map<string, MigrationArtifact>, id: string): MigrationArtifact {
  const found = artifacts.get(id);
  if (!found) fail("CRM_FORWARD_REGISTRY_INVALID");
  return found;
}

async function collectPlan(
  client: Queryable,
  registry: Registry,
  artifacts: Map<string, MigrationArtifact>,
  setStage: StageSetter,
): Promise<{
  ledger: Map<string, string>;
  ledgerState: ReturnType<typeof buildCrmForwardLedgerDiagnostics>;
  pending: Migration[];
  basePrerequisites: "present";
  schemaState: "absent" | "0014_complete" | "0014_0015_complete" | "0014_0015_0016_complete" |
    "0014_0015_0016_0017_complete" | "0014_0015_0016_0017_0018_complete";
  metaSchemaState: "absent" | "0017_complete" | "0018_complete";
  runtimeAccess: Awaited<ReturnType<typeof inspectReadOnlyRuntimeAccess>>;
}> {
  setStage("prerequisiteSchemaDriftInspection");
  const missingBase = await presentBaseTables(client);
  if (missingBase.length) fail("CRM_FORWARD_BASE_PREREQUISITES_MISSING");
  await assertCrmMetaLeadAdsPrerequisites(client, "public");
  const runtimeAccess = await inspectReadOnlyRuntimeAccess(client);

  setStage("migrationLedgerRead");
  const ledgerRead = await readExistingLedger(client, registry);
  const rows = ledgerRead.rows;
  const allowed = new Set(registry.migrations.map(migration => migration.id));
  if (rows.some(row => !allowed.has(row.migration_id))) fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
  const ledger = new Map(rows.map(row => [row.migration_id, row.sha256]));
  for (const migration of registry.migrations) {
    const recordedHash = ledger.get(migration.id);
    if (recordedHash && recordedHash !== artifact(artifacts, migration.id).hash) {
      fail("CRM_FORWARD_LEDGER_HASH_MISMATCH");
    }
  }
  const ledgerState = buildCrmForwardLedgerDiagnostics({
    schemaExists: ledgerRead.schemaExists,
    tableExists: ledgerRead.tableExists,
    registeredMigrations: registry.migrations.map(migration => ({
      id: migration.id,
      sha256: artifact(artifacts, migration.id).hash,
    })),
    ledgerRows: rows,
  });

  const recorded14 = ledger.has(EXPECTED_MIGRATIONS[0]);
  const recorded15 = ledger.has(EXPECTED_MIGRATIONS[1]);
  const recorded16 = ledger.has(EXPECTED_MIGRATIONS[2]);
  const recorded17 = ledger.has(EXPECTED_MIGRATIONS[3]);
  const recorded18 = ledger.has(EXPECTED_MIGRATIONS[4]);
  setStage("prerequisiteSchemaDriftInspection");
  if (recorded15 && !recorded14) fail("CRM_FORWARD_0014_LEDGER_PREREQUISITE_MISSING");
  if (recorded16 && !recorded15) fail("CRM_FORWARD_0015_LEDGER_PREREQUISITE_MISSING");
  if (recorded17 && !recorded16) fail("CRM_FORWARD_0016_LEDGER_PREREQUISITE_MISSING");
  if (recorded18 && !recorded17) fail("CRM_FORWARD_0017_LEDGER_PREREQUISITE_MISSING");
  if (!recorded14) {
    if (rows.length) fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
    await assertCrmAssignmentSchemaAbsent(
      client,
      "public",
      artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
      artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
    );
    await assertCrmRuntimeAssignmentFunctionAbsent(client);
  } else {
    await assertCrmAssignmentSchemaPostconditions(
      client,
      "public",
      recorded16 ? "0016" : recorded15 ? "0015" : "0014",
      artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
      artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
    );
    if (recorded16) {
      await assertCrmRuntimeRoleSeparationPostconditions(
        client,
        "public",
        artifact(artifacts, EXPECTED_MIGRATIONS[2]).sql,
      );
    } else {
      await assertCrmRuntimeAssignmentFunctionAbsent(client);
    }
  }
  if (recorded17) {
    await assertCrmMetaLeadAdsPostconditions(client, "public");
    if (recorded18) {
      await assertCrmMetaPhoneIdentityDiagnosticsPostconditions(client, "public");
    } else {
      await assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent(client, "public");
    }
  } else {
    await assertCrmMetaLeadAdsSchemaAbsent(client, "public");
  }

  setStage("previewPlanAssembly");
  return {
    ledger,
    ledgerState,
    pending: registry.migrations.filter(migration => !ledger.has(migration.id)),
    basePrerequisites: "present",
    schemaState: !recorded14
      ? "absent"
      : recorded15
        ? recorded16
          ? recorded17
              ? recorded18
                ? "0014_0015_0016_0017_0018_complete"
                : "0014_0015_0016_0017_complete"
            : "0014_0015_0016_complete"
          : "0014_0015_complete"
        : "0014_complete",
    metaSchemaState: recorded18 ? "0018_complete" : recorded17 ? "0017_complete" : "absent",
    runtimeAccess,
  };
}

async function inspectApplicationRuntimeRoleGate(
  environment: Record<string, string | undefined>,
  target: CrmForwardDatabaseIdentity,
): Promise<RuntimeRoleGate> {
  if (environment.AICHM_APP_DATABASE_URL === undefined) {
    return { status: "blocked", reason: "APP_DATABASE_URL_NOT_CONFIGURED" };
  }

  let candidatePool: Pool | undefined;
  try {
    const mode = resolveApplicationRuntimeMode(environment);
    if (mode.kind !== "least_privilege" || mode.expectedDatabase !== target.databaseName) {
      return { status: "blocked", reason: "APP_DATABASE_TARGET_MISMATCH" };
    }
    candidatePool = new Pool(buildApplicationPoolConfig(mode));
    await verifyApplicationRuntimePool(candidatePool, mode, {
      databaseName: target.databaseName,
      databaseOid: target.databaseOid,
    });
    return { status: "ready", reason: null };
  } catch (error) {
    return {
      status: "blocked",
      reason: applicationRuntimeFailureCode(error) ?? "APP_DATABASE_RUNTIME_IDENTITY_UNAVAILABLE",
    };
  } finally {
    if (candidatePool) await candidatePool.end().catch(() => undefined);
  }
}

function previewRecord(
  identity: CrmForwardDatabaseIdentity,
  registry: Registry,
  plan: Awaited<ReturnType<typeof collectPlan>>,
  artifacts: Map<string, MigrationArtifact>,
  mode: "preview" | "apply",
  effectivePort: number,
  preApplyRoleGate: RuntimeRoleGate,
  runtimeRoleGate: RuntimeRoleGate,
) {
  return {
    status: "preview",
    mode,
    effectivePort,
    targetIdentity: {
      expectedPinnedDevelopment: CRM_FORWARD_DEVELOPMENT_IDENTITY,
      verified: {
        databaseName: identity.databaseName,
        databaseOid: identity.databaseOid,
        databaseUser: identity.databaseUser,
        systemIdentifier: identity.systemIdentifier,
        inRecovery: identity.inRecovery,
        defaultTransactionReadOnly: identity.defaultTransactionReadOnly,
      },
    },
    migrationFiles: registry.migrations.map(migration => ({
      id: migration.id,
      file: migration.file,
    })),
    ledger: registry.migrations.map(migration => {
      const recordedHash = plan.ledger.get(migration.id);
      return {
        id: migration.id,
        status: recordedHash ? "applied" : "pending",
        checksumMatches: recordedHash
          ? recordedHash === artifact(artifacts, migration.id).hash
          : null,
      };
    }),
    ledgerState: plan.ledgerState,
    schemaAssessment: {
      basePrerequisites: plan.basePrerequisites,
      crmAssignments: plan.schemaState,
      metaLeadAds: plan.metaSchemaState,
      conflicts: "none",
      postconditionsVerified: true,
    },
    runtimeAccess: plan.runtimeAccess,
    preApplyRoleGate,
    runtimeRoleGate,
    wouldRun: plan.pending.map(migration => ({ id: migration.id, file: migration.file })),
    message: mode === "preview"
      ? "No schema writes were made. Use the explicit apply flag and confirmation variable to apply."
      : "Apply was explicitly confirmed; the verified plan will be rechecked under an advisory lock.",
  };
}

async function readOnlyPlan(
  client: PoolClient,
  registry: Registry,
  artifacts: Map<string, MigrationArtifact>,
  setStage: StageSetter,
  completionStage: CrmForwardFailureStage = "previewPlanAssembly",
) {
  setStage("readOnlyTransactionStart");
  try {
    await client.query("BEGIN READ ONLY");
    setStage("livePinnedIdentityVerification");
    const identity = await inspectIdentity(client);
    assertCrmForwardDevelopmentIdentity(identity);
    const plan = await collectPlan(client, registry, artifacts, setStage);
    setStage(completionStage);
    await client.query("COMMIT");
    return { identity, plan };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function readPinnedDevelopmentIdentity(
  client: PoolClient,
  setStage: StageSetter,
): Promise<CrmForwardDatabaseIdentity> {
  setStage("readOnlyTransactionStart");
  try {
    await client.query("BEGIN READ ONLY");
    setStage("livePinnedIdentityVerification");
    const identity = await inspectIdentity(client);
    assertCrmForwardDevelopmentIdentity(identity);
    await client.query("COMMIT");
    return identity;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function applyPlan(
  client: PoolClient,
  registry: Registry,
  artifacts: Map<string, MigrationArtifact>,
  connectionState: { released: boolean },
  operatorConnectionUrl: string,
  setStage: StageSetter,
): Promise<string[]> {
  let lockAcquired = false;
  let operationFailure: unknown;
  try {
    setStage("advisoryLockAcquisition");
    await client.query("BEGIN");
    try {
      assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SELECT pg_advisory_lock($1::integer,$2::integer)", [...ADVISORY_LOCK_KEYS]);
      lockAcquired = true;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      fail("CRM_FORWARD_ADVISORY_LOCK_FAILED", error);
    }

    // Re-read identity and state after acquiring the session lock; another
    // forward-runner cannot race the plan between preview and execution.
    setStage("lockedReplan");
    const lockedPlan = await readOnlyPlan(client, registry, artifacts, setStage, "lockedReplan");
    setStage("preApplyRoleGate");
    const preApplyRoleGate = await inspectApplicationPreMigrationRoleGate(
      process.env,
      lockedPlan.identity,
      operatorConnectionUrl,
      mode => new Pool(buildApplicationPoolConfig(mode)),
    );

    return await runAfterCrmPreApplyRoleGate(
      async () => preApplyRoleGate,
      async () => {
        console.log(JSON.stringify({
          status: "pre-apply-app-role-verified",
          preApplyRoleGate,
        }));

        setStage("ledgerSchemaTableSetup");
        await client.query("BEGIN");
        try {
          await ensureLedger(client, registry, async () => {
            const identity = await inspectIdentity(client);
            assertCrmForwardDevelopmentIdentity(identity);
          });
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          fail("CRM_FORWARD_LEDGER_SETUP_FAILED", error);
        }

        const appliedNow: string[] = [];
        for (const migration of lockedPlan.plan.pending) {
          const sql = artifact(artifacts, migration.id).sql;
          setStage("migrationPrerequisiteCheck", migration.id);
          await client.query("BEGIN");
          try {
            assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
            const latestLedger = (await readExistingLedger(client, registry)).rows;
            if (latestLedger.some(row => !registry.migrations.some(item => item.id === row.migration_id))) {
              fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
            }
            const alreadyApplied = latestLedger.find(row => row.migration_id === migration.id);
            if (alreadyApplied) {
              if (alreadyApplied.sha256 !== artifact(artifacts, migration.id).hash) {
                fail("CRM_FORWARD_LEDGER_HASH_MISMATCH");
              }
              setStage("migrationLedgerInsertCommit", migration.id);
              await client.query("COMMIT");
              continue;
            }
            if (migration.id === EXPECTED_MIGRATIONS[1]) {
              const prerequisiteLedger = latestLedger.find(row => row.migration_id === EXPECTED_MIGRATIONS[0]);
              if (prerequisiteLedger?.sha256 !== artifact(artifacts, EXPECTED_MIGRATIONS[0]).hash) {
                fail("CRM_FORWARD_0014_LEDGER_PREREQUISITE_MISSING");
              }
              await assertCrmAssignmentSchemaPostconditions(
                client,
                "public",
                "0014",
                artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
                artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
              );
            } else if (migration.id === EXPECTED_MIGRATIONS[2]) {
              const prerequisiteLedger = latestLedger.find(row => row.migration_id === EXPECTED_MIGRATIONS[1]);
              if (prerequisiteLedger?.sha256 !== artifact(artifacts, EXPECTED_MIGRATIONS[1]).hash) {
                fail("CRM_FORWARD_0015_LEDGER_PREREQUISITE_MISSING");
              }
              await assertCrmAssignmentSchemaPostconditions(
                client,
                "public",
                "0015",
                artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
                artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
              );
              await assertCrmRuntimeAssignmentFunctionAbsent(client);
            } else if (migration.id === EXPECTED_MIGRATIONS[3]) {
              const prerequisiteLedger = latestLedger.find(row => row.migration_id === EXPECTED_MIGRATIONS[2]);
              if (prerequisiteLedger?.sha256 !== artifact(artifacts, EXPECTED_MIGRATIONS[2]).hash) {
                fail("CRM_FORWARD_0016_LEDGER_PREREQUISITE_MISSING");
              }
              await assertCrmAssignmentSchemaPostconditions(
                client,
                "public",
                "0016",
                artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
                artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
              );
              await assertCrmRuntimeRoleSeparationPostconditions(
                client,
                "public",
                artifact(artifacts, EXPECTED_MIGRATIONS[2]).sql,
              );
              await assertCrmMetaLeadAdsPrerequisites(client, "public");
              await assertCrmMetaLeadAdsSchemaAbsent(client, "public");
            } else if (migration.id === EXPECTED_MIGRATIONS[4]) {
              const prerequisiteLedger = latestLedger.find(row => row.migration_id === EXPECTED_MIGRATIONS[3]);
              if (prerequisiteLedger?.sha256 !== artifact(artifacts, EXPECTED_MIGRATIONS[3]).hash) {
                fail("CRM_FORWARD_0017_LEDGER_PREREQUISITE_MISSING");
              }
              await assertCrmMetaLeadAdsPostconditions(client, "public");
              await assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent(client, "public");
            } else {
              await assertCrmAssignmentSchemaAbsent(
                client,
                "public",
                artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
                artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
              );
            }
            await client.query("SET LOCAL search_path = public, pg_catalog");
            const executableSql = unwrapCrmMigration(sql);
            setStage("livePinnedIdentityVerification", migration.id);
            const identityBeforeWrite = await inspectIdentity(client);
            assertCrmForwardDevelopmentIdentity(identityBeforeWrite);
            // The final identity assertion is immediately before the migration SQL.
            setStage("migrationSqlExecution", migration.id);
            await client.query(executableSql);
            setStage("migrationPostcondition", migration.id);
            const completedStage = migration.id === EXPECTED_MIGRATIONS[0]
              ? "0014"
              : migration.id === EXPECTED_MIGRATIONS[1] ? "0015" : "0016";
            await assertCrmAssignmentSchemaPostconditions(
              client,
              "public",
              completedStage,
              artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
              artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
            );
            if (
              migration.id === EXPECTED_MIGRATIONS[2] ||
              migration.id === EXPECTED_MIGRATIONS[3] ||
              migration.id === EXPECTED_MIGRATIONS[4]
            ) {
              await assertCrmRuntimeRoleSeparationPostconditions(
                client,
                "public",
                artifact(artifacts, EXPECTED_MIGRATIONS[2]).sql,
              );
            }
            if (
              migration.id === EXPECTED_MIGRATIONS[3] ||
              migration.id === EXPECTED_MIGRATIONS[4]
            ) {
              await assertCrmMetaLeadAdsPostconditions(client, "public");
            }
            if (migration.id === EXPECTED_MIGRATIONS[4]) {
              await assertCrmMetaPhoneIdentityDiagnosticsPostconditions(client, "public");
            }
            assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
            setStage("migrationLedgerInsertCommit", migration.id);
            await client.query(
              `INSERT INTO ${registry.ledger.schema}.${registry.ledger.table}(migration_id,sha256) VALUES($1,$2)`,
              [migration.id, artifact(artifacts, migration.id).hash],
            );
            await client.query("COMMIT");
            appliedNow.push(migration.id);
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            fail("CRM_FORWARD_MIGRATION_FAILED", error);
          }
        }
        return appliedNow;
      },
    );
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    if (lockAcquired) {
      let unlockFailed = false;
      let unlockError: unknown;
      if (operationFailure === undefined) setStage("advisoryUnlock");
      try {
        const { rows: [row] } = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1::integer,$2::integer) AS unlocked",
          [...ADVISORY_LOCK_KEYS],
        );
        unlockFailed = row?.unlocked !== true;
      } catch (error) {
        unlockFailed = true;
        unlockError = error;
      }
      if (unlockFailed) {
        connectionState.released = true;
        client.release(new Error("CRM_FORWARD_ADVISORY_UNLOCK_FAILED"));
        if (operationFailure === undefined) {
          fail("CRM_FORWARD_ADVISORY_UNLOCK_FAILED", unlockError);
        }
      }
    }
  }
}

async function run(): Promise<void> {
  const correlationId = randomUUID();
  let currentStage: CrmForwardFailureStage = "previewPlanAssembly";
  let currentMigrationId: string | undefined;
  const setStage: StageSetter = (stage, migrationId) => {
    currentStage = stage;
    currentMigrationId = migrationId;
  };
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  const connectionState = { released: false };
  let failed = false;
  let failure: unknown;
  let output: unknown;
  let resultExitCode = 0;

  try {
    setStage("urlValidation");
    const connectionUrl = requireCrmForwardConnectionUrl(process.env);
    const effectivePort = crmForwardEffectivePort(new URL(connectionUrl));

    setStage("previewPlanAssembly");
    const mode = parseCrmForwardMigrationMode(process.argv.slice(2), process.env);
    const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as Registry;
    validateRegistry(registry);
    const artifacts = await loadArtifacts(registry);

    setStage("clientPoolConstruction");
    pool = new Pool(pgConfig(connectionUrl, effectivePort));

    setStage("tcpConnectionTlsNegotiation");
    client = await pool.connect();
    if (mode === "preflight-app-role") {
      const identity = await readPinnedDevelopmentIdentity(client, setStage);
      const preApplyRoleGate = await inspectApplicationPreMigrationRoleGate(
        process.env,
        identity,
        connectionUrl,
        mode => new Pool(buildApplicationPoolConfig(mode)),
      );
      output = {
        status: preApplyRoleGate.status,
        mode,
        pinnedDevelopmentIdentityMatches:
          preApplyRoleGate.diagnostics?.pinnedDevelopmentIdentityMatches === true,
        preApplyRoleGate,
        postMigrationRuntimeGate: "not_checked_before_crm_schema_exists",
      };
      if (preApplyRoleGate.status !== "ready") resultExitCode = 1;
    } else {
      const { identity, plan } = await readOnlyPlan(client, registry, artifacts, setStage);
      if (mode === "preview") {
        setStage("preApplyRoleGate");
        const preApplyRoleGate = await inspectApplicationPreMigrationRoleGate(
          process.env,
          identity,
          connectionUrl,
          mode => new Pool(buildApplicationPoolConfig(mode)),
        );
        setStage("finalReadiness");
        const runtimeRoleGate = await inspectApplicationRuntimeRoleGate(process.env, identity);
        output = previewRecord(
          identity,
          registry,
          plan,
          artifacts,
          mode,
          effectivePort,
          preApplyRoleGate,
          runtimeRoleGate,
        );
      } else {
        const appliedNow = await applyPlan(
          client,
          registry,
          artifacts,
          connectionState,
          connectionUrl,
          setStage,
        );
        const finalState = await readOnlyPlan(client, registry, artifacts, setStage);
        setStage("finalReadiness");
        const runtimeRoleGate = await inspectApplicationRuntimeRoleGate(process.env, finalState.identity);
        const readinessFailure = runtimeRoleGate.status === "blocked"
          ? Object.assign(
            new Error(runtimeRoleGate.reason ?? "CRM_FORWARD_FINAL_RUNTIME_READINESS_FAILED"),
            { code: runtimeRoleGate.reason ?? "CRM_FORWARD_FINAL_RUNTIME_READINESS_FAILED" },
          )
          : undefined;
        output = {
          status: runtimeRoleGate.status === "ready" ? "verified" : "runtime_role_blocked",
          stream: registry.stream,
          appliedNow,
          remaining: finalState.plan.pending.map(migration => migration.id),
          rolloutReadiness: runtimeRoleGate,
          ...(readinessFailure
            ? {
              failureDiagnostic: formatCrmForwardStageFailure(
                "finalReadiness",
                readinessFailure,
                correlationId,
              ),
            }
            : {}),
        };
        if (runtimeRoleGate.status !== "ready") resultExitCode = 1;
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      if (client && !connectionState.released) client.release();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
        setStage("clientPoolConstruction");
      }
    }
    try {
      if (pool) await pool.end();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
        setStage("clientPoolConstruction");
      }
    }
  }

  if (failed) {
    console.error(JSON.stringify(
      formatCrmForwardStageFailure(currentStage, failure, correlationId, currentMigrationId),
    ));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(output));
  process.exitCode = resultExitCode;
}

void run().catch(error => {
  console.error(JSON.stringify(
    formatCrmForwardStageFailure("previewPlanAssembly", error, "unavailable"),
  ));
  process.exitCode = 1;
});
