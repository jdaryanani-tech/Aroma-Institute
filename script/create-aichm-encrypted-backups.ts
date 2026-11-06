import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Pool, type PoolClient } from "pg";
import { createAichmSourceMigrationPool } from "../server/db/aichm-source-migration";
import {
  buildSupabaseMigrationPoolConfig,
  createSupabaseMigrationConnection,
} from "../server/db/supabase-migration";
import { migrationStoreFromPool } from "../server/db/aichm-migration-postgres";
import {
  classifyPgDumpDiagnostic,
  type PgDumpDiagnostic,
} from "../server/db/pg-dump-diagnostic";

const EXPECTED_SOURCE_DATABASE = "neondb";
const EXPECTED_SUPABASE_DATABASE = "postgres";
const EXPECTED_SUPABASE_REF = "xylqezjvqqqjozenuygh";
const EXPECTED_SUPABASE_HOST = "aws-0-ap-northeast-1.pooler.supabase.com";
const OUTPUT_DIRECTORY = path.resolve(".local/aichm-backup-export");
const FORMAT_VERSION = "aichm-aesgcm-v1";
const TABLE_RELKINDS = ["r", "p", "m"];

type Scope = "full_database" | "public_schema";
type TableCount = { schema: string; table: string; rows: string };
type DatabaseSnapshot = {
  client: PoolClient;
  snapshotId: string;
  database: string;
  role: string;
  serverVersion: string;
  serverVersionNum: number;
  databaseBytes: string;
  tables: TableCount[];
  schemas: string[];
};

type DumpManifest = {
  manifestVersion: typeof FORMAT_VERSION;
  createdAt: string;
  source: {
    database: string;
    role: string;
    hostname: "masked";
    serverVersion: string;
    pgDumpVersion: string;
    scope: Scope;
    schemas: string[];
    tables: TableCount[];
  };
  dump: {
    status: "success";
    exitCode: 0;
    format: "PostgreSQL custom archive";
    plaintextBytes: number;
    plaintextSha256: string;
  };
  artifact: {
    filename: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
  };
  encryption: {
    formatVersion: typeof FORMAT_VERSION;
    algorithm: "AES-256-GCM";
    ivHex: string;
    tagHex: string;
  };
  restore: {
    status: "pending" | "verified" | "failed";
    verifiedAt?: string;
    pgRestoreExitCode?: number;
    archiveAuthentication: "verified" | "failed";
    plaintextSha256Matches?: boolean;
    tableListMatches?: boolean;
    rowCountsMatch?: boolean;
    restoredSchemas?: string[];
    restoredTables?: TableCount[];
    errorCode?: string;
  };
};

class BackupFailure extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

class PgDumpFailure extends BackupFailure {
  constructor(readonly diagnostic: PgDumpDiagnostic) {
    super("pg_dump_failed");
  }
}

class HashingTransform extends Transform {
  constructor(private readonly hash: Hash) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeCode(error: unknown): string {
  if (error instanceof BackupFailure) return error.safeCode;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return `system_${error.code.replace(/[^A-Z0-9_]/gi, "").slice(0, 40)}`;
  }
  return "operation_failed";
}

function captureStderr(child: ReturnType<typeof spawn>): () => string {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (capturedBytes >= 16_384) return;
    const remaining = 16_384 - capturedBytes;
    chunks.push(Buffer.from(chunk.subarray(0, remaining)));
    capturedBytes += Math.min(chunk.length, remaining);
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

function classifyRestoreStderr(stderr: string): string {
  const text = stderr.toLowerCase();
  if (/role .* does not exist/.test(text)) return "pg_restore_missing_role_dependency";
  if (/relation .* does not exist|schema .* does not exist|function .* does not exist/.test(text)) {
    return "pg_restore_missing_object_dependency";
  }
  if (/permission denied|must be owner|insufficient privilege/.test(text)) {
    return "pg_restore_privilege_failure";
  }
  if (/already exists|duplicate key|conflicts with existing/.test(text)) {
    return "pg_restore_disposable_object_conflict";
  }
  return "pg_restore_failed";
}

function safeHostMatch(hostname: string | undefined, expected: string): boolean {
  return typeof hostname === "string" && hostname.toLowerCase() === expected.toLowerCase();
}

function decodeBackupKey(): Buffer {
  const encoded = process.env.AICHM_BACKUP_ENCRYPTION_KEY;
  if (
    !encoded ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new BackupFailure("backup_key_invalid_format");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    key.fill(0);
    throw new BackupFailure("backup_key_invalid_length_or_encoding");
  }
  return key;
}

function parseConnection(uri: string | undefined) {
  if (!uri) throw new BackupFailure("required_connection_unavailable");
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new BackupFailure("connection_uri_invalid");
  }
  let username: string;
  let password: string;
  let database: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    throw new BackupFailure("connection_uri_encoding_invalid");
  }
  if (
    !parsed.hostname ||
    !username ||
    !password ||
    !database ||
    /[\r\n]/.test(username) ||
    /[\r\n]/.test(password) ||
    /[\r\n]/.test(parsed.hostname) ||
    /[\r\n]/.test(database)
  ) {
    throw new BackupFailure("connection_components_invalid");
  }
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "5432"),
    username,
    password,
    database,
  };
}

