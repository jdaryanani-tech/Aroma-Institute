import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AICHM_COPY_TABLES,
  AICHM_REQUIRED_SCHEMA_VERSION,
  AICHM_TARGET_PROJECT_REF,
  AICHM_TRANSFORM_SET_VERSION,
  assertApplyPrerequisites,
  assertDatabaseIdentities,
  assertNoSecretInAuditEntry,
  canonicalize,
  migrationSchemaFingerprint,
  runAichmMigration,
  signedDocumentContentChecksum,
  transformMigrationRow,
  type BackupManifest,
  type DatabaseIdentity,
  type DbRow,
  type MigrationCheckpoint,
  type MigrationStore,
  type MigrationTransaction,
  type OwnerApprovalManifest,
  type ReconciliationManifest,
  type SchemaVersionManifest,
  type SignedDocument,
  type TableMetadata,
} from "./aichm-migration-engine";

const sourceIdentity: DatabaseIdentity = {
  database: "neondb",
  user: "migration_operator",
  host: "replit-production.example",
  port: 5432,
  isRecovery: false,
  isReadOnly: false,
  tlsAuthorized: true,
  tlsServername: "replit-production.example",
};

const targetIdentity: DatabaseIdentity = {
  database: "postgres",
  user: "migration_operator",
  host: "aws-0-ap-northeast-1.pooler.supabase.com",
  port: 5432,
  isRecovery: false,
  isReadOnly: false,
  projectRef: AICHM_TARGET_PROJECT_REF,
  tlsAuthorized: true,
  tlsServername: "aws-0-ap-northeast-1.pooler.supabase.com",
};

