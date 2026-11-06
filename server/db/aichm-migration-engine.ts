import { createHash, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AICHM_MIGRATION_ORDER,
  FUTURE_CALENDAR_TABLES,
  PRESERVED_SUPABASE_PUBLIC_TABLES,
} from "./aichm-migration-plan";

export const AICHM_TARGET_SCHEMA = "aichm";
export const AICHM_TARGET_PROJECT_REF = "xylqezjvqqqjozenuygh";
export const AICHM_REQUIRED_SCHEMA_VERSION = "aichm-migration-control-v1";
export const AICHM_TRANSFORM_SET_VERSION = "identity-v1";

const DEFERRED_TRANSIENT_TABLES = new Set([
  "sessions",
  "lms_auth_rate_limits",
  "lms_password_setup_tokens",
  "lms_otp_challenges",
  "admissions_capture_limits",
]);

const CALENDAR_TABLES = new Set<string>(FUTURE_CALENDAR_TABLES);

/**
 * Explicit copy allowlist. Calendar remains outside this migration, transient
 * credentials/rate-limit state is deferred, and the existing public n8n tables
 * are never copy destinations.
 */
export const AICHM_COPY_TABLES = AICHM_MIGRATION_ORDER
  .filter(({ table }) => !DEFERRED_TRANSIENT_TABLES.has(table) && !CALENDAR_TABLES.has(table))
  .map(({ table, dependsOn }) => ({
    sourceSchema: "public",
    sourceTable: table,
    targetSchema: AICHM_TARGET_SCHEMA,
    targetTable: table,
    dependsOn: dependsOn.filter(
      (dependency) => !DEFERRED_TRANSIENT_TABLES.has(dependency) && !CALENDAR_TABLES.has(dependency),
    ),
    transformSet: "identity-v1",
    reviewRequired: table === "admissions_leads" || table === "lms_users",
  }));

const SECRET_COLUMN_NAMES = new Set([
  "password",
  "password_hash",
  "token",
  "token_hash",
  "secret",
  "secret_hash",
  "session",
  "sess",
  "session_data",
  "key",
  "key_hash",
  "api_key",
  "access_token",
  "refresh_token",
  "subscription_ciphertext",
  "nonce",
]);

export type ColumnTransformRegistry = Record<string, Record<string, (value: unknown, row: DbRow) => unknown>>;

/** Add transforms here only when the reviewed schema compatibility matrix requires them. */
export const AICHM_COLUMN_TRANSFORMS: ColumnTransformRegistry = Object.freeze({});

export type DbValue = null | string | number | boolean | bigint | Date | Buffer | Uint8Array | DbValue[] | { [key: string]: unknown };
export type DbRow = Record<string, unknown>;

export interface DatabaseIdentity {
  database: string;
  user: string;
  host: string;
  port: number;
  isRecovery: boolean;
  isReadOnly: boolean;
  projectRef?: string;
  tlsAuthorized: boolean;
  tlsServername: string | null;
}

export interface TableMetadata {
  columns: Array<{
    name: string;
    dataType: string;
    typeName?: string;
    characterMaximumLength?: number | null;
    numericPrecision?: number | null;
    numericScale?: number | null;
    defaultExpression?: string | null;
    nullable: boolean;
    hasDefault: boolean;
    ordinal: number;
  }>;
  primaryKey: string[];
  uniqueKeys: string[][];
}

export interface MigrationCheckpoint {
  lastKey: Record<string, unknown> | null;
  batchNumber: number;
  rowCount: number;
  sourceChecksum: string;
  targetChecksum: string;
}

export interface MigrationTransaction {
  findByKey(schema: string, table: string, key: Record<string, unknown>): Promise<DbRow | null>;
  findByUniqueKeys(
    schema: string,
    table: string,
    row: DbRow,
    uniqueKeys: string[][],
  ): Promise<{ row: DbRow; key: string[] } | null>;
  insertIgnore(schema: string, table: string, row: DbRow, primaryKey: string[]): Promise<boolean>;
  saveCheckpoint(runId: string, table: string, checkpoint: MigrationCheckpoint): Promise<void>;
  saveCrosswalk(input: {
    sourceTable: string;
    sourceKey: Record<string, unknown>;
    targetTable: string;
    targetKey: Record<string, unknown>;
    decision: ReconciliationDecision;
    targetPublicLeadId?: string;
    reviewer: string;
    reviewedAt: string;
  }): Promise<void>;
}

export interface MigrationStore {
  identity(): Promise<DatabaseIdentity>;
  schemaVersion(): Promise<string | null>;
  alignSequences(schema: string, table: string): Promise<number>;
  inspectTable(schema: string, table: string): Promise<TableMetadata | null>;
  scanRows(
    schema: string,
    table: string,
    afterKey: Record<string, unknown> | null,
    primaryKey: string[],
    limit: number,
  ): Promise<DbRow[]>;
  readCheckpoint(runId: string, table: string): Promise<MigrationCheckpoint | null>;
  transaction<T>(callback: (transaction: MigrationTransaction) => Promise<T>): Promise<T>;
}