function escapePgpass(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function maskedRole(_role: string): string {
  return "masked-database-role";
}

async function assertOutputProtection(): Promise<void> {
  const [gitIgnore, replitIgnore] = await Promise.all([
    readFile(".gitignore", "utf8"),
    readFile(".replitignore", "utf8"),
  ]);
  if (!gitIgnore.includes(".local/aichm-backup-export/")) {
    throw new BackupFailure("backup_directory_not_git_ignored");
  }
  if (!replitIgnore.includes(".local/aichm-backup-export/")) {
    throw new BackupFailure("backup_directory_not_deployment_ignored");
  }
  const staticRoot = path.resolve("dist/public");
  const relative = path.relative(staticRoot, OUTPUT_DIRECTORY);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new BackupFailure("backup_directory_inside_static_root");
  }
  if (OUTPUT_DIRECTORY.includes(`${path.sep}client${path.sep}public${path.sep}`)) {
    throw new BackupFailure("backup_directory_inside_client_public");
  }
}

async function runQuiet(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  captureStdout = false,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
    });
    let stdout = "";
    if (captureStdout) {
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 4096) stdout += chunk.toString("utf8").slice(0, 4096 - stdout.length);
      });
    }
    child.once("error", () => reject(new BackupFailure(`${command}_unavailable`)));
    child.once("close", (code) => {
      if (code === 0) resolve({ code, stdout: stdout.trim() });
      else reject(new BackupFailure(`${command}_exit_${code ?? "unknown"}`));
    });
  });
}

function majorVersion(version: string): number {
  const match = version.match(/(?:PostgreSQL\)\s*)?(\d+)(?:\.\d+)?/);
  if (!match) throw new BackupFailure("postgres_version_unrecognized");
  return Number(match[1]);
}

