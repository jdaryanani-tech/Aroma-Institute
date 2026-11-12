import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  formatCrmForwardStageFailure,
  type CrmForwardFailureStage,
} from "../server/db/crm-forward-migration-diagnostics";
import {
  assertCrmAssignmentSchemaAbsent,
  assertCrmAssignmentSchemaPostconditions,
} from "../server/db/crm-forward-migration-postconditions";
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
type StageSetter = (stage: CrmForwardFailureStage) => void;

const REGISTRY_PATH = path.resolve("migrations/crm-forward/registry.json");
const EXPECTED_MIGRATIONS = [
  "0014_crm_canonical_assignments",
  "0015_crm_assignment_audit_invariants",
];
const EXPECTED_FILES = [
  "../0014_crm_canonical_assignments.sql",
  "../0015_crm_assignment_audit_invariants.sql",
];
const ADVISORY_LOCK_KEYS = [1095326536, 1128813875] as const;
const BASE_COLUMNS: Record<string, string[]> = {
  admissions_leads: ["id", "canonical_phone", "name"],
  lms_users: ["id", "is_active"],
  lms_user_roles: ["user_id", "role"],
};

function fail(code: string): never {
  throw new Error(code);
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
  ];
  if (
    registry.stream !== "aichm-crm-forward" ||
    registry.ledger.schema !== "aichm_crm_forward_meta" ||
    registry.ledger.table !== "schema_migrations" ||
    registry.migrations.length !== EXPECTED_MIGRATIONS.length ||
    registry.migrations.some((migration, index) =>
      migration.id !== EXPECTED_MIGRATIONS[index] ||
      migration.file !== EXPECTED_FILES[index] ||
      migration.postconditions !== (index === 0 ? "crm_assignments_v0014" : "crm_assignment_invariants_v0015") ||
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
  const { rows: [table] } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [regclass],
  );
  if (!table?.exists) return [];
  const { rows } = await client.query<{ migration_id: string; sha256: string }>(
    `SELECT migration_id,sha256 FROM ${registry.ledger.schema}.${registry.ledger.table} ORDER BY migration_id`,
  );
  return rows;
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

function unwrapMigration(sql: string): string {
  const trimmed = sql.trim();
  if (!/^BEGIN;\s*/i.test(trimmed) || !/;\s*COMMIT;$/i.test(trimmed)) {
    fail("CRM_FORWARD_MIGRATION_TRANSACTION_WRAPPER_INVALID");
  }
  return trimmed.replace(/^BEGIN;\s*/i, "").replace(/;\s*COMMIT;$/i, ";");
}

async function collectPlan(
  client: Queryable,
  registry: Registry,
  artifacts: Map<string, MigrationArtifact>,
  setStage: StageSetter,
): Promise<{
  ledger: Map<string, string>;
  pending: Migration[];
  basePrerequisites: "present";
  schemaState: "absent" | "0014_complete" | "0014_0015_complete";
  runtimeAccess: Awaited<ReturnType<typeof inspectReadOnlyRuntimeAccess>>;
}> {
  setStage("prerequisiteSchemaDriftInspection");
  const missingBase = await presentBaseTables(client);
  if (missingBase.length) fail("CRM_FORWARD_BASE_PREREQUISITES_MISSING");
  const runtimeAccess = await inspectReadOnlyRuntimeAccess(client);

  setStage("migrationLedgerRead");
  const rows = await readExistingLedger(client, registry);
  const allowed = new Set(registry.migrations.map(migration => migration.id));
  if (rows.some(row => !allowed.has(row.migration_id))) fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
  const ledger = new Map(rows.map(row => [row.migration_id, row.sha256]));
  for (const migration of registry.migrations) {
    const recordedHash = ledger.get(migration.id);
    if (recordedHash && recordedHash !== artifact(artifacts, migration.id).hash) {
      fail("CRM_FORWARD_LEDGER_HASH_MISMATCH");
    }
  }

  const recorded14 = ledger.has(EXPECTED_MIGRATIONS[0]);
  const recorded15 = ledger.has(EXPECTED_MIGRATIONS[1]);
  setStage("prerequisiteSchemaDriftInspection");
  if (recorded15 && !recorded14) fail("CRM_FORWARD_0014_LEDGER_PREREQUISITE_MISSING");
  if (!recorded14) {
    if (rows.length) fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
    await assertCrmAssignmentSchemaAbsent(
      client,
      "public",
      artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
      artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
    );
  } else {
    await assertCrmAssignmentSchemaPostconditions(
      client,
      "public",
      recorded15 ? "0015" : "0014",
      artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
      artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
    );
  }

  setStage("previewPlanAssembly");
  return {
    ledger,
    pending: registry.migrations.filter(migration => !ledger.has(migration.id)),
    basePrerequisites: "present",
    schemaState: !recorded14
      ? "absent"
      : recorded15
        ? "0014_0015_complete"
        : "0014_complete",
    runtimeAccess,
  };
}

function previewRecord(
  identity: CrmForwardDatabaseIdentity,
  registry: Registry,
  plan: Awaited<ReturnType<typeof collectPlan>>,
  artifacts: Map<string, MigrationArtifact>,
  mode: CrmForwardMigrationMode,
  effectivePort: number,
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
    schemaAssessment: {
      basePrerequisites: plan.basePrerequisites,
      crmAssignments: plan.schemaState,
      conflicts: "none",
      postconditionsVerified: true,
    },
    runtimeAccess: plan.runtimeAccess,
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
) {
  setStage("readOnlyTransactionStart");
  try {
    await client.query("BEGIN READ ONLY");
    setStage("livePinnedIdentityVerification");
    const identity = await inspectIdentity(client);
    assertCrmForwardDevelopmentIdentity(identity);
    const plan = await collectPlan(client, registry, artifacts, setStage);
    setStage("previewPlanAssembly");
    await client.query("COMMIT");
    return { identity, plan };
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
  effectivePort: number,
  setStage: StageSetter,
): Promise<string[]> {
  let lockAcquired = false;
  try {
    await client.query("BEGIN");
    try {
      assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SELECT pg_advisory_lock($1::integer,$2::integer)", [...ADVISORY_LOCK_KEYS]);
      lockAcquired = true;
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      fail("CRM_FORWARD_ADVISORY_LOCK_FAILED");
    }

    // Re-read identity and state after acquiring the session lock; another
    // forward-runner cannot race the plan between preview and execution.
    const lockedPlan = await readOnlyPlan(client, registry, artifacts, setStage);
    console.log(JSON.stringify(previewRecord(
      lockedPlan.identity,
      registry,
      lockedPlan.plan,
      artifacts,
      "apply",
      effectivePort,
    )));

    await client.query("BEGIN");
    try {
      await ensureLedger(client, registry, async () => {
        assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
      });
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      fail("CRM_FORWARD_LEDGER_SETUP_FAILED");
    }

    const appliedNow: string[] = [];
    for (const migration of lockedPlan.plan.pending) {
      const sql = artifact(artifacts, migration.id).sql;
      await client.query("BEGIN");
      try {
        assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
        const latestLedger = await readExistingLedger(client, registry);
        if (latestLedger.some(row => !registry.migrations.some(item => item.id === row.migration_id))) {
          fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
        }
        const alreadyApplied = latestLedger.find(row => row.migration_id === migration.id);
        if (alreadyApplied) {
          if (alreadyApplied.sha256 !== artifact(artifacts, migration.id).hash) {
            fail("CRM_FORWARD_LEDGER_HASH_MISMATCH");
          }
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
        } else {
          await assertCrmAssignmentSchemaAbsent(
            client,
            "public",
            artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
            artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
          );
        }
        await client.query("SET LOCAL search_path = public, pg_catalog");
        // The final identity assertion is immediately before the migration SQL.
        assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
        await client.query(unwrapMigration(sql));
        const completedStage = migration.id === EXPECTED_MIGRATIONS[0] ? "0014" : "0015";
        await assertCrmAssignmentSchemaPostconditions(
          client,
          "public",
          completedStage,
          artifact(artifacts, EXPECTED_MIGRATIONS[0]).sql,
          artifact(artifacts, EXPECTED_MIGRATIONS[1]).sql,
        );
        assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
        await client.query(
          `INSERT INTO ${registry.ledger.schema}.${registry.ledger.table}(migration_id,sha256) VALUES($1,$2)`,
          [migration.id, artifact(artifacts, migration.id).hash],
        );
        await client.query("COMMIT");
        appliedNow.push(migration.id);
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        fail("CRM_FORWARD_MIGRATION_FAILED");
      }
    }
    return appliedNow;
  } finally {
    if (lockAcquired) {
      let unlockFailed = false;
      try {
        const { rows: [row] } = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1::integer,$2::integer) AS unlocked",
          [...ADVISORY_LOCK_KEYS],
        );
        unlockFailed = row?.unlocked !== true;
      } catch {
        unlockFailed = true;
      }
      if (unlockFailed) {
        connectionState.released = true;
        client.release(new Error("CRM_FORWARD_ADVISORY_UNLOCK_FAILED"));
        fail("CRM_FORWARD_ADVISORY_UNLOCK_FAILED");
      }
    }
  }
}