export type ReconciliationDecision =
  | "create-distinct"
  | "link-existing-public-lead"
  | "preserve-custom-auth";

export interface ReconciliationItem {
  sourceTable: "admissions_leads" | "lms_users";
  sourceKey: Record<string, unknown>;
  decision: ReconciliationDecision;
  targetPublicLeadId?: string;
  reviewer: string;
  reviewedAt: string;
}

export interface SignedDocument<T> {
  document: T;
  signature: string;
}

export interface BackupManifest {
  version: 1;
  source: BackupArtifact;
  target: BackupArtifact;
}

export interface BackupArtifact {
  environment: "production-source" | "supabase-target";
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  restoreTest: {
    verified: boolean;
    restoreArtifactId: string;
    completedAt: string;
    isolatedTargetId: string;
  };
}

export interface ReconciliationManifest {
  version: 1;
  sourceDatabase: string;
  targetProjectRef: string;
  items: ReconciliationItem[];
}

export interface SchemaVersionManifest {
  version: 1;
  targetSchema: string;
  migrationVersion: string;
  transformSetVersion: string;
  compatible: boolean;
  sourceFingerprint: string;
  targetFingerprint: string;
  requiredTablesPresent: boolean;
}

export interface OwnerApprovalManifest {
  version: 1;
  scope: "aichm-production-database-migration";
  approved: boolean;
  approvedBy: string;
  approvedAt: string;
  sourceDatabase: string;
  targetProjectRef: string;
  backupManifestChecksum: string;
  reconciliationManifestChecksum: string;
  schemaVersionManifestChecksum: string;
}

export interface ApplyPrerequisiteInput {
  flags: { apply: boolean; productionCutover: boolean };
  runtimeEnvironment: string;
  environment: Record<string, string | undefined>;
  backupManifest?: BackupManifest;
  reconciliation?: SignedDocument<ReconciliationManifest>;
  schemaVersion?: SignedDocument<SchemaVersionManifest>;
  ownerApproval?: SignedDocument<OwnerApprovalManifest>;
  approvalPublicKey?: string;
  sourceIdentity?: DatabaseIdentity;
  targetIdentity?: DatabaseIdentity;
  sourceLeadIds?: Array<string | number>;
  sourceLmsUserIds?: Array<string | number>;
  now?: Date;
}

export interface TableMigrationCounts {
  sourceRows: number;
  insert: number;
  skip: number;
  review: number;
  conflict: number;
  batches: number;
  sourceChecksum: string;
  matchedTargetChecksum: string;
}

export interface MigrationPlan {
  mode: "dry-run" | "apply";
  runId: string;
  source: { database: string; host: string; port: number };
  target: { database: string; host: string; port: number; projectRef: string };
  writesEnabled: boolean;
  rowContentsLogged: false;
  tables: Record<string, TableMigrationCounts>;
  deferredTables: string[];
  preserveOnlyTables: string[];
  sequenceAdjustments: number;
}

export interface MigrationRunOptions {
  mode: "dry-run" | "apply";
  runId: string;
  batchSize?: number;
  reconciliation?: ReconciliationManifest;
  columnTransforms?: ColumnTransformRegistry;
  logger?: (entry: Record<string, unknown>) => void;
  applyPrerequisites?: ApplyPrerequisiteInput;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error("Migration metadata contains an invalid identifier.");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeDefaultExpression(expression: string | null): string | null {
  if (!expression) return null;
  return expression
    .replaceAll('"public".', '"aichm".')
    .replaceAll("public.", "aichm.");
}

export function canonicalize(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (input instanceof Date) {
      if (!Number.isFinite(input.getTime())) throw new Error("Invalid date in migration row.");
      return { $type: "timestamp", value: input.toISOString() };
    }
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      return { $type: "bytea", value: Buffer.from(input).toString("base64") };
    }
    if (typeof input === "bigint") return { $type: "bigint", value: input.toString() };
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, normalize((input as Record<string, unknown>)[key])]),
      );
    }
    if (typeof input === "number" && !Number.isFinite(input)) {
      throw new Error("Non-finite number in migration row.");
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function checksumRow(row: DbRow): string {
  const visible = Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !SECRET_COLUMN_NAMES.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const bytes = Buffer.from(canonicalize(visible), "utf8");
  return `${bytes.length}:${bytes.toString("base64")}`;
}

export function checksumRows(rows: DbRow[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(checksumRow(row), "utf8");
  return hash.digest("hex");
}

export function migrationSchemaFingerprint(
  tables: Array<{ schema: string; table: string; metadata: TableMetadata }>,
): string {
  const normalized = tables
    .map(({ schema, table, metadata }) => ({
      schema,
      table,
      columns: [...metadata.columns]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({
          name,
          dataType,
          typeName,
          characterMaximumLength,
          numericPrecision,
          numericScale,
          defaultExpression,
          nullable,
          hasDefault,
          ordinal,
        }) => ({
          name,
          dataType,
          typeName: typeName ?? dataType,
          characterMaximumLength: characterMaximumLength ?? null,
          numericPrecision: numericPrecision ?? null,
          numericScale: numericScale ?? null,
          defaultExpression: normalizeDefaultExpression(defaultExpression ?? null),
          nullable,
          hasDefault,
          ordinal,
        })),
      primaryKey: metadata.primaryKey,
      uniqueKeys: metadata.uniqueKeys,
    }))
    .sort((left, right) => `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`));
  return createHash("sha256").update(canonicalize(normalized), "utf8").digest("hex");
}

