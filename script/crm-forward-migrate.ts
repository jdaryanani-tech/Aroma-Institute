import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  assertCrmForwardDevelopmentIdentity,
  requireCrmForwardConnectionUrl,
  type CrmForwardDatabaseIdentity,
} from "../server/db/crm-forward-migration-guard";

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

const REGISTRY_PATH = path.resolve("migrations/crm-forward/registry.json");
const EXPECTED_MIGRATIONS = [
  "0014_crm_canonical_assignments",
  "0015_crm_assignment_audit_invariants",
];
const EXPECTED_FILES = [
  "../0014_crm_canonical_assignments.sql",
  "../0015_crm_assignment_audit_invariants.sql",
];
const BASE_COLUMNS: Record<string, string[]> = {
  admissions_leads: ["id", "canonical_phone", "name"],
  lms_users: ["id", "is_active"],
  lms_user_roles: ["user_id", "role"],
};
const ASSIGNMENT_COLUMNS: Record<string, string[]> = {
  admissions_lead_assignments: ["lead_id", "assignee_user_id", "assigned_by", "updated_at", "version"],
  admissions_lead_assignment_history: [
    "id", "lead_id", "previous_assignee_user_id", "new_assignee_user_id",
    "actor_user_id", "changed_at", "reason", "source", "request_id", "assignment_version",
  ],
};
const ASSIGNMENT_TRIGGERS = [
  "admissions_lead_assignments_validate_trg",
  "admissions_lead_assignment_history_validate_trg",
  "admissions_lead_assignment_history_immutable_trg",
  "admissions_lead_assignment_history_no_truncate_trg",
];
const ASSIGNMENT_TRIGGER_TABLES: Record<string, string> = {
  admissions_lead_assignments_validate_trg: "admissions_lead_assignments",
  admissions_lead_assignment_history_validate_trg: "admissions_lead_assignment_history",
  admissions_lead_assignment_history_immutable_trg: "admissions_lead_assignment_history",
  admissions_lead_assignment_history_no_truncate_trg: "admissions_lead_assignment_history",
};
const ASSIGNMENT_TRIGGER_FUNCTIONS: Record<string, string> = {
  admissions_lead_assignments_validate_trg: "aichm_validate_lead_assignment",
  admissions_lead_assignment_history_validate_trg: "aichm_validate_lead_assignment_history",
  admissions_lead_assignment_history_immutable_trg: "aichm_reject_lead_assignment_history_mutation",
  admissions_lead_assignment_history_no_truncate_trg: "aichm_reject_lead_assignment_history_mutation",
};
const EXPECTED_0014_ITEM_COUNT =
  Object.values(ASSIGNMENT_COLUMNS).reduce((sum, columns) => sum + columns.length, 0) +
  ASSIGNMENT_TRIGGERS.length + 3;
const HARDENING_TRIGGERS = [
  "admissions_lead_assignments_history_required_trg",
  "admissions_lead_assignments_no_delete_trg",
  "admissions_lead_assignments_no_truncate_trg",
];
const HARDENING_TRIGGER_TABLES: Record<string, string> = {
  admissions_lead_assignments_history_required_trg: "admissions_lead_assignments",
  admissions_lead_assignments_no_delete_trg: "admissions_lead_assignments",
  admissions_lead_assignments_no_truncate_trg: "admissions_lead_assignments",
};
const HARDENING_TRIGGER_FUNCTIONS: Record<string, string> = {
  admissions_lead_assignments_history_required_trg: "aichm_require_assignment_history_for_change",
  admissions_lead_assignments_no_delete_trg: "aichm_reject_lead_assignment_mutation",
  admissions_lead_assignments_no_truncate_trg: "aichm_reject_lead_assignment_mutation",
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
  ) {
    fail("CRM_FORWARD_REGISTRY_INVALID");
  }
}

