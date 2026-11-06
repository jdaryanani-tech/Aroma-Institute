import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { migrationStoreFromPool } from "../server/db/aichm-migration-postgres";
import { createAichmSourceMigrationPool } from "../server/db/aichm-source-migration";
import { createSupabaseMigrationConnection } from "../server/db/supabase-migration";
import {
  AICHM_REQUIRED_SCHEMA_VERSION,
  AICHM_TARGET_PROJECT_REF,
} from "../server/db/aichm-migration-engine";
import {
  AICHM_APP_SCHEMA_MIGRATION_VERSION,
  AICHM_CONTROL_MIGRATION_VERSION,
  AICHM_STAGE1_TABLES,
  normalizeAichmColumnDefault,
} from "../server/db/aichm-schema-stage1";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_MIGRATION_PATH = path.join(
  projectRoot,
  "supabase/migrations/20261106_aichm_migration_control_v1.sql",
);
const APP_MIGRATION_PATH = path.join(
  projectRoot,
  "supabase/migrations/20261106_aichm_app_schema_v1.sql",
);
const FORBIDDEN_ROLES = ["anon", "authenticated", "service_role"] as const;
const PRESERVED_PUBLIC_TABLES = ["leads", "conversations", "course_knowledge"] as const;
const EXPECTED_PUBLIC_COUNTS: Record<(typeof PRESERVED_PUBLIC_TABLES)[number], string> = {
  leads: "31",
  conversations: "300",
  course_knowledge: "54",
};

class Stage1GuardError extends Error {
  constructor(readonly safeCategory: string, readonly safeDetails?: Record<string, unknown>) {
    super(safeCategory);
  }
}

function stop(category: string, safeDetails?: Record<string, unknown>): never {
  throw new Stage1GuardError(category, safeDetails);
}

type Queryable = Pick<PoolClient, "query">;
type ColumnMetadata = {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_schema: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  datetime_precision: number | null;
};

function normalizeSchemaText(value: string | null): string | null {
  return value?.replace(/\bpublic\./g, "aichm.") ?? null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

async function schemaMetadata(queryable: Queryable, schema: "public" | "aichm") {
  const tableNames = [...AICHM_STAGE1_TABLES];
  const columns = await queryable.query<ColumnMetadata>(
    `SELECT table_name, column_name, ordinal_position, data_type, udt_schema, udt_name,
            is_nullable, column_default, character_maximum_length, numeric_precision,
            numeric_scale, datetime_precision
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2::text[])
     ORDER BY table_name, ordinal_position`,
    [schema, tableNames],
  );
  const normalizedColumns = columns.rows.map((row) => ({
    ...row,
    udt_schema: row.udt_schema === "public" ? "aichm" : row.udt_schema,
    column_default: normalizeAichmColumnDefault(row.column_default),
  }));

  const constraints = await queryable.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: string;
    definition: string;
    is_deferrable: boolean;
    initially_deferred: boolean;
    is_validated: boolean;
  }>(
    `SELECT c.relname AS table_name, con.conname AS constraint_name, con.contype AS constraint_type,
            pg_get_constraintdef(con.oid, true) AS definition, con.condeferrable AS is_deferrable,
            con.condeferred AS initially_deferred, con.convalidated AS is_validated
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
     ORDER BY c.relname, con.conname`,
    [schema, tableNames],
  );
  const normalizedConstraints = constraints.rows.map((row) => ({
    ...row,
    definition: normalizeSchemaText(row.definition),
  }));

  const indexes = await queryable.query<{
    tablename: string;
    indexname: string;
    indexdef: string;
  }>(
    `SELECT tablename, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = $1 AND tablename = ANY($2::text[])
     ORDER BY tablename, indexname`,
    [schema, tableNames],
  );
  const normalizedIndexes = indexes.rows.map((row) => ({
    ...row,
    indexdef: normalizeSchemaText(row.indexdef),
  }));

  const enums = await queryable.query<{
    type_name: string;
    label: string;
    sort_order: number;
  }>(
    `SELECT t.typname AS type_name, e.enumlabel AS label, e.enumsortorder AS sort_order
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = $1 AND t.typname = ANY($2::text[])
     ORDER BY t.typname, e.enumsortorder`,
    [schema, ["lms_certificate_status", "lms_content_status", "lms_enrollment_status", "lms_invitation_status", "lms_role"]],
  );

  const sequences = await queryable.query<{
    sequence_name: string;
    data_type: string;
    start_value: string;
    minimum_value: string;
    maximum_value: string;
    increment_by: string;
    cycle: boolean;
    cache_size: string;
  }>(
    `SELECT c.relname AS sequence_name, format_type(s.seqtypid, NULL) AS data_type,
            s.seqstart::text AS start_value, s.seqmin::text AS minimum_value,
            s.seqmax::text AS maximum_value, s.seqincrement::text AS increment_by,
            s.seqcycle AS cycle, s.seqcache::text AS cache_size
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_sequence s ON s.seqrelid = c.oid
     WHERE n.nspname = $1 AND c.relkind = 'S'
     ORDER BY c.relname`,
    [schema],
  );

  const constraintCounts = await queryable.query<{ constraint_type: string; count: number }>(
    `SELECT con.contype AS constraint_type, count(*)::int AS count
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
     GROUP BY con.contype ORDER BY con.contype`,
    [schema, tableNames],
  );

  return {
    columns: normalizedColumns,
    constraints: normalizedConstraints,
    indexes: normalizedIndexes,
    enums: enums.rows,
    sequences: sequences.rows,
    totals: {
      tables: new Set(normalizedColumns.map((row) => row.table_name)).size,
      columns: normalizedColumns.length,
      primaryKeys: Number(constraintCounts.rows.find((row) => row.constraint_type === "p")?.count ?? 0),
      foreignKeys: Number(constraintCounts.rows.find((row) => row.constraint_type === "f")?.count ?? 0),
      uniqueConstraints: Number(constraintCounts.rows.find((row) => row.constraint_type === "u")?.count ?? 0),
      checkConstraints: Number(constraintCounts.rows.find((row) => row.constraint_type === "c")?.count ?? 0),
      indexes: normalizedIndexes.length,
      sequences: sequences.rows.length,
    },
  };
}