function rowsEqual(source: DbRow, target: DbRow, columns: string[]): boolean {
  for (const column of columns) {
    if (!isDeepStrictEqual(source[column], target[column])) return false;
  }
  return true;
}

function validateCopyMap(): void {
  const names = new Set<string>();
  for (const mapping of AICHM_COPY_TABLES) {
    if (PRESERVED_SUPABASE_PUBLIC_TABLES.includes(mapping.targetTable as never)) {
      throw new Error("The AICHM copy allowlist cannot target a preserve-only Supabase table.");
    }
    if (names.has(mapping.sourceTable)) throw new Error("Duplicate table in migration allowlist.");
    names.add(mapping.sourceTable);
    for (const dependency of mapping.dependsOn) {
      if (!names.has(dependency)) {
        throw new Error(`Migration allowlist is not FK ordered for ${mapping.sourceTable}.`);
      }
    }
  }
}

export function assertDatabaseIdentities(
  source: DatabaseIdentity,
  target: DatabaseIdentity,
): void {
  if (!source.database || !target.database || !source.host || !target.host) {
    throw new Error("Both migration database identities must be complete.");
  }
  const sourceFingerprint = `${source.host.toLowerCase()}:${source.port}/${source.database}`;
  const targetFingerprint = `${target.host.toLowerCase()}:${target.port}/${target.database}`;
  if (
    sourceFingerprint === targetFingerprint ||
    (source.database === target.database && source.host === target.host)
  ) {
    throw new Error("Source and target identities resolve to the same database.");
  }
  if (
    source.database !== "neondb" ||
    source.isRecovery ||
    source.isReadOnly ||
    !source.tlsAuthorized ||
    source.tlsServername !== source.host
  ) {
    throw new Error("Configured source is not the audited production primary identity.");
  }
  if (
    target.projectRef !== AICHM_TARGET_PROJECT_REF ||
    target.database !== "postgres" ||
    target.isReadOnly ||
    !target.tlsAuthorized ||
    target.tlsServername !== target.host
  ) {
    throw new Error("Target identity or strict TLS verification does not match the approved Supabase project.");
  }
}

function isoDate(value: string, name: string, now: Date): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > now.getTime()) {
    throw new Error(`${name} has an invalid or future timestamp.`);
  }
  return parsed;
}