async function getToolVersion(tool: string): Promise<{ text: string; major: number }> {
  const result = await runQuiet(
    tool,
    ["--version"],
    { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
    true,
  );
  return { text: result.stdout, major: majorVersion(result.stdout) };
}

async function getTableCounts(
  client: Pick<PoolClient, "query">,
  scope: Scope,
): Promise<{ tables: TableCount[]; schemas: string[] }> {
  const predicate =
    scope === "public_schema"
      ? "n.nspname = $1"
      : "n.nspname NOT LIKE $1 AND n.nspname <> $2";
  const parameters = scope === "public_schema" ? ["public"] : ["pg_%", "information_schema"];
  const foreignResult = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace ` +
      `WHERE ${predicate} AND c.relkind = 'f'`,
    parameters,
  );
  if (Number(foreignResult.rows[0]?.count ?? "0") > 0) {
    throw new BackupFailure(`foreign_tables_not_supported_${scope}`);
  }

  const result = await client.query<{ schema_name: string; table_name: string }>(
    `SELECT n.nspname AS schema_name,c.relname AS table_name FROM pg_class c ` +
      `JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${predicate} ` +
      `AND c.relkind IN ('r','p','m') ORDER BY n.nspname,c.relname`,
    parameters,
  );
  const tables: TableCount[] = [];
  for (const row of result.rows) {
    const count = await client.query<{ rows: string }>(
      `SELECT count(*)::text AS rows FROM ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.table_name)}`,
    );
    tables.push({
      schema: row.schema_name,
      table: row.table_name,
      rows: count.rows[0]?.rows ?? "0",
    });
  }
  return { tables, schemas: [...new Set(tables.map((table) => table.schema))] };
}

async function getPolicyRoles(pool: Pool, scope: Scope): Promise<string[]> {
  const predicate =
    scope === "public_schema"
      ? "n.nspname = $1"
      : "n.nspname NOT LIKE $1 AND n.nspname <> $2";
  const parameters = scope === "public_schema" ? ["public"] : ["pg_%", "information_schema"];
  const result = await pool.query<{ role_name: string }>(
    `SELECT DISTINCT r.rolname AS role_name FROM pg_policy p ` +
      `JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace ` +
      `CROSS JOIN LATERAL unnest(p.polroles) AS policy_role(role_oid) ` +
      `JOIN pg_roles r ON r.oid=policy_role.role_oid WHERE ${predicate} ` +
      `ORDER BY r.rolname`,
    parameters,
  );
  return result.rows.map((row) => row.role_name);
}

async function beginSnapshot(pool: Pool, scope: Scope): Promise<DatabaseSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await client.query<{
      snapshot_id: string;
      database_name: string;
      role_name: string;
      server_version: string;
      server_version_num: number;
      database_bytes: string;
    }>(
      "SELECT pg_export_snapshot() AS snapshot_id,current_database() AS database_name," +
        "current_user AS role_name,current_setting('server_version') AS server_version," +
        "current_setting('server_version_num')::int AS server_version_num," +
        "pg_database_size(current_database())::text AS database_bytes",
    );
    const row = result.rows[0];
    const inventory = await getTableCounts(client, scope);
    return {
      client,
      snapshotId: row.snapshot_id,
      database: row.database_name,
      role: row.role_name,
      serverVersion: row.server_version,
      serverVersionNum: row.server_version_num,
      databaseBytes: row.database_bytes,
      ...inventory,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
}

async function finishSnapshot(snapshot: DatabaseSnapshot, commit: boolean): Promise<void> {
  try {
    await snapshot.client.query(commit ? "COMMIT" : "ROLLBACK");
  } finally {
    snapshot.client.release();
  }
}

function childExit(child: ReturnType<typeof spawn>, tool: string): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new BackupFailure(`${tool}_unavailable`)));
    child.once("close", (code) => resolve(code ?? -1));
  });
}

async function writeManifest(filename: string, manifest: DumpManifest): Promise<void> {
  const temporary = `${filename}.partial`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporary, 0o600);
  await rename(temporary, filename);
}

async function createEncryptedDump(input: {
  id: "source-production" | "supabase-public";
  scope: Scope;
  uri: string | undefined;
  snapshot: DatabaseSnapshot;
  pgDumpVersion: string;
  tempDir: string;
  passFile: string;
  targetCaFile?: string;
  key: Buffer;
}): Promise<{ manifest: DumpManifest; manifestPath: string; artifactPath: string }> {
  const connection = parseConnection(input.uri);
  const timestamp = new Date().toISOString();
  const suffix = randomBytes(6).toString("hex");
  const baseName = `aichm-${input.id}-${timestamp.replace(/[:.]/g, "-")}-${suffix}`;
  const artifactName = `${baseName}.dump.aesgcm`;
  const artifactPath = path.join(OUTPUT_DIRECTORY, artifactName);
  const partialPath = `${artifactPath}.partial`;
  const manifestPath = path.join(OUTPUT_DIRECTORY, `${baseName}.manifest.json`);

  const passEntry = [
    connection.host,
    String(connection.port),
    connection.database,
    connection.username,
    connection.password,
  ]
    .map(escapePgpass)
    .join(":");
  await writeFile(input.passFile, `${passEntry}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(input.passFile, 0o600);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  const plaintextHash = createHash("sha256");
  const ciphertextHash = createHash("sha256");
  const plaintextCounter = new ByteCounter();
  const ciphertextCounter = new ByteCounter();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: input.tempDir,
    TMPDIR: input.tempDir,
    LANG: "C",
    LC_ALL: "C",
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.username,
    PGDATABASE: connection.database,
    PGPASSFILE: input.passFile,
    PGSSLMODE: "verify-full",
    PGOPTIONS: "-c timezone=UTC",
    PGAPPNAME: "aichm-encrypted-backup",
  };
  if (input.targetCaFile) env.PGSSLROOTCERT = input.targetCaFile;

  const args = ["--format=custom", "--no-password", `--snapshot=${input.snapshot.snapshotId}`];
  if (input.id === "source-production") args.push("--no-owner", "--no-acl");
  if (input.scope === "public_schema") args.push("--schema=public");
  const child = spawn("pg_dump", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const diagnostics = captureStderr(child);
  const exitPromise = childExit(child, "pg_dump");

  try {
    await pipeline(
      child.stdout!,
      plaintextCounter,
      new HashingTransform(plaintextHash),
      cipher,
      ciphertextCounter,
      new HashingTransform(ciphertextHash),
      createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
    );
    const exitCode = await exitPromise;
    if (exitCode !== 0) {
      throw new PgDumpFailure(classifyPgDumpDiagnostic(diagnostics(), exitCode));
    }
    await chmod(partialPath, 0o600);
    await rename(partialPath, artifactPath);
    const ciphertextStat = await stat(artifactPath);
    const tag = cipher.getAuthTag();
    const manifest: DumpManifest = {
      manifestVersion: FORMAT_VERSION,
      createdAt: timestamp,
      source: {
        database: input.snapshot.database,
        role: maskedRole(input.snapshot.role),
        hostname: "masked",
        serverVersion: input.snapshot.serverVersion,
        pgDumpVersion: input.pgDumpVersion,
        scope: input.scope,
        schemas: input.snapshot.schemas,
        tables: input.snapshot.tables,
      },
      dump: {
        status: "success",
        exitCode: 0,
        format: "PostgreSQL custom archive",
        plaintextBytes: plaintextCounter.bytes,
        plaintextSha256: plaintextHash.digest("hex"),
      },
      artifact: {
        filename: artifactName,
        ciphertextBytes: ciphertextStat.size,
        ciphertextSha256: ciphertextHash.digest("hex"),
      },
      encryption: {
        formatVersion: FORMAT_VERSION,
        algorithm: "AES-256-GCM",
        ivHex: iv.toString("hex"),
        tagHex: tag.toString("hex"),
      },
      restore: {
        status: "pending",
        archiveAuthentication: "failed",
      },
    };
    await writeManifest(manifestPath, manifest);
    return { manifest, manifestPath, artifactPath };
  } catch (error) {
    child.kill("SIGTERM");
    const exitCode = await exitPromise.catch(() => -1);
    await rm(partialPath, { force: true });
    await rm(artifactPath, { force: true });
    if (error instanceof PgDumpFailure) throw error;
    const systemErrorCode =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    throw new PgDumpFailure(
      classifyPgDumpDiagnostic(
        diagnostics(),
        exitCode,
        exitCode < 0 ? "encrypted_stream" : "pg_dump",
        systemErrorCode,
      ),
    );
  }
}