const { publicKey: generatedPublicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKey = generatedPublicKey.export({ type: "spki", format: "pem" }).toString();
const now = new Date("2026-11-06T12:00:00.000Z");
const RUN_IDS = {
  synthetic: "00000000-0000-4000-8000-000000000001",
  collision: "00000000-0000-4000-8000-000000000002",
  secret: "00000000-0000-4000-8000-000000000003",
  resume: "00000000-0000-4000-8000-000000000004",
  rerun: "00000000-0000-4000-8000-000000000005",
  auth: "00000000-0000-4000-8000-000000000006",
  schema: "00000000-0000-4000-8000-000000000007",
  crosswalk: "00000000-0000-4000-8000-000000000008",
};

function signed<T>(document: T): SignedDocument<T> {
  return {
    document,
    signature: sign(null, Buffer.from(canonicalize(document)), privateKey).toString("base64"),
  };
}

function validManifests(): {
  backupManifest: BackupManifest;
  reconciliation: SignedDocument<ReconciliationManifest>;
  schemaVersion: SignedDocument<SchemaVersionManifest>;
  ownerApproval: SignedDocument<OwnerApprovalManifest>;
} {
  const backupManifest: BackupManifest = {
    version: 1,
    source: {
      environment: "production-source",
      artifactId: "private-source-backup-2026-11-06",
      sha256: "a".repeat(64),
      sizeBytes: 100,
      createdAt: "2026-11-06T10:00:00.000Z",
      restoreTest: {
        verified: true,
        restoreArtifactId: "source-restore-test",
        completedAt: "2026-11-06T10:30:00.000Z",
        isolatedTargetId: "isolated-source-test",
      },
    },
    target: {
      environment: "supabase-target",
      artifactId: "private-target-backup-2026-11-06",
      sha256: "b".repeat(64),
      sizeBytes: 200,
      createdAt: "2026-11-06T10:00:00.000Z",
      restoreTest: {
        verified: true,
        restoreArtifactId: "target-restore-test",
        completedAt: "2026-11-06T10:30:00.000Z",
        isolatedTargetId: "isolated-target-test",
      },
    },
  };
  const reconciliation = signed<ReconciliationManifest>({
    version: 1,
    sourceDatabase: "neondb",
    targetProjectRef: AICHM_TARGET_PROJECT_REF,
    items: [],
  });
  const fingerprint = migrationSchemaFingerprint(
    AICHM_COPY_TABLES.map((mapping) => ({
      schema: mapping.sourceSchema,
      table: mapping.sourceTable,
      metadata,
    })),
  );
  const targetFingerprint = migrationSchemaFingerprint(
    AICHM_COPY_TABLES.map((mapping) => ({
      schema: mapping.targetSchema,
      table: mapping.targetTable,
      metadata,
    })),
  );
  const schemaDocument: SchemaVersionManifest = {
    version: 1,
    targetSchema: "aichm",
    migrationVersion: AICHM_REQUIRED_SCHEMA_VERSION,
    transformSetVersion: AICHM_TRANSFORM_SET_VERSION,
    compatible: true,
    sourceFingerprint: fingerprint,
    targetFingerprint,
    requiredTablesPresent: true,
  };
  const schemaVersion = signed(schemaDocument);
  const ownerDocument: OwnerApprovalManifest = {
    version: 1,
    scope: "aichm-production-database-migration",
    approved: true,
    approvedBy: "owner",
    approvedAt: "2026-11-06T11:00:00.000Z",
    sourceDatabase: "neondb",
    targetProjectRef: AICHM_TARGET_PROJECT_REF,
    backupManifestChecksum: signedDocumentContentChecksum(backupManifest),
    reconciliationManifestChecksum: signedDocumentContentChecksum(reconciliation.document),
    schemaVersionManifestChecksum: signedDocumentContentChecksum(schemaDocument),
  };
  return { backupManifest, reconciliation, schemaVersion, ownerApproval: signed(ownerDocument) };
}

function validPrerequisites(overrides: Record<string, unknown> = {}) {
  const manifests = validManifests();
  return {
    flags: { apply: true, productionCutover: true },
    runtimeEnvironment: "production",
    environment: {
      AICHM_SOURCE_PROD_DATABASE_URL: "configured",
      SUPABASE_DATABASE_URL: "configured",
      SUPABASE_DB_SSL_CA: "configured",
      AICHM_BACKUP_ENCRYPTION_KEY: "synthetic-test-key-material-".padEnd(48, "x"),
      AICHM_MIGRATION_APPROVAL_PUBLIC_KEY: publicKey,
    },
    ...manifests,
    approvalPublicKey: publicKey,
    sourceIdentity,
    targetIdentity,
    sourceLeadIds: [],
    sourceLmsUserIds: [],
    now,
    ...overrides,
  };
}

const metadata: TableMetadata = {
  columns: [
    { name: "id", dataType: "text", nullable: false, hasDefault: false, ordinal: 1 },
    { name: "value", dataType: "text", nullable: true, hasDefault: false, ordinal: 2 },
    { name: "password_hash", dataType: "text", nullable: true, hasDefault: false, ordinal: 3 },
    { name: "email", dataType: "text", nullable: true, hasDefault: false, ordinal: 4 },
    { name: "user_id", dataType: "integer", nullable: true, hasDefault: false, ordinal: 5 },
    { name: "role", dataType: "text", nullable: true, hasDefault: false, ordinal: 6 },
  ],
  primaryKey: ["id"],
  uniqueKeys: [["id"], ["email"]],
};

class FakeStore implements MigrationStore {
  readonly rows = new Map<string, DbRow[]>();
  readonly checkpoints = new Map<string, MigrationCheckpoint>();
  readonly crosswalk = new Map<string, Record<string, unknown>>();
  failOnId: string | null = null;
  writes = 0;

  constructor(readonly dbIdentity: DatabaseIdentity) {}

  identity() {
    return Promise.resolve(this.dbIdentity);
  }
  schemaVersion() {
    return Promise.resolve(AICHM_REQUIRED_SCHEMA_VERSION);
  }
  alignSequences() {
    return Promise.resolve(0);
  }
  inspectTable(_schema: string, table: string) {
    if (table === "schema_migrations") {
      return Promise.resolve({ ...metadata, columns: [{ ...metadata.columns[0], name: "version" }] });
    }
    return Promise.resolve(metadata);
  }
  scanRows(_schema: string, table: string, afterKey: Record<string, unknown> | null, _pk: string[], limit: number) {
    const rows = [...(this.rows.get(table) ?? [])].sort((left, right) =>
      String(left.id).localeCompare(String(right.id), undefined, { numeric: true }),
    );
    const filtered = afterKey ? rows.filter((row) => String(row.id) > String(afterKey.id)) : rows;
    return Promise.resolve(filtered.slice(0, limit).map((row) => structuredClone(row)));
  }
  readCheckpoint(runId: string, table: string) {
    return Promise.resolve(this.checkpoints.get(`${runId}:${table}`) ?? null);
  }
  async transaction<T>(callback: (transaction: MigrationTransaction) => Promise<T>): Promise<T> {
    const rowSnapshot = structuredClone([...this.rows.entries()]);
    const checkpointSnapshot = structuredClone([...this.checkpoints.entries()]);
    const crosswalkSnapshot = structuredClone([...this.crosswalk.entries()]);
    const transaction: MigrationTransaction = {
      findByKey: async (_schema, table, key) => {
        const found = (this.rows.get(table) ?? []).find((row) =>
          Object.entries(key).every(([column, value]) => row[column] === value),
        );
        return found ? structuredClone(found) : null;
      },
      findByUniqueKeys: async (_schema, table, row, keys) => {
        for (const key of keys) {
          const found = (this.rows.get(table) ?? []).find((candidate) =>
            key.every((column) => row[column] !== null && row[column] !== undefined && candidate[column] === row[column]),
          );
          if (found) return { row: structuredClone(found), key };
        }
        return null;
      },
      insertIgnore: async (_schema, table, row) => {
        if (this.failOnId && row.id === this.failOnId) throw new Error("synthetic transaction failure");
        const current = this.rows.get(table) ?? [];
        if (current.some((candidate) => candidate.id === row.id || (row.email && candidate.email === row.email))) return false;
        this.rows.set(table, [...current, structuredClone(row)]);
        this.writes++;
        return true;
      },
      saveCheckpoint: async (runId, table, checkpoint) => {
        const key = `${runId}:${table}`;
        const previous = this.checkpoints.get(key);
        this.checkpoints.set(key, {
          ...checkpoint,
          rowCount: (previous?.rowCount ?? 0) + checkpoint.rowCount,
        });
        this.writes++;
      },
      saveCrosswalk: async (value) => {
        this.crosswalk.set(`${value.sourceTable}:${JSON.stringify(value.sourceKey)}`, value);
        this.writes++;
      },
    };
    try {
      return await callback(transaction);
    } catch (error) {
      this.rows.clear();
      for (const [key, value] of rowSnapshot) this.rows.set(key, value);
      this.checkpoints.clear();
      for (const [key, value] of checkpointSnapshot) this.checkpoints.set(key, value);
      this.crosswalk.clear();
      for (const [key, value] of crosswalkSnapshot) this.crosswalk.set(key, value);
      throw error;
    }
  }
}

function makeStores(rows: Record<string, DbRow[]> = {}) {
  const source = new FakeStore(sourceIdentity);
  const target = new FakeStore(targetIdentity);
  for (const mapping of AICHM_COPY_TABLES) {
    source.rows.set(mapping.sourceTable, structuredClone(rows[mapping.sourceTable] ?? []));
    target.rows.set(mapping.targetTable, []);
  }
  target.rows.set("migration_checkpoints", []);
  target.rows.set("migration_crosswalk", []);
  return { source, target };
}

function signedReconciliation(items: ReconciliationManifest["items"]) {
  return signed<ReconciliationManifest>({
    version: 1,
    sourceDatabase: "neondb",
    targetProjectRef: AICHM_TARGET_PROJECT_REF,
    items,
  });
}

async function withProductionMode<T>(callback: () => Promise<T>): Promise<T> {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return await callback();
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
}

test("copy allowlist is FK ordered and excludes preserved, transient and Calendar tables", () => {
  const positions = new Map(AICHM_COPY_TABLES.map((entry, index) => [entry.sourceTable, index]));
  for (const entry of AICHM_COPY_TABLES) {
    for (const dependency of entry.dependsOn) {
      assert.ok(positions.get(dependency)! < positions.get(entry.sourceTable)!);
    }
  }
  for (const protectedName of ["leads", "conversations", "course_knowledge"]) {
    assert.equal(AICHM_COPY_TABLES.some((entry) => entry.targetTable === protectedName), false);
  }
  for (const deferred of ["sessions", "lms_auth_rate_limits", "lms_password_setup_tokens", "lms_otp_challenges"]) {
    assert.equal(AICHM_COPY_TABLES.some((entry) => entry.sourceTable === deferred), false);
  }
  assert.equal(AICHM_COPY_TABLES.some((entry) => entry.sourceTable.startsWith("calendar_")), false);
  const sourcePath = fileURLToPath(new URL("../../docs/aichm-supabase-migration-prep/supabase-migration-control-schema.sql", import.meta.url));
  const controlSql = readFileSync(sourcePath, "utf8");
  assert.match(controlSql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(controlSql, /REVOKE ALL ON SCHEMA aichm FROM PUBLIC/);
  assert.match(controlSql, /REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM authenticated/);
  assert.doesNotMatch(controlSql, /CREATE POLICY/i);
});

test("identity guard rejects a same database, a replica, unverified TLS and wrong Supabase project", () => {
  assert.throws(() => assertDatabaseIdentities(sourceIdentity, { ...targetIdentity, database: "neondb", host: sourceIdentity.host }), /same database/);
  assert.throws(() => assertDatabaseIdentities({ ...sourceIdentity, isRecovery: true }, targetIdentity), /production primary/);
  assert.throws(() => assertDatabaseIdentities({ ...sourceIdentity, isReadOnly: true }, targetIdentity), /production primary/);
  assert.throws(() => assertDatabaseIdentities({ ...sourceIdentity, tlsAuthorized: false }, targetIdentity), /production primary/);
  assert.throws(() => assertDatabaseIdentities(sourceIdentity, { ...targetIdentity, tlsAuthorized: false }), /strict TLS/);
  assert.throws(() => assertDatabaseIdentities(sourceIdentity, { ...targetIdentity, isReadOnly: true }), /strict TLS/);
  assert.throws(() => assertDatabaseIdentities(sourceIdentity, { ...targetIdentity, projectRef: "wrong" }), /strict TLS/);
});

test("apply fails closed when either explicit flag, runtime mode, or any required secret is missing", () => {
  assert.doesNotThrow(() => assertApplyPrerequisites(validPrerequisites()));
  assert.throws(
    () => assertApplyPrerequisites(validPrerequisites({ flags: { apply: true, productionCutover: false } })),
    /distinct --apply and --production-cutover/,
  );
  assert.throws(
    () => assertApplyPrerequisites(validPrerequisites({ flags: { apply: false, productionCutover: true } })),
    /distinct --apply and --production-cutover/,
  );
  for (const runtimeEnvironment of ["development", "test", ""]) {
    assert.throws(() => assertApplyPrerequisites(validPrerequisites({ runtimeEnvironment })), /exact production runtime/);
  }
  assert.throws(
    () => assertApplyPrerequisites(validPrerequisites({ sourceIdentity: undefined })),
    /Verified source and target database identities/,
  );
  for (const key of [
    "AICHM_SOURCE_PROD_DATABASE_URL",
    "SUPABASE_DATABASE_URL",
    "SUPABASE_DB_SSL_CA",
    "AICHM_BACKUP_ENCRYPTION_KEY",
    "AICHM_MIGRATION_APPROVAL_PUBLIC_KEY",
  ]) {
    const input = validPrerequisites();
    input.environment[key] = undefined;
    assert.throws(() => assertApplyPrerequisites(input), new RegExp(`${key} is required`));
  }
});

test("apply requires independently restorable backups and valid backup metadata", () => {
  assert.throws(() => assertApplyPrerequisites(validPrerequisites({ backupManifest: undefined })), /backup manifest is required/);
  for (const change of [
    (manifest: BackupManifest) => { manifest.source.restoreTest.verified = false; },
    (manifest: BackupManifest) => { manifest.target.sha256 = "invalid"; },
    (manifest: BackupManifest) => { manifest.source.sizeBytes = 0; },
    (manifest: BackupManifest) => { manifest.target.restoreTest.isolatedTargetId = ""; },
  ]) {
    const input = validPrerequisites();
    change(input.backupManifest!);
    assert.throws(() => assertApplyPrerequisites(input), /backups must have checksums/);
  }
});

test("apply requires valid signed reconciliation, schema and owner approval bound to exact manifests", () => {
  for (const key of ["reconciliation", "schemaVersion", "ownerApproval"]) {
    assert.throws(() => assertApplyPrerequisites(validPrerequisites({ [key]: undefined })), /signed approval is required/);
  }
  const invalidSignature = validPrerequisites();
  invalidSignature.ownerApproval!.signature = Buffer.alloc(64).toString("base64");
  assert.throws(() => assertApplyPrerequisites(invalidSignature), /signature verification failed/);

  const changedBackup = validPrerequisites();
  changedBackup.backupManifest!.source.sizeBytes++;
  assert.throws(() => assertApplyPrerequisites(changedBackup), /does not cover the exact backup/);

  const incompatibleSchema = validPrerequisites();
  const schemaDocument = {
    ...incompatibleSchema.schemaVersion!.document,
    migrationVersion: "old-version",
  };
  incompatibleSchema.schemaVersion = signed(schemaDocument);
  const ownerDocument = {
    ...incompatibleSchema.ownerApproval!.document,
    schemaVersionManifestChecksum: signedDocumentContentChecksum(schemaDocument),
  };
  incompatibleSchema.ownerApproval = signed(ownerDocument);
  assert.throws(() => assertApplyPrerequisites(incompatibleSchema), /schema compatibility manifest/);
});

test("reconciliation must cover every lead and custom-auth user exactly once", () => {
  const input = validPrerequisites({
    sourceLeadIds: ["lead-1"],
    sourceLmsUserIds: [7],
  });
  assert.throws(() => assertApplyPrerequisites(input), /does not resolve every admissions lead/);
  const withItems = validPrerequisites({
    sourceLeadIds: ["lead-1"],
    sourceLmsUserIds: [7],
  });
  withItems.reconciliation = signedReconciliation([
    {
      sourceTable: "admissions_leads",
      sourceKey: { id: "lead-1" },
      decision: "create-distinct",
      reviewer: "owner",
      reviewedAt: "2026-11-06T11:00:00.000Z",
    },
    {
      sourceTable: "lms_users",
      sourceKey: { id: 7 },
      decision: "preserve-custom-auth",
      reviewer: "owner",
      reviewedAt: "2026-11-06T11:00:00.000Z",
    },
  ]);
  const ownerDoc = {
    ...withItems.ownerApproval!.document,
    reconciliationManifestChecksum: signedDocumentContentChecksum(withItems.reconciliation!.document),
  };
  withItems.ownerApproval = signed(ownerDoc);
  assert.doesNotThrow(() => assertApplyPrerequisites(withItems));
  const extra = validPrerequisites();
  extra.reconciliation = signedReconciliation([
    {
      sourceTable: "lms_users",
      sourceKey: { id: 999 },
      decision: "preserve-custom-auth",
      reviewer: "owner",
      reviewedAt: "2026-11-06T11:00:00.000Z",
    },
  ]);
  const extraOwner = {
    ...extra.ownerApproval!.document,
    reconciliationManifestChecksum: signedDocumentContentChecksum(extra.reconciliation!.document),
  };
  extra.ownerApproval = signed(extraOwner);
  assert.throws(() => assertApplyPrerequisites(extra), /unrecognized source identity/);
});

test("synthetic dry-run reports insert/skip/review/conflict without writing or logging row data", async () => {
  const rows = {
    lms_courses: [
      { id: "1", value: "synthetic title", password_hash: "do-not-log", email: null },
    ],
    admissions_leads: [
      { id: "lead-synthetic", value: "synthetic lead", password_hash: null, email: null },
    ],
  };
  const { source, target } = makeStores(rows);
  const audit: Record<string, unknown>[] = [];
  const plan = await runAichmMigration(source, target, {
    mode: "dry-run",
    runId: RUN_IDS.synthetic,
    batchSize: 1,
    logger: (entry) => audit.push(entry),
  });
  assert.equal(plan.writesEnabled, false);
  assert.equal(plan.tables.lms_courses.insert, 1);
  assert.equal(plan.tables.admissions_leads.review, 1);
  assert.equal(target.writes, 0);
  assert.equal(JSON.stringify(audit).includes("synthetic title"), false);
  assert.equal(JSON.stringify(audit).includes("do-not-log"), false);
  assert.equal(JSON.stringify(plan).includes("synthetic lead"), false);
});

test("pre-existing identical rows skip; unique-key collisions are conflicts, never overwrites", async () => {
  const { source, target } = makeStores({
    lms_courses: [
      { id: "same", value: "same-value", password_hash: "source-hash", email: null },
      { id: "new", value: "new-value", password_hash: null, email: "collision@example.test" },
      { id: "same-conflict", value: "new-version", password_hash: null, email: null },
    ],
  });
  target.rows.set("lms_courses", [
    { id: "same", value: "same-value", password_hash: "source-hash", email: null },
    { id: "different-id", value: "old-value", password_hash: null, email: "collision@example.test" },
    { id: "same-conflict", value: "old-version", password_hash: null, email: null },
  ]);
  const plan = await runAichmMigration(source, target, { mode: "dry-run", runId: RUN_IDS.collision });
  assert.equal(plan.tables.lms_courses.skip, 1);
  assert.equal(plan.tables.lms_courses.conflict, 2);
  assert.equal(target.writes, 0);
});

test("checksums exclude secret fields but content comparison still detects differing secret values", async () => {
  const { source, target } = makeStores({
    lms_courses: [{ id: "1", value: "same", password_hash: "first-secret", email: null }],
  });
  const sourceRow = source.rows.get("lms_courses")![0];
  const targetRow = { ...sourceRow, password_hash: "different-secret" };
  target.rows.set("lms_courses", [targetRow]);
  const plan = await runAichmMigration(source, target, { mode: "dry-run", runId: RUN_IDS.secret });
  assert.equal(plan.tables.lms_courses.skip, 0);
  assert.equal(plan.tables.lms_courses.conflict, 1);
  assert.equal(plan.tables.lms_courses.sourceChecksum.length, 64);
});

test("resume checkpoints continue after the last committed batch and reruns do not duplicate rows", async () => {
  await withProductionMode(async () => {
    const { source, target } = makeStores({
      lms_courses: [
        { id: "1", value: "one", password_hash: null, email: null },
        { id: "2", value: "two", password_hash: null, email: null },
      ],
    });
    target.failOnId = "2";
    await assert.rejects(
      () => runAichmMigration(source, target, { mode: "apply", runId: RUN_IDS.resume, batchSize: 1, applyPrerequisites: validPrerequisites() }),
      /synthetic transaction failure/,
    );
    assert.deepEqual(target.rows.get("lms_courses"), [
      { id: "1", value: "one", password_hash: null, email: null },
    ]);
    assert.equal(target.checkpoints.get(`${RUN_IDS.resume}:lms_courses`)?.lastKey?.id, "1");
    target.failOnId = null;
    const resumed = await runAichmMigration(source, target, {
      mode: "apply",
      runId: RUN_IDS.resume,
      batchSize: 1,
      applyPrerequisites: validPrerequisites(),
    });
    assert.equal(resumed.writesEnabled, true);
    assert.equal(resumed.tables.lms_courses.sourceRows, 2);
    assert.equal(resumed.tables.lms_courses.insert, 1);
    assert.equal(target.rows.get("lms_courses")?.length, 2);

    const repeated = await runAichmMigration(source, target, {
      mode: "apply",
      runId: RUN_IDS.rerun,
      batchSize: 1,
      applyPrerequisites: validPrerequisites(),
    });
    assert.equal(repeated.tables.lms_courses.skip, 2);
    assert.equal(target.rows.get("lms_courses")?.length, 2);
  });
});

test("custom auth password hashes and role rows are copied unchanged after signed review", async () => {
  await withProductionMode(async () => {
    const userId = 7;
    const sourceRows = {
      lms_users: [
        { id: userId, value: "synthetic user", password_hash: "scrypt-hash-synthetic", email: null, user_id: null, role: null },
      ],
      lms_user_roles: [
        { id: "role-7-admin", value: null, password_hash: null, email: null, user_id: userId, role: "admin" },
      ],
    };
    const { source, target } = makeStores(sourceRows);
    const reconciliation = signedReconciliation([
      {
        sourceTable: "lms_users",
        sourceKey: { id: userId },
        decision: "preserve-custom-auth",
        reviewer: "owner",
        reviewedAt: "2026-11-06T11:00:00.000Z",
      },
    ]);
    const prerequisites = validPrerequisites({
      reconciliation,
      sourceLmsUserIds: [userId],
    });
    prerequisites.ownerApproval = signed({
      ...prerequisites.ownerApproval!.document,
      reconciliationManifestChecksum: signedDocumentContentChecksum(reconciliation.document),
    });
    await runAichmMigration(source, target, {
      mode: "apply",
      runId: RUN_IDS.auth,
      applyPrerequisites: prerequisites,
    });
    assert.equal(target.rows.get("lms_users")?.[0].password_hash, "scrypt-hash-synthetic");
    assert.equal(target.rows.get("lms_user_roles")?.[0].role, "admin");
    assert.equal(target.rows.get("lms_user_roles")?.[0].user_id, userId);
  });
});

test("apply refuses schema fingerprints that differ from the signed manifest before writing", async () => {
  await withProductionMode(async () => {
    const { source, target } = makeStores({
      lms_courses: [{ id: "1", value: "one", password_hash: null, email: null }],
    });
    const prerequisites = validPrerequisites();
    const changedSchema = signed({
      ...prerequisites.schemaVersion!.document,
      targetFingerprint: "e".repeat(64),
    });
    prerequisites.schemaVersion = changedSchema;
    prerequisites.ownerApproval = signed({
      ...prerequisites.ownerApproval!.document,
      schemaVersionManifestChecksum: signedDocumentContentChecksum(changedSchema.document),
    });
    await assert.rejects(
      () => runAichmMigration(source, target, {
        mode: "apply",
        runId: RUN_IDS.schema,
        applyPrerequisites: prerequisites,
      }),
      /Live schema fingerprints do not match/,
    );
    assert.equal(target.writes, 0);
  });
});

test("identity reconciliation is persisted transactionally without merging public leads", async () => {
  await withProductionMode(async () => {
    const leadId = "lead-synthetic";
    const { source, target } = makeStores({
      admissions_leads: [{ id: leadId, value: "synthetic", password_hash: null, email: null }],
    });
    target.rows.set("leads", [
      { id: "public-lead-synthetic", value: "existing public record", password_hash: null, email: null },
    ]);
    const reconciliation = signedReconciliation([
      {
        sourceTable: "admissions_leads",
        sourceKey: { id: leadId },
        decision: "link-existing-public-lead",
        targetPublicLeadId: "public-lead-synthetic",
        reviewer: "owner",
        reviewedAt: "2026-11-06T11:00:00.000Z",
      },
    ]);
    const prerequisites = validPrerequisites({
      reconciliation,
      sourceLeadIds: [leadId],
    });
    prerequisites.ownerApproval = signed({
      ...prerequisites.ownerApproval!.document,
      reconciliationManifestChecksum: signedDocumentContentChecksum(reconciliation.document),
    });
    await runAichmMigration(source, target, {
      mode: "apply",
      runId: RUN_IDS.crosswalk,
      applyPrerequisites: prerequisites,
    });
    const saved = [...target.crosswalk.values()][0];
    assert.equal(saved.decision, "link-existing-public-lead");
    assert.equal(saved.targetPublicLeadId, "public-lead-synthetic");
    assert.equal(target.rows.get("leads")?.length, 1);
    assert.equal(target.rows.get("admissions_leads")?.length, 1);
  });
});

test("strict audit logging rejects arbitrary data fields and recognizable credentials", () => {
  assert.throws(() => assertNoSecretInAuditEntry({ authorization: "Bearer hidden" }), /disallowed secret material/);
  assert.throws(() => assertNoSecretInAuditEntry({ connectionString: "postgresql://user:pass@host/db" }), /disallowed secret material/);
});

test("column transforms preserve stable primary keys and are applied through the mapping adapter", () => {
  const row = { id: "stable-id", value: "raw", password_hash: null, email: null };
  const transformed = transformMigrationRow("lms_courses", row, ["id"], {
    lms_courses: { value: (value) => String(value).toUpperCase() },
  });
  assert.equal(transformed.value, "RAW");
  assert.equal(transformed.id, "stable-id");
  assert.throws(
    () => transformMigrationRow("lms_courses", row, ["id"], { lms_courses: { id: () => "changed" } }),
    /cannot change the primary key/,
  );
});