async function run(): Promise<void> {
  const correlationId = randomUUID();
  let currentStage: CrmForwardFailureStage = "previewPlanAssembly";
  const setStage: StageSetter = stage => {
    currentStage = stage;
  };
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  const connectionState = { released: false };
  let failed = false;
  let failure: unknown;
  let output: unknown;

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
    const { identity, plan } = await readOnlyPlan(client, registry, artifacts, setStage);
    if (mode === "preview") {
      setStage("previewPlanAssembly");
      output = previewRecord(identity, registry, plan, artifacts, mode, effectivePort);
    } else {
      const appliedNow = await applyPlan(
        client,
        registry,
        artifacts,
        connectionState,
        effectivePort,
        setStage,
      );
      const finalState = await readOnlyPlan(client, registry, artifacts, setStage);
      setStage("previewPlanAssembly");
      output = {
        status: "verified",
        stream: registry.stream,
        appliedNow,
        remaining: finalState.plan.pending.map(migration => migration.id),
      };
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
      formatCrmForwardStageFailure(currentStage, failure, correlationId),
    ));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(output));
}

void run().catch(error => {
  console.error(JSON.stringify(
    formatCrmForwardStageFailure("previewPlanAssembly", error, "unavailable"),
  ));
  process.exitCode = 1;
});