function verifySignedDocument<T>(
  signed: SignedDocument<T> | undefined,
  key: string | undefined,
  name: string,
): T {
  if (!signed || !key || !signed.signature) {
    throw new Error(`${name} signed approval is required.`);
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signed.signature, "base64");
  } catch {
    throw new Error(`${name} signature is invalid.`);
  }
  if (signature.length !== 64) throw new Error(`${name} signature is invalid.`);
  const payload = Buffer.from(canonicalize(signed.document), "utf8");
  let valid = false;
  try {
    valid = verifySignature(null, payload, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new Error(`${name} signature verification failed.`);
  return signed.document;
}

function assertBackupManifest(manifest: BackupManifest | undefined, now: Date): void {
  if (!manifest || manifest.version !== 1) {
    throw new Error("Verified source and target backup manifest is required.");
  }
  for (const [artifact, expectedEnvironment] of [
    [manifest.source, "production-source"],
    [manifest.target, "supabase-target"],
  ] as const) {
    if (
      !artifact ||
      artifact.environment !== expectedEnvironment ||
      !artifact.artifactId.trim() ||
      !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0 ||
      !artifact.restoreTest?.verified ||
      !artifact.restoreTest.restoreArtifactId.trim() ||
      !artifact.restoreTest.isolatedTargetId.trim()
    ) {
      throw new Error("Both backups must have checksums, sizes, timestamps, and verified isolated restores.");
    }
    isoDate(artifact.createdAt, "Backup creation", now);
    isoDate(artifact.restoreTest.completedAt, "Backup restore verification", now);
  }
}

export function signedDocumentContentChecksum<T>(document: T): string {
  return createHash("sha256").update(canonicalize(document), "utf8").digest("hex");
}

function reconciliationKey(table: string, key: Record<string, unknown>): string {
  return `${table}:${canonicalize(key)}`;
}

function assertReconciliationCoverage(
  manifest: ReconciliationManifest,
  leadIds: Array<string | number>,
  userIds: Array<string | number>,
  now: Date,
): void {
  if (
    manifest.version !== 1 ||
    manifest.sourceDatabase !== "neondb" ||
    manifest.targetProjectRef !== AICHM_TARGET_PROJECT_REF
  ) {
    throw new Error("Reconciliation manifest identifies the wrong source or target.");
  }
  const itemMap = new Map<string, ReconciliationItem>();
  for (const item of manifest.items) {
    const keyColumns = Object.keys(item.sourceKey);
    if (!keyColumns.length || item.reviewer.trim().length < 2) {
      throw new Error("Reconciliation entries require a source key and reviewer.");
    }
    isoDate(item.reviewedAt, "Reconciliation review", now);
    if (
      (item.sourceTable === "admissions_leads" &&
        !["create-distinct", "link-existing-public-lead"].includes(item.decision)) ||
      (item.sourceTable === "lms_users" && item.decision !== "preserve-custom-auth")
    ) {
      throw new Error("Reconciliation decision is not allowed for the source table.");
    }
    if (item.decision === "link-existing-public-lead" && !item.targetPublicLeadId) {
      throw new Error("A reviewed public-lead link must identify its existing lead.");
    }
    const key = reconciliationKey(item.sourceTable, item.sourceKey);
    if (itemMap.has(key)) throw new Error("Reconciliation manifest contains duplicate source keys.");
    itemMap.set(key, item);
  }

  for (const id of leadIds) {
    if (!itemMap.has(reconciliationKey("admissions_leads", { id }))) {
      throw new Error("Reconciliation manifest does not resolve every admissions lead.");
    }
  }
  for (const id of userIds) {
    if (!itemMap.has(reconciliationKey("lms_users", { id }))) {
      throw new Error("Reconciliation manifest does not approve every custom-auth user.");
    }
  }
  const allowed = new Set([
    ...leadIds.map((id) => reconciliationKey("admissions_leads", { id })),
    ...userIds.map((id) => reconciliationKey("lms_users", { id })),
  ]);
  if (Array.from(itemMap.keys()).some((key) => !allowed.has(key))) {
    throw new Error("Reconciliation manifest contains an unrecognized source identity.");
  }
}

export function assertApplyPrerequisites(input: ApplyPrerequisiteInput): void {
  if (!input.flags.apply || !input.flags.productionCutover) {
    throw new Error("Apply requires distinct --apply and --production-cutover approvals.");
  }
  if (input.runtimeEnvironment !== "production") {
    throw new Error("Production apply requires an exact production runtime environment.");
  }
  const requiredEnvironment = [
    "AICHM_SOURCE_PROD_DATABASE_URL",
    "SUPABASE_DATABASE_URL",
    "SUPABASE_DB_SSL_CA",
    "AICHM_BACKUP_ENCRYPTION_KEY",
    "AICHM_MIGRATION_APPROVAL_PUBLIC_KEY",
  ];
  for (const key of requiredEnvironment) {
    if (!input.environment[key]?.trim()) throw new Error(`${key} is required for production apply.`);
  }
  if ((input.environment.AICHM_BACKUP_ENCRYPTION_KEY?.length ?? 0) < 32) {
    throw new Error("AICHM_BACKUP_ENCRYPTION_KEY does not meet the minimum length requirement.");
  }
  const now = input.now ?? new Date();
  assertBackupManifest(input.backupManifest, now);
  if (!input.sourceIdentity || !input.targetIdentity) {
    throw new Error("Verified source and target database identities are required.");
  }
  assertDatabaseIdentities(input.sourceIdentity, input.targetIdentity);

  const publicKey = input.approvalPublicKey ?? input.environment.AICHM_MIGRATION_APPROVAL_PUBLIC_KEY;
  const reconciliation = verifySignedDocument(input.reconciliation, publicKey, "Reconciliation manifest");
  const schema = verifySignedDocument(input.schemaVersion, publicKey, "Schema version manifest");
  const approval = verifySignedDocument(input.ownerApproval, publicKey, "Owner cutover approval");

  if (!input.sourceLeadIds || !input.sourceLmsUserIds) {
    throw new Error("Source lead and custom-auth identity review coverage is required.");
  }
  assertReconciliationCoverage(reconciliation, input.sourceLeadIds, input.sourceLmsUserIds, now);
  if (
    schema.version !== 1 ||
    schema.targetSchema !== AICHM_TARGET_SCHEMA ||
    schema.migrationVersion !== AICHM_REQUIRED_SCHEMA_VERSION ||
    schema.transformSetVersion !== AICHM_TRANSFORM_SET_VERSION ||
    !schema.compatible ||
    !schema.requiredTablesPresent ||
    !/^[a-f0-9]{64}$/i.test(schema.sourceFingerprint) ||
    !/^[a-f0-9]{64}$/i.test(schema.targetFingerprint)
  ) {
    throw new Error("Target schema compatibility manifest is missing or incompatible.");
  }
  if (
    approval.version !== 1 ||
    approval.scope !== "aichm-production-database-migration" ||
    !approval.approved ||
    approval.sourceDatabase !== input.sourceIdentity.database ||
    approval.targetProjectRef !== AICHM_TARGET_PROJECT_REF
  ) {
    throw new Error("A separate owner-signed production cutover approval is required.");
  }
  if (
    approval.backupManifestChecksum !== signedDocumentContentChecksum(input.backupManifest) ||
    approval.reconciliationManifestChecksum !== signedDocumentContentChecksum(reconciliation) ||
    approval.schemaVersionManifestChecksum !== signedDocumentContentChecksum(schema)
  ) {
    throw new Error("Owner approval does not cover the exact backup, reconciliation, and schema manifests.");
  }
  isoDate(approval.approvedAt, "Owner approval", now);
}

function validateMetadata(
  mapping: (typeof AICHM_COPY_TABLES)[number],
  source: TableMetadata | null,
  target: TableMetadata | null,
): { primaryKey: string[]; columns: string[]; targetUniqueKeys: string[][] } {
  if (!source || !target) throw new Error(`Required table is missing for ${mapping.sourceTable}.`);
  if (!source.primaryKey.length || !target.primaryKey.length) {
    throw new Error(`Primary key is required for ${mapping.sourceTable}.`);
  }
  if (canonicalize(source.primaryKey) !== canonicalize(target.primaryKey)) {
    throw new Error(`Primary-key definition differs for ${mapping.sourceTable}.`);
  }
  const targetColumns = new Map(target.columns.map((column) => [column.name, column]));
  const sourceColumns = source.columns.map((column) => column.name);
  for (const name of sourceColumns) {
    const sourceColumn = source.columns.find((column) => column.name === name)!;
    const targetColumn = targetColumns.get(name);
    if (!targetColumn) throw new Error(`Target column mapping is missing for ${mapping.sourceTable}.`);
    if (
      sourceColumn.dataType !== targetColumn.dataType ||
      (sourceColumn.typeName ?? sourceColumn.dataType) !== (targetColumn.typeName ?? targetColumn.dataType) ||
      (sourceColumn.characterMaximumLength ?? null) !== (targetColumn.characterMaximumLength ?? null) ||
      (sourceColumn.numericPrecision ?? null) !== (targetColumn.numericPrecision ?? null) ||
      (sourceColumn.numericScale ?? null) !== (targetColumn.numericScale ?? null) ||
      normalizeDefaultExpression(sourceColumn.defaultExpression ?? null) !==
        normalizeDefaultExpression(targetColumn.defaultExpression ?? null)
    ) {
      throw new Error(`Column type is incompatible for ${mapping.sourceTable}.`);
    }
  }
  for (const column of target.columns) {
    if (!sourceColumns.includes(column.name) && !column.nullable && !column.hasDefault) {
      throw new Error(`Target-only required column has no default for ${mapping.sourceTable}.`);
    }
  }
  return {
    primaryKey: source.primaryKey,
    columns: sourceColumns,
    targetUniqueKeys: target.uniqueKeys,
  };
}

function rowKey(row: DbRow, primaryKey: string[]): Record<string, unknown> {
  return Object.fromEntries(primaryKey.map((column) => [column, row[column]]));
}

function projectRow(row: DbRow, columns: string[]): DbRow {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

export function transformMigrationRow(
  table: string,
  row: DbRow,
  primaryKey: string[],
  customTransforms: ColumnTransformRegistry = {},
  transformSetVersion = AICHM_TRANSFORM_SET_VERSION,
): DbRow {
  if (transformSetVersion !== AICHM_TRANSFORM_SET_VERSION) {
    throw new Error("Migration column transform set is not supported.");
  }
  const transforms = {
    ...(AICHM_COLUMN_TRANSFORMS[table] ?? {}),
    ...(customTransforms[table] ?? {}),
  };
  const transformed = Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      transforms[column] ? transforms[column](value, row) : value,
    ]),
  );
  for (const key of primaryKey) {
    if (!isDeepStrictEqual(row[key], transformed[key])) {
      throw new Error(`Column transforms cannot change the primary key for ${table}.`);
    }
  }
  return transformed;
}