async function publicCounts(queryable: Queryable): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const table of PRESERVED_PUBLIC_TABLES) {
    const result = await queryable.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public."${table}"`,
    );
    counts[table] = result.rows[0].count;
  }
  return counts;
}

async function preservedPublicPolicyCounts(queryable: Queryable): Promise<Record<string, number>> {
  const result = await queryable.query<{
    table_name: string;
    rls_enabled: boolean;
    policy_count: number;
  }>(
    `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
            count(p.oid)::int AS policy_count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND c.relkind = 'r'
     GROUP BY c.relname, c.relrowsecurity
     ORDER BY c.relname`,
    [PRESERVED_PUBLIC_TABLES],
  );
  const expectedPolicies: Record<string, number> = {
    leads: 0,
    conversations: 0,
    course_knowledge: 1,
  };
  if (
    result.rows.length !== PRESERVED_PUBLIC_TABLES.length ||
    result.rows.some((row) => !row.rls_enabled || row.policy_count !== expectedPolicies[row.table_name])
  ) {
    stop("preserved_public_policy_state_mismatch");
  }
  return Object.fromEntries(result.rows.map(({ table_name, policy_count }) => [table_name, policy_count]));
}

async function appTableRowCounts(queryable: Queryable): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const table of AICHM_STAGE1_TABLES) {
    const result = await queryable.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM aichm."${table}"`,
    );
    counts[table] = result.rows[0].count;
  }
  return counts;
}

async function assertPrivatePrivileges(queryable: Queryable): Promise<void> {
  const roles = await queryable.query<{ oid: string; rolname: string }>(
    `SELECT oid::text, rolname FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [[...FORBIDDEN_ROLES]],
  );
  if (roles.rows.length !== FORBIDDEN_ROLES.length) {
    stop("required_roles_missing");
  }
  const roleOids = roles.rows.map((row) => Number(row.oid));
  const schemaOid = await queryable.query<{ oid: string; owner: string }>(
    `SELECT n.oid::text, r.rolname AS owner
     FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
     WHERE n.nspname='aichm'`,
  );
  if (schemaOid.rows.length !== 1 || schemaOid.rows[0].owner !== "postgres") {
    stop("schema_owner_mismatch");
  }
  const privilegeRows = await queryable.query<{ forbidden_grants: string }>(
    `WITH schema_acl AS (
       SELECT x.grantee FROM pg_namespace n,
       LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) x
       WHERE n.nspname = 'aichm'
     ), object_acl AS (
       SELECT x.grantee
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
       LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) x
       WHERE n.nspname='aichm' AND c.relkind IN ('r','S')
     ), default_acl AS (
       SELECT x.grantee
       FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace,
       LATERAL aclexplode(d.defaclacl) x
       WHERE n.nspname='aichm'
     )
     SELECT (
       SELECT count(*) FROM (
         SELECT grantee FROM schema_acl UNION ALL
         SELECT grantee FROM object_acl UNION ALL
         SELECT grantee FROM default_acl
       ) acl
       WHERE grantee=0 OR grantee=ANY($1::oid[])
     )::text AS forbidden_grants`,
    [roleOids],
  );
  if (privilegeRows.rows[0]?.forbidden_grants !== "0") {
    stop("forbidden_or_public_grants");
  }
}

async function assertNoPostgrestExposureSetting(queryable: Queryable): Promise<boolean> {
  const result = await queryable.query<{ includes_aichm: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_db_role_setting s
       CROSS JOIN LATERAL unnest(s.setconfig) cfg
       WHERE cfg LIKE 'pgrst.db_schemas=%'
         AND 'aichm' = ANY(string_to_array(trim(both ' ' from split_part(cfg, '=', 2)), ','))
     ) AS includes_aichm`,
  );
  return !result.rows[0].includes_aichm;
}