function pgConfig(connectionUrl: string) {
  const url = new URL(connectionUrl);
  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    application_name: "aichm_crm_forward_migration",
    ssl: { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 8_000,
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

async function triggerRows(client: Queryable, names: string[]) {
  return client.query<{
    tgname: string;
    relname: string;
    function_name: string;
    tgdeferrable: boolean;
    tginitdeferred: boolean;
    tgtype: number;
  }>(`
    SELECT t.tgname,c.relname,p.proname AS function_name,
      t.tgdeferrable,t.tginitdeferred,t.tgtype::integer
    FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname='public' AND t.tgname=ANY($1::text[]) AND NOT t.tgisinternal
  `, [names]);
}

async function requiredAssignmentStateMissing(client: Queryable): Promise<string[]> {
  const missing: string[] = [];
  const columns = Object.entries(ASSIGNMENT_COLUMNS).flatMap(([table, names]) =>
    names.map(column => ({ table, column })),
  );
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema='public'
       AND (table_name,column_name) IN (SELECT * FROM unnest($1::text[],$2::text[]))`,
    [columns.map(item => item.table), columns.map(item => item.column)],
  );
  const foundColumns = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
  for (const item of columns) {
    if (!foundColumns.has(`${item.table}.${item.column}`)) {
      missing.push(`public.${item.table}.${item.column}`);
    }
  }

  const { rows: triggers } = await triggerRows(client, ASSIGNMENT_TRIGGERS);
  const foundTriggers = new Map(triggers.map(row => [row.tgname, row]));
  for (const name of ASSIGNMENT_TRIGGERS) {
    const trigger = foundTriggers.get(name);
    if (
      !trigger ||
      trigger.relname !== ASSIGNMENT_TRIGGER_TABLES[name] ||
      trigger.function_name !== ASSIGNMENT_TRIGGER_FUNCTIONS[name]
    ) {
      missing.push(`trigger:${name}`);
    }
  }
  const { rows: functions } = await client.query<{ proname: string }>(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[])
  `, [[
    "aichm_validate_lead_assignment",
    "aichm_validate_lead_assignment_history",
    "aichm_reject_lead_assignment_history_mutation",
  ]]);
  const foundFunctions = new Set(functions.map(row => row.proname));
  for (const name of [
    "aichm_validate_lead_assignment",
    "aichm_validate_lead_assignment_history",
    "aichm_reject_lead_assignment_history_mutation",
  ]) {
    if (!foundFunctions.has(name)) missing.push(`function:${name}`);
  }
  return missing;
}

async function anyHardeningStatePresent(client: Queryable): Promise<boolean> {
  const { rows: functions } = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[])
  `, [["aichm_require_assignment_history_for_change", "aichm_reject_lead_assignment_mutation"]]);
  const { rows: triggers } = await triggerRows(client, HARDENING_TRIGGERS);
  return Number(functions[0]?.count ?? 0) > 0 || triggers.length > 0;
}

async function validateHardeningState(client: Queryable): Promise<void> {
  const missing: string[] = [];
  const { rows: triggers } = await triggerRows(client, HARDENING_TRIGGERS);
  const byName = new Map(triggers.map(row => [row.tgname, row]));
  for (const name of HARDENING_TRIGGERS) {
    const trigger = byName.get(name);
    if (
      !trigger ||
      trigger.relname !== HARDENING_TRIGGER_TABLES[name] ||
      trigger.function_name !== HARDENING_TRIGGER_FUNCTIONS[name]
    ) {
      missing.push(`trigger:${name}`);
    }
  }
  const deferred = byName.get("admissions_lead_assignments_history_required_trg");
  if (
    deferred &&
    (!deferred.tgdeferrable || !deferred.tginitdeferred ||
      (deferred.tgtype & 1) === 0 || (deferred.tgtype & 4) === 0 || (deferred.tgtype & 16) === 0)
  ) {
    missing.push("trigger:admissions_lead_assignments_history_required_trg:not_deferred");
  }
  const noDelete = byName.get("admissions_lead_assignments_no_delete_trg");
  if (noDelete && (
    (noDelete.tgtype & 1) === 0 ||
    (noDelete.tgtype & 2) === 0 ||
    (noDelete.tgtype & 8) === 0
  )) {
    missing.push("trigger:admissions_lead_assignments_no_delete_trg:event_mismatch");
  }
  const noTruncate = byName.get("admissions_lead_assignments_no_truncate_trg");
  if (noTruncate && (
    (noTruncate.tgtype & 2) === 0 ||
    (noTruncate.tgtype & 32) === 0
  )) {
    missing.push("trigger:admissions_lead_assignments_no_truncate_trg:event_mismatch");
  }
  const { rows: functions } = await client.query<{ proname: string }>(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[])
  `, [[
    "aichm_require_assignment_history_for_change",
    "aichm_reject_lead_assignment_mutation",
    "aichm_validate_lead_assignment",
    "aichm_validate_lead_assignment_history",
  ]]);
  const found = new Set(functions.map(row => row.proname));
  for (const name of ["aichm_require_assignment_history_for_change", "aichm_reject_lead_assignment_mutation"]) {
    if (!found.has(name)) missing.push(`function:${name}`);
  }
  const { rows: definitions } = await client.query<{ proname: string; definition: string }>(`
    SELECT p.proname,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[])
  `, [["aichm_validate_lead_assignment", "aichm_validate_lead_assignment_history"]]);
  const byFunction = new Map(definitions.map(row => [row.proname, row.definition]));
  const assignmentDefinition = byFunction.get("aichm_validate_lead_assignment") ?? "";
  const historyDefinition = byFunction.get("aichm_validate_lead_assignment_history") ?? "";
  if (
    !/OLD\.version\s*\+\s*1/i.test(assignmentDefinition) ||
    !/NEW\.version\s*<>\s*1/i.test(assignmentDefinition) ||
    !/assigned_by\s*=\s*NEW\.actor_user_id/i.test(historyDefinition)
  ) {
    missing.push("function:assignment_version_or_history_actor_validation");
  }
  if (missing.length) fail("CRM_FORWARD_0015_POSTCONDITION_FAILED");
}