function getApproval(
  manifest: ReconciliationManifest | undefined,
  mapping: (typeof AICHM_COPY_TABLES)[number],
  key: Record<string, unknown>,
): ReconciliationItem | undefined {
  if (!manifest || !mapping.reviewRequired) return undefined;
  return manifest.items.find(
    (item) =>
      item.sourceTable === mapping.sourceTable &&
      canonicalize(item.sourceKey) === canonicalize(key),
  );
}

function rowChecksumAccumulator() {
  const hash = createHash("sha256");
  return {
    add(row: DbRow) {
      hash.update(checksumRow(row), "utf8");
    },
    finish() {
      return hash.digest("hex");
    },
  };
}

function chainChecksum(previous: string, next: string): string {
  return createHash("sha256").update(`${previous}:${next}`, "utf8").digest("hex");
}

function migrationLogger(logger: MigrationRunOptions["logger"], entry: Record<string, unknown>) {
  if (!logger) return;
  const allowedKeys = new Set([
    "event",
    "table",
    "batch",
    "sourceCount",
    "insertCount",
    "skipCount",
    "reviewCount",
    "conflictCount",
    "batchCount",
    "checksum",
  ]);
  if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
    throw new Error("Migration audit logger rejected a non-aggregate field.");
  }
  const safe = { ...entry };
  assertNoSecretInAuditEntry(safe);
  logger(safe);
}