class ByteCounter extends Transform {
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

async function updateManifest(
  manifestPath: string,
  manifest: DumpManifest,
): Promise<void> {
  await rm(`${manifestPath}.partial`, { force: true });
  await writeManifest(manifestPath, manifest);
}

async function loadExistingBackups(): Promise<
  Array<{ manifest: DumpManifest; manifestPath: string; artifactPath: string }>
> {
  let entries: string[];
  try {
    entries = await readdir(OUTPUT_DIRECTORY);
  } catch {
    throw new BackupFailure("no_existing_backup_artifacts");
  }

  const backups: Array<{
    manifest: DumpManifest;
    manifestPath: string;
    artifactPath: string;
  }> = [];
  for (const entry of entries.filter((name) => name.endsWith(".manifest.json"))) {
    const manifestPath = path.join(OUTPUT_DIRECTORY, entry);
    let manifest: DumpManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DumpManifest;
    } catch {
      throw new BackupFailure("existing_manifest_invalid");
    }
    if (
      manifest.manifestVersion !== FORMAT_VERSION ||
      manifest.dump.status !== "success" ||
      manifest.artifact.filename !== path.basename(manifest.artifact.filename) ||
      !manifest.artifact.filename.endsWith(".dump.aesgcm") ||
      !/^[a-f0-9]{64}$/i.test(manifest.artifact.ciphertextSha256) ||
      !/^[a-f0-9]{64}$/i.test(manifest.dump.plaintextSha256) ||
      !/^[a-f0-9]{24}$/i.test(manifest.encryption.ivHex) ||
      !/^[a-f0-9]{32}$/i.test(manifest.encryption.tagHex)
    ) {
      throw new BackupFailure("existing_manifest_metadata_invalid");
    }
    const artifactPath = path.join(OUTPUT_DIRECTORY, manifest.artifact.filename);
    const artifactStat = await stat(artifactPath).catch(() => null);
    if (!artifactStat || artifactStat.size !== manifest.artifact.ciphertextBytes) {
      throw new BackupFailure("existing_encrypted_artifact_missing_or_wrong_size");
    }
    backups.push({ manifest, manifestPath, artifactPath });
  }
  if (backups.length === 0) throw new BackupFailure("no_existing_backup_manifests");
  backups.sort((left, right) =>
    left.manifest.source.scope === "full_database" ? -1 : right.manifest.source.scope === "full_database" ? 1 : 0,
  );
  return backups;
}