function unwrapMigration(sql: string): string {
  const trimmed = sql.trim();
  if (!/^BEGIN;\s*/i.test(trimmed) || !/;\s*COMMIT;$/i.test(trimmed)) {
    fail("CRM_FORWARD_MIGRATION_TRANSACTION_WRAPPER_INVALID");
  }
  return trimmed.replace(/^BEGIN;\s*/i, "").replace(/;\s*COMMIT;$/i, ";");
}

async function ensureLedger(client: Queryable, registry: Registry): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${registry.ledger.schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${registry.ledger.schema}.${registry.ledger.table} (
      migration_id text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readExistingLedger(client: Queryable, registry: Registry) {
  const { rows: [table] } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`${registry.ledger.schema}.${registry.ledger.table}`],
  );
  if (!table?.exists) return [];
  const { rows } = await client.query<{ migration_id: string; sha256: string }>(
    `SELECT migration_id,sha256 FROM ${registry.ledger.schema}.${registry.ledger.table} ORDER BY migration_id`,
  );
  return rows;
}

async function run(): Promise<void> {
  const connectionUrl = requireCrmForwardConnectionUrl(process.env);
  const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as Registry;
  validateRegistry(registry);
  const migrationsRoot = path.resolve("migrations");
  const migrationSql = new Map<string, { sql: string; hash: string }>();
  for (const migration of registry.migrations) {
    const file = path.resolve(path.dirname(REGISTRY_PATH), migration.file);
    if (!file.startsWith(`${migrationsRoot}${path.sep}`)) fail("CRM_FORWARD_REGISTRY_PATH_REJECTED");
    const sql = await readFile(file, "utf8");
    migrationSql.set(migration.id, {
      sql,
      hash: createHash("sha256").update(sql).digest("hex"),
    });
  }

  const pool = new Pool(pgConfig(connectionUrl));
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query("BEGIN READ ONLY");
    assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
    const missingBase = await presentBaseTables(client);
    if (missingBase.length) fail("CRM_FORWARD_BASE_PREREQUISITES_MISSING");

    const assignmentMissing = await requiredAssignmentStateMissing(client);
    const hardeningPresent = await anyHardeningStatePresent(client);
    const existingLedgerRows = await readExistingLedger(client, registry);
    const allowedIds = new Set(registry.migrations.map(migration => migration.id));
    if (existingLedgerRows.some(row => !allowedIds.has(row.migration_id))) fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
    const existingLedger = new Map(existingLedgerRows.map(row => [row.migration_id, row.sha256]));
    const migration14 = migrationSql.get("0014_crm_canonical_assignments");
    const migration15 = migrationSql.get("0015_crm_assignment_audit_invariants");
    if (
      (existingLedger.get("0014_crm_canonical_assignments") &&
        existingLedger.get("0014_crm_canonical_assignments") !== migration14?.hash) ||
      (existingLedger.get("0015_crm_assignment_audit_invariants") &&
        existingLedger.get("0015_crm_assignment_audit_invariants") !== migration15?.hash)
    ) fail("CRM_FORWARD_LEDGER_HASH_MISMATCH");
    const recorded14 = existingLedger.has("0014_crm_canonical_assignments");
    const recorded15 = existingLedger.has("0015_crm_assignment_audit_invariants");
    if (recorded15 && !recorded14) fail("CRM_FORWARD_0014_LEDGER_PREREQUISITE_MISSING");
    if (recorded14 && assignmentMissing.length) fail("CRM_FORWARD_0014_POSTCONDITION_FAILED");
    if (!recorded14 && assignmentMissing.length === 0) fail("CRM_FORWARD_UNTRACKED_0014_STATE");
    if (
      !recorded14 &&
      assignmentMissing.length !== EXPECTED_0014_ITEM_COUNT
    ) fail("CRM_FORWARD_PARTIAL_0014_STATE");
    if (recorded15 && !hardeningPresent) fail("CRM_FORWARD_0015_POSTCONDITION_FAILED");
    if (!recorded15 && hardeningPresent) fail("CRM_FORWARD_UNTRACKED_0015_STATE");
    await client.query("COMMIT");

    await client.query("BEGIN");
    try {
      assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
      await ensureLedger(client, registry);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      fail("CRM_FORWARD_LEDGER_SETUP_FAILED");
    }
    const ledgerName = `${registry.ledger.schema}.${registry.ledger.table}`;
    const { rows: ledgerRows } = await client.query<{ migration_id: string; sha256: string }>(
      `SELECT migration_id,sha256 FROM ${ledgerName} ORDER BY migration_id`,
    );
    const allowedIds = new Set(registry.migrations.map(migration => migration.id));
    if (ledgerRows.some(row => !allowedIds.has(row.migration_id))) {
      fail("CRM_FORWARD_UNKNOWN_LEDGER_ENTRY");
    }
    const recorded = new Map(ledgerRows.map(row => [row.migration_id, row.sha256]));

    for (const migration of registry.migrations) {
      const artifact = migrationSql.get(migration.id);
      if (!artifact) fail("CRM_FORWARD_REGISTRY_INVALID");
      const recordedHash = recorded.get(migration.id);
      if (recordedHash) {
        if (recordedHash !== artifact.hash) fail("CRM_FORWARD_LEDGER_HASH_MISMATCH");
        if (migration.postconditions === "crm_assignments_v0014") {
          if ((await requiredAssignmentStateMissing(client)).length) fail("CRM_FORWARD_0014_POSTCONDITION_FAILED");
        } else {
          await validateHardeningState(client);
        }
        continue;
      }

      if (migration.id === "0015_crm_assignment_audit_invariants") {
        if (!recorded.has("0014_crm_canonical_assignments")) {
          fail("CRM_FORWARD_0014_LEDGER_PREREQUISITE_MISSING");
        }
        if ((await requiredAssignmentStateMissing(client)).length) {
          fail("CRM_FORWARD_0014_PREREQUISITES_MISSING");
        }
        if (await anyHardeningStatePresent(client)) fail("CRM_FORWARD_UNTRACKED_0015_STATE");
      } else {
        const stateMissing = await requiredAssignmentStateMissing(client);
        const hardeningExists = await anyHardeningStatePresent(client);
        if (stateMissing.length !== EXPECTED_0014_ITEM_COUNT || hardeningExists) {
          fail("CRM_FORWARD_UNTRACKED_0014_STATE");
        }
      }

      await client.query("BEGIN");
      try {
        assertCrmForwardDevelopmentIdentity(await inspectIdentity(client));
        await client.query(unwrapMigration(artifact.sql));
        if (migration.postconditions === "crm_assignments_v0014") {
          if ((await requiredAssignmentStateMissing(client)).length) fail("CRM_FORWARD_0014_POSTCONDITION_FAILED");
        } else {
          await validateHardeningState(client);
        }
        await client.query(
          `INSERT INTO ${ledgerName}(migration_id,sha256) VALUES($1,$2)`,
          [migration.id, artifact.hash],
        );
        await client.query("COMMIT");
        appliedNow.push(migration.id);
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        fail("CRM_FORWARD_MIGRATION_FAILED");
      }
      recorded.set(migration.id, artifact.hash);
    }
    console.log(JSON.stringify({
      status: "verified",
      stream: registry.stream,
      appliedNow,
      ledgerEntries: Array.from(recorded.keys()),
    }));
  } finally {
    client.release();
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  const code = error instanceof Error && /^CRM_FORWARD_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "CRM_FORWARD_FAILED";
  console.error(JSON.stringify({ status: "failed", code }));
  process.exitCode = 1;
});