async function prepareTable(
  source: MigrationStore,
  target: MigrationStore,
  mapping: (typeof AICHM_COPY_TABLES)[number],
) {
  const sourceMetadata = await source.inspectTable(mapping.sourceSchema, mapping.sourceTable);
  const targetMetadata = await target.inspectTable(mapping.targetSchema, mapping.targetTable);
  if (!sourceMetadata || !targetMetadata) {
    throw new Error(`Required table is missing for ${mapping.sourceTable}.`);
  }
  return {
    ...mapping,
    sourceMetadata,
    targetMetadata,
    ...validateMetadata(mapping, sourceMetadata, targetMetadata),
  };
}

export async function runAichmMigration(
  source: MigrationStore,
  target: MigrationStore,
  options: MigrationRunOptions,
): Promise<MigrationPlan> {
  validateCopyMap();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.runId)) {
    throw new Error("Migration run ID must be a generated UUID.");
  }
  if (options.mode === "apply" && process.env.NODE_ENV !== "production") {
    throw new Error("Data-copy apply is disabled outside the production migration runtime.");
  }
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error("Migration batch size must be between 1 and 5000.");
  }
  const sourceIdentity = await source.identity();
  const targetIdentity = await target.identity();
  assertDatabaseIdentities(sourceIdentity, targetIdentity);

  let reconciliation = options.reconciliation;
  if (options.mode === "apply") {
    if (!options.applyPrerequisites) throw new Error("Apply prerequisite verification is required.");
    assertApplyPrerequisites({
      ...options.applyPrerequisites,
      sourceIdentity,
      targetIdentity,
    });
    reconciliation = options.applyPrerequisites.reconciliation?.document;
    if (await target.schemaVersion() !== AICHM_REQUIRED_SCHEMA_VERSION) {
      throw new Error("The required AICHM migration-control schema version is not applied on the target.");
    }
  }

  const plan: MigrationPlan = {
    mode: options.mode,
    runId: options.runId,
    source: { database: sourceIdentity.database, host: sourceIdentity.host, port: sourceIdentity.port },
    target: {
      database: targetIdentity.database,
      host: targetIdentity.host,
      port: targetIdentity.port,
      projectRef: targetIdentity.projectRef ?? "",
    },
    writesEnabled: options.mode === "apply",
    rowContentsLogged: false,
    tables: {},
    deferredTables: Array.from(DEFERRED_TRANSIENT_TABLES).sort(),
    preserveOnlyTables: PRESERVED_SUPABASE_PUBLIC_TABLES.map((table) => `public.${table}`),
    sequenceAdjustments: 0,
  };

  const preparedMappings = [];
  for (const mapping of AICHM_COPY_TABLES) {
    preparedMappings.push(await prepareTable(source, target, mapping));
  }
  if (options.mode === "apply") {
    const prerequisites = options.applyPrerequisites!;
    const actualSourceFingerprint = migrationSchemaFingerprint(
      preparedMappings.map((table) => ({
        schema: table.sourceSchema,
        table: table.sourceTable,
        metadata: table.sourceMetadata,
      })),
    );
    const actualTargetFingerprint = migrationSchemaFingerprint(
      preparedMappings.map((table) => ({
        schema: table.targetSchema,
        table: table.targetTable,
        metadata: table.targetMetadata,
      })),
    );
    const schemaDocument = prerequisites.schemaVersion!.document;
    if (
      schemaDocument.sourceFingerprint !== actualSourceFingerprint ||
      schemaDocument.targetFingerprint !== actualTargetFingerprint
    ) {
      throw new Error("Live schema fingerprints do not match the reviewed schema version manifest.");
    }
  }
  if (options.mode === "apply") {
    for (const table of ["migration_checkpoints", "migration_crosswalk"]) {
      if (!await target.inspectTable(AICHM_TARGET_SCHEMA, table)) {
        throw new Error("Migration control schema is incomplete; refusing apply.");
      }
    }
    if (reconciliation?.items.some((item) => item.decision === "link-existing-public-lead")) {
      const publicLeads = await target.inspectTable("public", "leads");
      if (!publicLeads || canonicalize(publicLeads.primaryKey) !== canonicalize(["id"])) {
        throw new Error("Reviewed public-lead crosswalks require the existing public.leads(id) primary key.");
      }
    }
  }

  const persistCrosswalk = async (
    transaction: MigrationTransaction,
    mapping: (typeof AICHM_COPY_TABLES)[number],
    approval: ReconciliationItem,
    key: Record<string, unknown>,
  ) => {
    if (approval.decision === "link-existing-public-lead") {
      const existingPublicLead = await transaction.findByKey("public", "leads", {
        id: approval.targetPublicLeadId,
      });
      if (!existingPublicLead) {
        throw new Error("Approved public-lead crosswalk target does not exist.");
      }
    }
    await transaction.saveCrosswalk({
      sourceTable: mapping.sourceTable,
      sourceKey: key,
      targetTable: mapping.targetTable,
      targetKey: key,
      decision: approval.decision,
      targetPublicLeadId: approval.targetPublicLeadId,
      reviewer: approval.reviewer,
      reviewedAt: approval.reviewedAt,
    });
  };

  for (const prepared of preparedMappings) {
    const mapping = prepared;
    const counts: TableMigrationCounts = {
      sourceRows: 0,
      insert: 0,
      skip: 0,
      review: 0,
      conflict: 0,
      batches: 0,
      sourceChecksum: "",
      matchedTargetChecksum: "",
    };
    let runningSourceChecksum = createHash("sha256").update("", "utf8").digest("hex");
    let runningTargetChecksum = createHash("sha256").update("", "utf8").digest("hex");
    const targetHash = rowChecksumAccumulator();
    let checkpoint = options.mode === "apply" ? await target.readCheckpoint(options.runId, mapping.sourceTable) : null;
    let afterKey = checkpoint?.lastKey ?? null;
    let batchNumber = checkpoint?.batchNumber ?? 0;
    counts.batches = batchNumber;
    counts.sourceRows = checkpoint?.rowCount ?? 0;
    runningSourceChecksum = checkpoint?.sourceChecksum ?? "";
    runningTargetChecksum = checkpoint?.targetChecksum ?? "";

    while (true) {
      const rows = await source.scanRows(
        mapping.sourceSchema,
        mapping.sourceTable,
        afterKey,
        prepared.primaryKey,
        batchSize,
      );
      if (!rows.length) break;
      counts.batches++;
      const batchSourceHash = rowChecksumAccumulator();
      const batchTargetHash = rowChecksumAccumulator();
      let sourceCount = 0;
      let batchInsert = 0;
      let batchSkip = 0;
      let batchReview = 0;
      let batchConflict = 0;

      const processBatch = async (transaction?: MigrationTransaction) => {
        for (const sourceRow of rows) {
          sourceCount++;
          counts.sourceRows++;
          batchSourceHash.add(sourceRow);
          const migrationRow = transformMigrationRow(
            mapping.sourceTable,
            sourceRow,
            prepared.primaryKey,
            options.columnTransforms,
            mapping.transformSet,
          );
          const key = rowKey(migrationRow, prepared.primaryKey);
          const approval = getApproval(reconciliation, mapping, key);
          if (mapping.reviewRequired && !approval) {
            counts.review++;
            batchReview++;
            continue;
          }
          const conflictingUnique = await (transaction
            ? transaction.findByUniqueKeys(mapping.targetSchema, mapping.targetTable, migrationRow, prepared.targetUniqueKeys)
            : target.transaction((tx) =>
                tx.findByUniqueKeys(mapping.targetSchema, mapping.targetTable, migrationRow, prepared.targetUniqueKeys),
              ));
          if (conflictingUnique) {
            const existingKey = rowKey(conflictingUnique.row, prepared.primaryKey);
            const samePrimaryKey = canonicalize(existingKey) === canonicalize(key);
            if (samePrimaryKey && rowsEqual(migrationRow, conflictingUnique.row, prepared.columns)) {
              counts.skip++;
              batchSkip++;
              const matchedRow = projectRow(conflictingUnique.row, prepared.columns);
              targetHash.add(matchedRow);
              batchTargetHash.add(matchedRow);
              if (options.mode === "apply" && approval && transaction) {
                await persistCrosswalk(transaction, mapping, approval, key);
              }
              continue;
            }
            if (mapping.sourceTable === "admissions_leads") {
              counts.review++;
              batchReview++;
            } else {
              counts.conflict++;
              batchConflict++;
            }
            continue;
          }
          if (options.mode === "dry-run") {
            counts.insert++;
            batchInsert++;
            continue;
          }
          if (!transaction) throw new Error("Apply transaction is unavailable.");
          const inserted = await transaction.insertIgnore(
            mapping.targetSchema,
            mapping.targetTable,
            migrationRow,
            prepared.primaryKey,
          );
          if (inserted) {
            counts.insert++;
            batchInsert++;
            batchTargetHash.add(sourceRow);
            targetHash.add(sourceRow);
          } else {
            const existing = await transaction.findByKey(mapping.targetSchema, mapping.targetTable, key);
            if (existing && rowsEqual(migrationRow, existing, prepared.columns)) {
              counts.skip++;
              batchSkip++;
              const matchedRow = projectRow(existing, prepared.columns);
              targetHash.add(matchedRow);
              batchTargetHash.add(matchedRow);
            } else {
              counts.conflict++;
              batchConflict++;
              throw new Error(`Insert conflict in ${mapping.sourceTable}; batch rolled back for review.`);
            }
          }
          if (mapping.sourceTable === "admissions_leads" || mapping.sourceTable === "lms_users") {
            if (!approval) throw new Error(`Reviewed mapping is required for ${mapping.sourceTable}.`);
            await persistCrosswalk(transaction, mapping, approval, key);
          }
        }
      };

      if (options.mode === "apply") {
        const nextKey = rowKey(rows[rows.length - 1], prepared.primaryKey);
        batchNumber++;
        let nextSourceChecksum = "";
        let nextTargetChecksum = "";
        await target.transaction(async (transaction) => {
          await processBatch(transaction);
          if (batchConflict > 0 || batchReview > 0) {
            throw new Error(`Unresolved review or conflict in ${mapping.sourceTable}; batch rolled back.`);
          }
          nextSourceChecksum = chainChecksum(runningSourceChecksum, batchSourceHash.finish());
          nextTargetChecksum = chainChecksum(runningTargetChecksum, batchTargetHash.finish());
          await transaction.saveCheckpoint(options.runId, mapping.sourceTable, {
            lastKey: nextKey,
            batchNumber,
            rowCount: sourceCount,
            sourceChecksum: nextSourceChecksum,
            targetChecksum: nextTargetChecksum,
          });
        });
        afterKey = nextKey;
        counts.sourceRows = (checkpoint?.rowCount ?? 0) + sourceCount;
        runningSourceChecksum = nextSourceChecksum;
        runningTargetChecksum = nextTargetChecksum;
        checkpoint = {
          lastKey: nextKey,
          batchNumber,
          rowCount: counts.sourceRows,
          sourceChecksum: nextSourceChecksum,
          targetChecksum: nextTargetChecksum,
        };
      } else {
        await processBatch();
        afterKey = rowKey(rows[rows.length - 1], prepared.primaryKey);
        runningSourceChecksum = chainChecksum(runningSourceChecksum, batchSourceHash.finish());
        runningTargetChecksum = chainChecksum(runningTargetChecksum, batchTargetHash.finish());
      }

      migrationLogger(options.logger, {
        event: "migration_batch_planned",
        table: mapping.sourceTable,
        batch: counts.batches,
        sourceCount,
        insertCount: batchInsert,
        skipCount: batchSkip,
        reviewCount: batchReview,
        conflictCount: batchConflict,
      });
      if (rows.length < batchSize) break;
    }
    counts.sourceChecksum = runningSourceChecksum;
    counts.matchedTargetChecksum = options.mode === "apply" ? runningTargetChecksum : targetHash.finish();
    plan.tables[mapping.sourceTable] = counts;
    migrationLogger(options.logger, {
      event: "migration_table_summary",
      table: mapping.sourceTable,
      sourceCount: counts.sourceRows,
      insertCount: counts.insert,
      skipCount: counts.skip,
      reviewCount: counts.review,
      conflictCount: counts.conflict,
      batchCount: counts.batches,
      checksum: counts.sourceChecksum,
    });
  }

  if (options.mode === "apply") {
    for (const mapping of AICHM_COPY_TABLES) {
      plan.sequenceAdjustments += await target.alignSequences(mapping.targetSchema, mapping.targetTable);
    }
  }

  return plan;
}

export function assertNoSecretInAuditEntry(entry: Record<string, unknown>): void {
  const serialized = canonicalize(entry).toLowerCase();
  if (
    /postgres(?:ql)?:\/\//.test(serialized) ||
    /bearer\s/.test(serialized) ||
    /password_hash|token_hash|secret|session_data|questionnaire_answers/.test(serialized)
  ) {
    throw new Error("Audit entry contains disallowed secret material.");
  }
}

export function signatureMatchesDocument<T>(signed: SignedDocument<T>, publicKey: string): boolean {
  const payload = Buffer.from(canonicalize(signed.document), "utf8");
  const signature = Buffer.from(signed.signature, "base64");
  if (signature.length !== 64) return false;
  try {
    return verifySignature(null, payload, publicKey, signature);
  } catch {
    return false;
  }
}

export function constantTimeHexEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right) || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