async function restoreArtifact(
  backup: { manifest: DumpManifest; manifestPath: string; artifactPath: string },
  key: Buffer,
  local: { host: string; port: number; socketDir: string },
  policyRoles: string[],
): Promise<void> {
  const manifest = backup.manifest;
  const dbName =
    manifest.source.scope === "full_database" ? "restore_source" : "restore_supabase_public";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    PGHOST: local.socketDir,
    PGPORT: String(local.port),
    PGUSER: "postgres",
  };
  const localAdmin = new Pool({
    host: local.socketDir,
    port: local.port,
    user: "postgres",
    database: "postgres",
    ssl: false,
  });
  try {
    const client = await localAdmin.connect();
    try {
      for (const role of policyRoles) {
        if (role.length > 63 || role.includes("\0")) {
          throw new BackupFailure("restore_policy_role_name_invalid");
        }
        const existing = await client.query<{ exists: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists",
          [role],
        );
        if (!existing.rows[0].exists) {
          await client.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN`);
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await localAdmin.end();
  }
  await runQuiet("createdb", ["--template=template0", dbName], env);
  const localPoolForPreparation = new Pool({
    host: local.socketDir,
    port: local.port,
    user: "postgres",
    database: dbName,
    ssl: false,
  });
  try {
    const client = await localPoolForPreparation.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    } finally {
      client.release();
    }
  } finally {
    await localPoolForPreparation.end();
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(manifest.encryption.ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(manifest.encryption.tagHex, "hex"));
  const plaintextHash = createHash("sha256");
  const ciphertextHash = createHash("sha256");
  const ciphertextCounter = new ByteCounter();
  const plaintextCounter = new ByteCounter();
  const child = spawn(
    "pg_restore",
    ["--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", `--dbname=${dbName}`],
    { env, stdio: ["pipe", "ignore", "pipe"] },
  );
  const diagnostics = captureStderr(child);
  const exitPromise = childExit(child, "pg_restore");
  try {
    await pipeline(
      createReadStream(backup.artifactPath),
      ciphertextCounter,
      new HashingTransform(ciphertextHash),
      decipher,
      plaintextCounter,
      new HashingTransform(plaintextHash),
      child.stdin!,
    );
    manifest.restore.archiveAuthentication = "verified";
    const restoredHash = plaintextHash.digest("hex");
    manifest.restore.plaintextSha256Matches =
      restoredHash === manifest.dump.plaintextSha256;
    const ciphertextStat = await stat(backup.artifactPath);
    const ciphertextMatches =
      ciphertextHash.digest("hex") === manifest.artifact.ciphertextSha256 &&
      ciphertextCounter.bytes === manifest.artifact.ciphertextBytes &&
      ciphertextStat.size === manifest.artifact.ciphertextBytes;
    if (!ciphertextMatches) throw new BackupFailure("ciphertext_checksum_mismatch");
    if (!manifest.restore.plaintextSha256Matches) {
      throw new BackupFailure("restored_archive_checksum_mismatch");
    }
    const exitCode = await exitPromise;
    manifest.restore.pgRestoreExitCode = exitCode;
    if (exitCode !== 0) {
      throw new BackupFailure(classifyRestoreStderr(diagnostics()));
    }

    const restoredPool = new Pool({
      host: local.socketDir,
      port: local.port,
      user: "postgres",
      database: dbName,
      ssl: false,
    });
    try {
      const client = await restoredPool.connect();
      let restored: { tables: TableCount[]; schemas: string[] };
      try {
        restored = await getTableCounts(client, manifest.source.scope);
      } finally {
        client.release();
      }
      const expectedNames = manifest.source.tables.map((table) => `${table.schema}.${table.table}`);
      const restoredNames = restored.tables.map((table) => `${table.schema}.${table.table}`);
      manifest.restore.tableListMatches =
        JSON.stringify(restoredNames) === JSON.stringify(expectedNames);
      manifest.restore.rowCountsMatch =
        JSON.stringify(restored.tables) === JSON.stringify(manifest.source.tables);
      manifest.restore.restoredSchemas = restored.schemas;
      manifest.restore.restoredTables = restored.tables;
      if (!manifest.restore.tableListMatches || !manifest.restore.rowCountsMatch) {
        throw new BackupFailure("restored_schema_or_counts_mismatch");
      }
      manifest.restore.status = "verified";
      manifest.restore.verifiedAt = new Date().toISOString();
    } finally {
      await restoredPool.end();
    }
  } catch (error) {
    child.kill("SIGTERM");
    await exitPromise.catch(() => undefined);
    manifest.restore.status = "failed";
    if (manifest.restore.archiveAuthentication !== "verified") {
      manifest.restore.archiveAuthentication = "failed";
    }
    manifest.restore.errorCode = safeCode(error);
    throw error;
  } finally {
    await updateManifest(backup.manifestPath, manifest);
  }
}

async function chooseLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new BackupFailure("local_restore_port_unavailable")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new BackupFailure("local_restore_port_unavailable"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(new BackupFailure("local_restore_port_unavailable")) : resolve(port)));
    });
  });
}

async function restoreAll(
  backups: Array<{ manifest: DumpManifest; manifestPath: string; artifactPath: string }>,
  key: Buffer,
  policyRolesByScope: Record<Scope, string[]>,
): Promise<Array<{ target: string; errorCode: string }>> {
  const scratchRoot = await mkdtemp("/dev/shm/aichm-restore-");
  await chmod(scratchRoot, 0o700);
  const dataDir = path.join(scratchRoot, "data");
  const socketDir = path.join(scratchRoot, "socket");
  await mkdir(socketDir, { mode: 0o700 });
  const port = await chooseLocalPort();
  const localEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: scratchRoot,
    TMPDIR: scratchRoot,
    LANG: "C",
    LC_ALL: "C",
  };
  const failures: Array<{ target: string; errorCode: string }> = [];
  try {
    await runQuiet(
      "initdb",
      ["--pgdata", dataDir, "--username=postgres", "--auth-local=trust", "--auth-host=trust", "--no-instructions"],
      localEnv,
    );
    await runQuiet(
      "pg_ctl",
      [
        "--pgdata",
        dataDir,
        "--log",
        path.join(scratchRoot, "postgres.log"),
        "--options",
        `-h 127.0.0.1 -p ${port} -k ${socketDir} -c listen_addresses=127.0.0.1`,
        "--wait",
        "start",
      ],
      localEnv,
    );
    for (const backup of backups) {
      try {
        await restoreArtifact(
          backup,
          key,
          { host: "127.0.0.1", port, socketDir },
          policyRolesByScope[backup.manifest.source.scope],
        );
      } catch (error) {
        failures.push({
          target: backup.manifest.source.scope,
          errorCode: safeCode(error),
        });
      }
    }
  } finally {
    await runQuiet(
      "pg_ctl",
      ["--pgdata", dataDir, "--mode=fast", "--wait", "stop"],
      localEnv,
    ).catch(() => undefined);
    await rm(scratchRoot, { recursive: true, force: true });
  }
  return failures;
}

async function verifyConnectionIdentities(
  sourcePool: Pool,
  targetPool: Pool,
): Promise<void> {
  const sourceUrl = parseConnection(process.env.AICHM_SOURCE_PROD_DATABASE_URL);
  const targetUrl = parseConnection(process.env.SUPABASE_DATABASE_URL);
  const [sourceIdentity, targetIdentity] = await Promise.all([
    migrationStoreFromPool(sourcePool, {
      host: sourceUrl.host,
      port: sourceUrl.port,
    }).identity(),
    migrationStoreFromPool(targetPool, {
      host: targetUrl.host,
      port: targetUrl.port,
      projectRef: EXPECTED_SUPABASE_REF,
    }).identity(),
  ]);
  if (
    sourceIdentity.database !== EXPECTED_SOURCE_DATABASE ||
    sourceIdentity.isRecovery ||
    sourceIdentity.isReadOnly ||
    sourceIdentity.tlsAuthorized !== true ||
    !safeHostMatch(sourceIdentity.tlsServername ?? undefined, sourceUrl.host)
  ) {
    throw new BackupFailure("source_is_not_verified_production_primary");
  }
  if (
    targetIdentity.database !== EXPECTED_SUPABASE_DATABASE ||
    targetIdentity.projectRef !== EXPECTED_SUPABASE_REF ||
    !safeHostMatch(targetUrl.host, EXPECTED_SUPABASE_HOST) ||
    targetIdentity.tlsAuthorized !== true ||
    !safeHostMatch(targetIdentity.tlsServername ?? undefined, targetUrl.host)
  ) {
    throw new BackupFailure("supabase_identity_or_strict_tls_verification_failed");
  }
}

async function main(): Promise<void> {
  const createNewBackups = process.argv.includes("--confirm-backup-and-restore");
  const resumeFailedSteps = process.argv.includes("--resume-failed-backups");
  const resumeSourceBackup = process.argv.includes("--resume-source-backup");
  const selectedModes = [createNewBackups, resumeFailedSteps, resumeSourceBackup].filter(Boolean).length;
  if (selectedModes !== 1) {
    console.log(
      "Choose one mode: --confirm-backup-and-restore, --resume-failed-backups, or --resume-source-backup.",
    );
    return;
  }

  const key = decodeBackupKey();
  let sourcePool: Pool | undefined;
  let targetConnection: ReturnType<typeof createSupabaseMigrationConnection> | undefined;
  let credentialTempDir: string | undefined;
  const backups: Array<{ manifest: DumpManifest; manifestPath: string; artifactPath: string }> = [];
  const newBackups: Array<{ manifest: DumpManifest; manifestPath: string; artifactPath: string }> = [];
  const failures: Array<{ target: string; errorCode: string }> = [];
  const diagnostics: PgDumpDiagnostic[] = [];
  try {
    await assertOutputProtection();
    if (resumeFailedSteps || resumeSourceBackup) {
      backups.push(...(await loadExistingBackups()));
      if (resumeSourceBackup) {
        const hasVerifiedSupabaseBackup = backups.some(
          (backup) =>
            backup.manifest.source.scope === "public_schema" &&
            backup.manifest.restore.status === "verified",
        );
        const hasSourceBackup = backups.some(
          (backup) => backup.manifest.source.scope === "full_database",
        );
        if (!hasVerifiedSupabaseBackup || hasSourceBackup) {
          throw new BackupFailure("source_only_resume_requires_supabase_backup_and_no_source_backup");
        }
      }
    } else {
      const existing = await readdir(OUTPUT_DIRECTORY).catch(() => []);
      if (existing.length > 0) {
        throw new BackupFailure("existing_artifacts_present_use_resume_mode");
      }
    }
    const [pgDump, pgRestore, postgres] = await Promise.all([
      getToolVersion("pg_dump"),
      getToolVersion("pg_restore"),
      getToolVersion("postgres"),
    ]);
    sourcePool = createAichmSourceMigrationPool();
    targetConnection = createSupabaseMigrationConnection();
    await verifyConnectionIdentities(sourcePool, targetConnection.pool);
    const [sourcePolicyRoles, targetPolicyRoles] = await Promise.all([
      getPolicyRoles(sourcePool, "full_database"),
      getPolicyRoles(targetConnection.pool, "public_schema"),
    ]);
    const policyRolesByScope: Record<Scope, string[]> = {
      full_database: sourcePolicyRoles,
      public_schema: targetPolicyRoles,
    };

    const targetPoolConfig = buildSupabaseMigrationPoolConfig();
    const targetCa = targetPoolConfig.ssl;
    if (!targetCa || typeof targetCa !== "object" || typeof targetCa.ca !== "string") {
      throw new BackupFailure("supabase_ca_unavailable_for_pg_dump");
    }

    const sourceVersionResult = await sourcePool.query<{ server_version_num: number }>(
      "SELECT current_setting('server_version_num')::int AS server_version_num",
    );
    const targetVersionResult = await targetConnection.pool.query<{ server_version_num: number }>(
      "SELECT current_setting('server_version_num')::int AS server_version_num",
    );
    const sourceMajor = Math.floor(sourceVersionResult.rows[0].server_version_num / 10000);
    const targetMajor = Math.floor(targetVersionResult.rows[0].server_version_num / 10000);
    if (
      pgDump.major < sourceMajor ||
      pgDump.major < targetMajor ||
      pgRestore.major < pgDump.major ||
      postgres.major !== pgRestore.major
    ) {
      throw new BackupFailure("postgres_tool_version_incompatible");
    }

    const allSpecs: Array<{
      id: "source-production" | "supabase-public";
      scope: Scope;
      pool: Pool;
      uri: string | undefined;
    }> = [
      {
        id: "source-production",
        scope: "full_database",
        pool: sourcePool,
        uri: process.env.AICHM_SOURCE_PROD_DATABASE_URL,
      },
      {
        id: "supabase-public",
        scope: "public_schema",
        pool: targetConnection.pool,
        uri: process.env.SUPABASE_DATABASE_URL,
      },
    ];
    const specsToDump = allSpecs.filter(
      (spec) => !backups.some((backup) => backup.manifest.source.scope === spec.scope),
    );

    if (specsToDump.length > 0) {
      await mkdir(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 });
      await chmod(OUTPUT_DIRECTORY, 0o700);
      credentialTempDir = await mkdtemp("/dev/shm/aichm-backup-creds-");
      await chmod(credentialTempDir, 0o700);
      const targetCaFile = path.join(credentialTempDir, "supabase-ca.pem");
      if (specsToDump.some((spec) => spec.scope === "public_schema")) {
        await writeFile(targetCaFile, targetCa.ca, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await chmod(targetCaFile, 0o600);
      }
      const configuredSpecs = allSpecs.map((spec) =>
        spec.scope === "public_schema"
          ? {
              ...spec,
              passFile: path.join(credentialTempDir!, `${spec.id}.pgpass`),
              targetCaFile,
            }
          : { ...spec, passFile: path.join(credentialTempDir!, `${spec.id}.pgpass`) },
      );
      const pendingSpecs = configuredSpecs.filter(
        (spec) => !backups.some((backup) => backup.manifest.source.scope === spec.scope),
      );

      for (const spec of pendingSpecs) {
        let snapshot: DatabaseSnapshot | undefined;
        try {
          snapshot = await beginSnapshot(spec.pool, spec.scope);
          const expectedMajor = Math.floor(snapshot.serverVersionNum / 10000);
          if (pgDump.major < expectedMajor) {
            throw new BackupFailure(`pg_dump_too_old_for_${spec.id}`);
          }
          const backup = await createEncryptedDump({
            ...spec,
            snapshot,
            pgDumpVersion: pgDump.text,
            tempDir: credentialTempDir,
            key,
          });
          backups.push(backup);
          newBackups.push(backup);
          await finishSnapshot(snapshot, true);
          snapshot = undefined;
        } catch (error) {
          if (error instanceof PgDumpFailure) {
            diagnostics.push(error.diagnostic);
          } else {
            failures.push({ target: spec.id, errorCode: safeCode(error) });
          }
        } finally {
          if (snapshot) await finishSnapshot(snapshot, false).catch(() => undefined);
        }
      }
    }

    if (credentialTempDir) {
      await rm(credentialTempDir, { recursive: true, force: true });
      credentialTempDir = undefined;
    }
    const backupsToRestore = resumeSourceBackup ? newBackups : backups;
    if (backupsToRestore.length) {
      try {
        failures.push(...(await restoreAll(backupsToRestore, key, policyRolesByScope)));
      } catch (error) {
        failures.push({ target: "isolated_restore", errorCode: safeCode(error) });
      }
    } else {
      if (diagnostics.length === 0) {
        failures.push({ target: "isolated_restore", errorCode: "no_valid_encrypted_artifacts" });
      }
    }

    if (resumeSourceBackup && diagnostics.length > 0) {
      console.log(
        JSON.stringify({
          status: "failed",
          diagnostic: diagnostics[0],
          sourceArtifactRetained: false,
          partialCiphertextRemoved: true,
          existingSupabaseBackupUnchanged: true,
          scratchRemoved: true,
          sourceDatabaseUnchanged: true,
          supabaseDatabaseUnchanged: true,
        }),
      );
      return;
    }

    console.log(
      JSON.stringify({
        pgDumpVersion: pgDump.text,
        pgRestoreVersion: pgRestore.text,
        isolatedPostgresMajor: postgres.major,
        artifacts: (resumeSourceBackup ? newBackups : backups).map(({ manifest, manifestPath, artifactPath }) => ({
          path: path.relative(process.cwd(), artifactPath),
          manifestPath: path.relative(process.cwd(), manifestPath),
          manifest,
        })),
        failures,
        diagnostics,
        scratchRemoved: true,
        sourceSchemaUnchanged: true,
        supabaseSchemaUnchanged: true,
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", errorCode: safeCode(error) }));
    process.exitCode = 2;
  } finally {
    key.fill(0);
    if (credentialTempDir) {
      await rm(credentialTempDir, { recursive: true, force: true });
    }
    await Promise.allSettled([
      sourcePool?.end(),
      targetConnection?.pool.end(),
    ]);
  }
}

void main();