async function assertApplicationTables(queryable: Queryable, sourceQueryable: Queryable) {
  const source = await schemaMetadata(sourceQueryable, "public");
  const target = await schemaMetadata(queryable, "aichm");
  for (const key of ["columns", "constraints", "indexes", "enums", "sequences", "totals"] as const) {
    if (canonicalJson(source[key]) !== canonicalJson(target[key])) {
      if (key === "columns") {
        const sourceColumns = new Map(source.columns.map((row) => [`${row.table_name}.${row.column_name}`, row]));
        const targetColumns = new Map(target.columns.map((row) => [`${row.table_name}.${row.column_name}`, row]));
        const identities = [...new Set([...sourceColumns.keys(), ...targetColumns.keys()])].sort();
        const mismatches = identities
          .map((identity) => {
            const sourceRow = sourceColumns.get(identity);
            const targetRow = targetColumns.get(identity);
            if (!sourceRow || !targetRow) {
              return { column: identity, fields: [sourceRow ? "missing_in_target" : "missing_in_source"] };
            }
            const fields = (Object.keys(sourceRow) as (keyof ColumnMetadata)[])
              .filter((field) => canonicalJson(sourceRow[field]) !== canonicalJson(targetRow[field]))
              .map(String);
            return fields.length ? { column: identity, fields } : undefined;
          })
          .filter((item): item is { column: string; fields: string[] } => Boolean(item))
          .slice(0, 8);
        stop("schema_columns_mismatch", {
          sourceColumnCount: source.columns.length,
          targetColumnCount: target.columns.length,
          mismatches,
        });
      }
      stop(`schema_${key}_mismatch`, {
        sourceItems: Array.isArray(source[key]) ? source[key].length : undefined,
        targetItems: Array.isArray(target[key]) ? target[key].length : undefined,
      });
    }
  }

  const tableResult = await queryable.query<{ table_name: string; rls_enabled: boolean; policy_count: number }>(
    `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policy_count
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='aichm' AND c.relkind='r' AND c.relname=ANY($1::text[])
     ORDER BY c.relname`,
    [AICHM_STAGE1_TABLES],
  );
  if (
    tableResult.rows.length !== AICHM_STAGE1_TABLES.length ||
    tableResult.rows.some((row) => !row.rls_enabled || row.policy_count !== 0)
  ) {
    stop("table_or_rls_policy_mismatch");
  }

  const rows = await appTableRowCounts(queryable);
  if (Object.values(rows).some((count) => count !== "0")) {
    stop("unexpected_application_rows");
  }
  await assertPrivatePrivileges(queryable);
  const postgrestUnexposed = await assertNoPostgrestExposureSetting(queryable);
  if (!postgrestUnexposed) stop("postgrest_schema_setting_exposes_aichm");
  return { source, appRowCounts: rows, postgrestUnexposed };
}

async function readSchemaAppliedVersions(queryable: Queryable): Promise<Set<string>> {
  const exists = await queryable.query<{ exists: boolean }>(
    `SELECT to_regclass('aichm.schema_migrations') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0].exists) return new Set();
  const rows = await queryable.query<{ version: string }>(
    `SELECT version FROM aichm.schema_migrations
     WHERE version = ANY($1::text[])`,
    [[AICHM_CONTROL_MIGRATION_VERSION, AICHM_APP_SCHEMA_MIGRATION_VERSION]],
  );
  return new Set(rows.rows.map((row) => row.version));
}

function assertPublicCounts(actual: Record<string, string>) {
  for (const table of PRESERVED_PUBLIC_TABLES) {
    if (actual[table] !== EXPECTED_PUBLIC_COUNTS[table]) {
      stop("preserved_public_count_mismatch");
    }
  }
}

async function main() {
  if (process.argv.slice(2).join(" ") !== "--apply-stage1-aichm-schema") {
    throw new Error("This migration requires the explicit --apply-stage1-aichm-schema flag.");
  }

  let phase = "connect_and_verify_identity";
  const targetConnection = createSupabaseMigrationConnection();
  const sourcePool: Pool = createAichmSourceMigrationPool();
  let client: PoolClient | undefined;
  let sourceClient: PoolClient | undefined;
  try {
    const targetUrl = new URL(process.env.SUPABASE_DATABASE_URL ?? "");
    const sourceUrl = new URL(process.env.AICHM_SOURCE_PROD_DATABASE_URL ?? "");
    const targetStore = migrationStoreFromPool(targetConnection.pool, {
      host: targetUrl.hostname,
      port: Number(targetUrl.port || "5432"),
      projectRef: AICHM_TARGET_PROJECT_REF,
    });
    const sourceStore = migrationStoreFromPool(sourcePool, {
      host: sourceUrl.hostname,
      port: Number(sourceUrl.port || "5432"),
    });
    const [targetIdentity, sourceIdentity] = await Promise.all([
      targetStore.identity(),
      sourceStore.identity(),
    ]);
    if (
      targetIdentity.database !== "postgres" ||
      targetIdentity.projectRef !== AICHM_TARGET_PROJECT_REF ||
      targetIdentity.isRecovery ||
      targetIdentity.isReadOnly ||
      targetIdentity.user !== "postgres" ||
      !targetIdentity.tlsAuthorized ||
      targetIdentity.tlsServername !== targetIdentity.host
    ) {
      stop("target_identity_or_tls_mismatch");
    }
    if (
      sourceIdentity.database !== "neondb" ||
      sourceIdentity.isRecovery ||
      sourceIdentity.isReadOnly ||
      !sourceIdentity.tlsAuthorized ||
      sourceIdentity.tlsServername !== sourceIdentity.host
    ) {
      stop("source_identity_or_tls_mismatch");
    }

    const controlSql = await readFile(CONTROL_MIGRATION_PATH, "utf8");
    const appSql = await readFile(APP_MIGRATION_PATH, "utf8");
    if (
      !controlSql.includes(AICHM_CONTROL_MIGRATION_VERSION) ||
      !appSql.includes(AICHM_APP_SCHEMA_MIGRATION_VERSION)
    ) {
      stop("migration_file_or_version_mismatch");
    }

    client = await targetConnection.pool.connect();
    sourceClient = await sourcePool.connect();
    await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sourceClient.query("SET search_path TO ''");
    await client.query("SET search_path TO ''");
    const publicBefore = await publicCounts(client);
    assertPublicCounts(publicBefore);
    const publicPoliciesBefore = await preservedPublicPolicyCounts(client);
    const existingSchema = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='aichm') AS exists`,
    );
    const appliedVersions = await readSchemaAppliedVersions(client);

    if (existingSchema.rows[0].exists) {
      if (
        appliedVersions.has(AICHM_CONTROL_MIGRATION_VERSION) &&
        appliedVersions.has(AICHM_APP_SCHEMA_MIGRATION_VERSION)
      ) {
        const verified = await assertApplicationTables(client, sourceClient);
        const publicAfter = await publicCounts(client);
        const publicPoliciesAfter = await preservedPublicPolicyCounts(client);
        assertPublicCounts(publicAfter);
        if (
          canonicalJson(publicBefore) !== canonicalJson(publicAfter) ||
          canonicalJson(publicPoliciesBefore) !== canonicalJson(publicPoliciesAfter)
        ) {
          throw new Error("An existing public table changed during verification.");
        }
        await sourceClient.query("ROLLBACK");
        console.log(JSON.stringify({
          applied: false,
          alreadyApplied: true,
          migrationVersions: [AICHM_CONTROL_MIGRATION_VERSION, AICHM_APP_SCHEMA_MIGRATION_VERSION],
          applicationTables: AICHM_STAGE1_TABLES.length,
          sourceStructureCounts: verified.source.totals,
          applicationRows: 0,
          preservedPublicCounts: publicAfter,
          preservedPublicPolicyCounts: publicPoliciesAfter,
          publicTablesUnchanged: true,
          postgrestSettingExcludesAichm: verified.postgrestUnexposed,
        }));
        return;
      }
      throw new Error("AICHM exists without the complete Stage 1 migration history; refusing partial state.");
    }
    if (appliedVersions.size) {
      throw new Error("AICHM migration history exists without its schema; refusing inconsistent state.");
    }

    phase = "apply_additive_schema_transaction";
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(617206112026::bigint)");
    const lockedSchema = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='aichm') AS exists`,
    );
    if (lockedSchema.rows[0].exists) {
      stop("concurrent_schema_creation");
    }
    await client.query(controlSql);
    await client.query(appSql);

    const verified = await assertApplicationTables(client, sourceClient);
    const controlCounts = await client.query<{ table_name: string; row_count: string }>(
      `SELECT table_name, row_count::text FROM (
         SELECT 'migration_checkpoints' AS table_name, count(*) AS row_count FROM aichm.migration_checkpoints
         UNION ALL
         SELECT 'migration_crosswalk', count(*) FROM aichm.migration_crosswalk
       ) controls ORDER BY table_name`,
    );
    if (controlCounts.rows.some((row) => row.row_count !== "0")) {
      stop("unexpected_control_table_rows");
    }
    const versions = await readSchemaAppliedVersions(client);
    if (
      !versions.has(AICHM_CONTROL_MIGRATION_VERSION) ||
      !versions.has(AICHM_APP_SCHEMA_MIGRATION_VERSION)
    ) {
      stop("migration_ledger_mismatch");
    }

    const publicAfter = await publicCounts(client);
    const publicPoliciesAfter = await preservedPublicPolicyCounts(client);
    assertPublicCounts(publicAfter);
    if (
      canonicalJson(publicBefore) !== canonicalJson(publicAfter) ||
      canonicalJson(publicPoliciesBefore) !== canonicalJson(publicPoliciesAfter)
    ) {
      stop("public_table_state_changed");
    }

    await client.query("COMMIT");
    client.release(true);
    client = undefined;
    await sourceClient.query("ROLLBACK");
    sourceClient.release();
    sourceClient = undefined;

    phase = "post_commit_verification";
    const verificationClient = await targetConnection.pool.connect();
    const sourceVerificationClient = await sourcePool.connect();
    try {
      await sourceVerificationClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await sourceVerificationClient.query("SET search_path TO ''");
      await verificationClient.query("SET search_path TO ''");
      const postCommit = await assertApplicationTables(verificationClient, sourceVerificationClient);
      const postCommitPublic = await publicCounts(verificationClient);
      const postCommitPublicPolicies = await preservedPublicPolicyCounts(verificationClient);
      assertPublicCounts(postCommitPublic);
      if (
        canonicalJson(publicBefore) !== canonicalJson(postCommitPublic) ||
        canonicalJson(publicPoliciesBefore) !== canonicalJson(postCommitPublicPolicies)
      ) {
        stop("post_commit_public_table_mismatch");
      }
      const ledger = await verificationClient.query<{ version: string; migration_name: string }>(
        `SELECT version, migration_name FROM aichm.schema_migrations
         WHERE version = ANY($1::text[]) ORDER BY version`,
        [[AICHM_CONTROL_MIGRATION_VERSION, AICHM_APP_SCHEMA_MIGRATION_VERSION]],
      );
      console.log(JSON.stringify({
        applied: true,
        migrationVersions: ledger.rows.map((row) => row.version),
        applicationTableCount: AICHM_STAGE1_TABLES.length,
        applicationRows: 0,
        schemaStructure: postCommit.source.totals,
        preservedPublicCounts: postCommitPublic,
        preservedPublicPolicyCounts: postCommitPublicPolicies,
        publicTablesUnchanged: true,
        postgrestSettingExcludesAichm: postCommit.postgrestUnexposed,
        controlTablesEmpty: true,
        rowDataCopied: false,
      }));
    } finally {
      verificationClient.release();
      await sourceVerificationClient.query("ROLLBACK").catch(() => undefined);
      sourceVerificationClient.release();
    }
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    const category = error instanceof Stage1GuardError
      ? error.safeCategory
      : error && typeof error === "object" && "code" in error
        ? String(error.code).replace(/[^A-Z0-9_]/gi, "").slice(0, 24)
        : "stage1_migration_guard";
    console.error(JSON.stringify({
      applied: false,
      phase,
      errorCategory: category,
      safeDetails: error instanceof Stage1GuardError ? error.safeDetails : undefined,
      detailsRedacted: true,
    }));
    process.exitCode = 2;
  } finally {
    if (client) client.release(true);
    if (sourceClient) {
      await sourceClient.query("ROLLBACK").catch(() => undefined);
      sourceClient.release();
    }
    await Promise.allSettled([sourcePool.end(), targetConnection.pool.end()]);
  }
}

main().catch(() => {
  console.error(JSON.stringify({ applied: false, errorCategory: "stage1_migration_preflight", detailsRedacted: true }));
  process.exitCode = 2;
});
