import { createDecipheriv, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Pool } from "pg";
import { stopConfirmAndRemoveScratchPostgres } from "../server/db/aichm-scratch-postgres-cleanup";

const OUTPUT_DIRECTORY = path.resolve(".local/aichm-backup-export");
const BASELINE_SQL = path.resolve(
  "migrations/aichm-forward/0000_aichm_forward_baseline.sql",
);
const BASELINE_JOURNAL = path.resolve(
  "migrations/aichm-forward/meta/_journal.json",
);
const BASELINE_SCHEMA = "aichm_forward_migration_meta";
const BASELINE_TABLE = "__drizzle_migrations";

type Manifest = {
  createdAt: string;
  source: {
    database: string;
    scope: string;
    serverVersion: string;
    tables: Array<{ schema: string; table: string; rows: string }>;
  };
  dump: { plaintextSha256: string };
  artifact: {
    filename: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
  };
  encryption: { algorithm: string; ivHex: string; tagHex: string };
};

type CleanupState = "running" | "stopped" | "unknown";

class SafeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new SafeFailure(code);
}

function runTool(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: "ignore" | "capture" = "ignore",
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: stdio === "capture" ? ["ignore", "pipe", "ignore"] : "ignore",
      });
    } catch {
      reject(new SafeFailure("scratch_tool_unavailable"));
      return;
    }
    let stdout = "";
    if (stdio === "capture") {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }
    child.once("error", () => reject(new SafeFailure("scratch_tool_unavailable")));
    child.once("close", (code) =>
      resolve({ code: code ?? 1, stdout: stdout.trim() }),
    );
  });
}

function childExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function localPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new SafeFailure("scratch_port_unavailable")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new SafeFailure("scratch_port_unavailable"));
        return;
      }
      server.close((error) =>
        error
          ? reject(new SafeFailure("scratch_port_unavailable"))
          : resolve(address.port),
      );
    });
  });
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    fail("manifest_identifier_invalid");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createDigestTransform(hash: ReturnType<typeof createHash>, counter: { bytes: number }) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      counter.bytes += chunk.length;
      callback(null, chunk);
    },
  });
}

function safeRoles(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const roles = JSON.parse(raw);
    if (
      !Array.isArray(roles) ||
      roles.some(
        (role) =>
          typeof role !== "string" ||
          role.length === 0 ||
          role.length > 63 ||
          role.includes("\0"),
      )
    ) {
      fail("restore_policy_roles_invalid");
    }
    return [...new Set(roles)];
  } catch {
    fail("restore_policy_roles_invalid");
  }
}

async function getTableCounts(
  pool: Pool,
  manifest: Manifest,
): Promise<Array<{ schema: string; table: string; rows: string }>> {
  const client = await pool.connect();
  try {
    const result = [];
    for (const item of manifest.source.tables) {
      const count = await client.query(
        `SELECT count(*)::text AS rows FROM ${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`,
      );
      result.push({
        schema: item.schema,
        table: item.table,
        rows: count.rows[0]?.rows ?? "0",
      });
    }
    return result;
  } finally {
    client.release();
  }
}

async function getTableNames(
  pool: Pool,
  excludeBaselineMetadata: boolean,
): Promise<Array<{ schema: string; table: string }>> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT n.nspname AS schema,c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE $1 AND n.nspname<>$2 AND c.relkind IN ($3,$4,$5) AND ($6::boolean=false OR n.nspname<>$7) ORDER BY n.nspname,c.relname",
      [
        "pg_%",
        "information_schema",
        "r",
        "p",
        "m",
        excludeBaselineMetadata,
        BASELINE_SCHEMA,
      ],
    );
    return result.rows;
  } finally {
    client.release();
  }
}

async function schemaFingerprint(pool: Pool): Promise<string> {
  const client = await pool.connect();
  try {
    const exclusion = ["pg_catalog", "information_schema", BASELINE_SCHEMA];
    const [relations, columns, constraints, indexes, enumLabels, policies, triggers, grants] =
      await Promise.all([
        client.query(
          "SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>ALL($1::text[]) AND n.nspname NOT LIKE $2 AND c.relkind IN ($3,$4,$5,$6,$7) ORDER BY n.nspname,c.relname",
          [exclusion, "pg_%", "r", "p", "v", "m", "S"],
        ),
        client.query(
          "SELECT table_schema,table_name,ordinal_position,column_name,data_type,udt_name,is_nullable,column_default,is_identity,identity_generation,is_generated,generation_expression FROM information_schema.columns WHERE table_schema<>ALL($1::text[]) AND table_schema NOT LIKE $2 ORDER BY table_schema,table_name,ordinal_position",
          [exclusion, "pg_%"],
        ),
        client.query(
          "SELECT n.nspname AS schema,rel.relname AS table,con.conname AS name,con.contype AS kind,pg_get_constraintdef(con.oid,true) AS definition FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname<>ALL($1::text[]) AND n.nspname NOT LIKE $2 ORDER BY n.nspname,rel.relname,con.conname",
          [exclusion, "pg_%"],
        ),
        client.query(
          "SELECT schemaname AS schema,tablename AS table,indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname<>ALL($1::text[]) AND schemaname NOT LIKE $2 ORDER BY schemaname,tablename,indexname",
          [exclusion, "pg_%"],
        ),
        client.query(
          "SELECT n.nspname AS schema,t.typname AS type,e.enumsortorder AS position,e.enumlabel AS label FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname<>ALL($1::text[]) AND n.nspname NOT LIKE $2 ORDER BY n.nspname,t.typname,e.enumsortorder",
          [exclusion, "pg_%"],
        ),
        client.query(
          "SELECT schemaname AS schema,tablename AS table,policyname AS name,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname<>ALL($1::text[]) AND schemaname NOT LIKE $2 ORDER BY schemaname,tablename,policyname",
          [exclusion, "pg_%"],
        ),
        client.query(
          "SELECT n.nspname AS schema,c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname<>ALL($1::text[]) AND n.nspname NOT LIKE $2 ORDER BY n.nspname,c.relname,t.tgname",
          [exclusion, "pg_%"],
        ),
        client.query(
          "SELECT table_schema,table_name,grantee,privilege_type,is_grantable FROM information_schema.role_table_grants WHERE table_schema<>ALL($1::text[]) AND table_schema NOT LIKE $2 ORDER BY table_schema,table_name,grantee,privilege_type",
          [exclusion, "pg_%"],
        ),
      ]);
    const canonical = {
      relations: relations.rows,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      enumLabels: enumLabels.rows,
      policies: policies.rows,
      triggers: triggers.rows,
      grants: grants.rows,
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  } finally {
    client.release();
  }
}

async function inspectState(dataDir: string, env: NodeJS.ProcessEnv): Promise<CleanupState> {
  const result = await runTool("pg_ctl", ["--pgdata", dataDir, "status"], env).catch(() => null);
  if (!result) return "unknown";
  if (result.code === 0) return "running";
  if (result.code === 3) return "stopped";
  return "unknown";
}

async function removeScratch(dataDir: string, root: string, env: NodeJS.ProcessEnv) {
  const cleanup = await stopConfirmAndRemoveScratchPostgres({
    inspectState: () => inspectState(dataDir, env),
    stop: async () => {
      const result = await runTool(
        "pg_ctl",
        ["--pgdata", dataDir, "--mode=fast", "--wait", "stop"],
        env,
      );
      if (result.code !== 0) fail("scratch_postgres_stop_failed");
    },
    removeScratch: async () => rm(root, { recursive: true, force: true }),
  });
  return cleanup;
}

async function main(): Promise<void> {
  const manifestName = process.argv[2];
  if (
    !manifestName ||
    path.basename(manifestName) !== manifestName ||
    !/^aichm-source-production-[A-Za-z0-9T._-]+\.manifest\.json$/.test(manifestName)
  ) {
    fail("source_manifest_filename_required");
  }

  let key: Buffer | undefined;
  let scratchRoot: string | undefined;
  let scratchDataDir: string | undefined;
  let localEnv: NodeJS.ProcessEnv | undefined;
  let serverStarted = false;
  let report: Record<string, unknown> | undefined;
  let failureCode: string | undefined;
  try {
    const folderStat = await stat(OUTPUT_DIRECTORY);
    if ((folderStat.mode & 0o777) !== 0o700) fail("backup_directory_permissions_invalid");
    const manifestPath = path.join(OUTPUT_DIRECTORY, manifestName);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    if (
      manifest.source.database !== "neondb" ||
      manifest.source.scope !== "full_database" ||
      manifest.artifact.filename !== manifestName.replace(/\.manifest\.json$/, ".dump.aesgcm") ||
      manifest.encryption.algorithm !== "AES-256-GCM" ||
      manifest.source.tables.length === 0
    ) {
      fail("source_manifest_scope_invalid");
    }
    const artifactPath = path.join(OUTPUT_DIRECTORY, manifest.artifact.filename);
    const artifactStat = await stat(artifactPath);
    if (
      (artifactStat.mode & 0o777) !== 0o600 ||
      artifactStat.size !== manifest.artifact.ciphertextBytes
    ) {
      fail("encrypted_artifact_metadata_mismatch");
    }
    const keyValue = process.env.AICHM_BACKUP_ENCRYPTION_KEY;
    if (!keyValue) fail("backup_key_unavailable");
    key = Buffer.from(keyValue, "base64");
    if (key.length !== 32) fail("backup_key_length_invalid");

    const versionResults = await Promise.all(
      ["postgres", "pg_ctl", "initdb", "createdb", "pg_restore"].map((tool) =>
        runTool(tool, ["--version"], process.env, "capture"),
      ),
    );
    const versions = versionResults.map((result) => result.stdout);
    if (
      versionResults.some((result) => result.code !== 0) ||
      versions.some((version) => !/\b17\.\d+\b/.test(version))
    ) {
      fail("scratch_postgres_tools_must_be_major_17");
    }

    const roles = safeRoles(process.env.AICHM_SCRATCH_POLICY_ROLES);
    scratchRoot = await mkdtemp("/dev/shm/aichm-forward-restore-");
    await chmod(scratchRoot, 0o700);
    scratchDataDir = path.join(scratchRoot, "data");
    const socketDir = path.join(scratchRoot, "socket");
    await mkdir(socketDir, { mode: 0o700 });
    const port = await localPort();
    localEnv = {
      PATH: process.env.PATH,
      HOME: scratchRoot,
      TMPDIR: scratchRoot,
      LANG: "C",
      LC_ALL: "C",
    };
    const init = await runTool(
      "initdb",
      [
        "--pgdata",
        scratchDataDir,
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-instructions",
      ],
      localEnv,
    );
    if (init.code !== 0) fail("scratch_postgres_init_failed");
    const start = await runTool(
      "pg_ctl",
      [
        "--pgdata",
        scratchDataDir,
        "--log",
        path.join(scratchRoot, "postgres.log"),
        "--options",
        `-h 127.0.0.1 -p ${port} -k ${socketDir} -c listen_addresses=127.0.0.1`,
        "--wait",
        "start",
      ],
      localEnv,
    );
    if (start.code !== 0) fail("scratch_postgres_start_failed");
    serverStarted = true;

    const admin = new Pool({
      host: socketDir,
      port,
      user: "postgres",
      database: "postgres",
      ssl: false,
      connectionTimeoutMillis: 5_000,
    });
    try {
      const client = await admin.connect();
      try {
        for (const role of roles) {
          const roleResult = await client.query(
            "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists",
            [role],
          );
          if (!roleResult.rows[0]?.exists) {
            const quoted = `"${role.replaceAll('"', '""')}"`;
            await client.query(`CREATE ROLE ${quoted} NOLOGIN`);
          }
        }
      } finally {
        client.release();
      }
    } finally {
      await admin.end();
    }

    const databaseName = `aichm_forward_scratch_${process.pid}_${Date.now()}`;
    const createdb = await runTool(
      "createdb",
      [
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=postgres",
        "--template=template0",
        databaseName,
      ],
      localEnv,
    );
    if (createdb.code !== 0) fail("scratch_database_create_failed");

    const cipherHash = createHash("sha256");
    const plainHash = createHash("sha256");
    const cipherCounter = { bytes: 0 };
    const plainCounter = { bytes: 0 };
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(manifest.encryption.ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(manifest.encryption.tagHex, "hex"));
    const restore = spawn(
      "pg_restore",
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-acl",
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=postgres",
        `--dbname=${databaseName}`,
      ],
      { env: localEnv, stdio: ["pipe", "ignore", "ignore"] },
    );
    const restoreExit = childExit(restore);
    try {
      await pipeline(
        createReadStream(artifactPath),
        createDigestTransform(cipherHash, cipherCounter),
        decipher,
        createDigestTransform(plainHash, plainCounter),
        restore.stdin!,
      );
    } catch {
      restore.kill("SIGTERM");
      await restoreExit;
      fail("encrypted_archive_authentication_failed");
    }
    const pgRestoreExitCode = await restoreExit;
    const ciphertextSha256 = cipherHash.digest("hex");
    const plaintextSha256 = plainHash.digest("hex");
    if (
      pgRestoreExitCode !== 0 ||
      cipherCounter.bytes !== manifest.artifact.ciphertextBytes ||
      ciphertextSha256 !== manifest.artifact.ciphertextSha256 ||
      plaintextSha256 !== manifest.dump.plaintextSha256
    ) {
      fail("scratch_pg_restore_or_checksum_failed");
    }

    const restoredPool = new Pool({
      host: socketDir,
      port,
      user: "postgres",
      database: databaseName,
      ssl: false,
      connectionTimeoutMillis: 5_000,
    });
    try {
      const beforeNames = await getTableNames(restoredPool, false);
      const expectedNames = manifest.source.tables.map(({ schema, table }) => ({
        schema,
        table,
      }));
      if (JSON.stringify(beforeNames) !== JSON.stringify(expectedNames)) {
        fail("scratch_restore_table_list_mismatch");
      }
      const beforeCounts = await getTableCounts(restoredPool, manifest);
      const expectedRows = manifest.source.tables.map((item) => ({
        schema: item.schema,
        table: item.table,
        rows: item.rows,
      }));
      if (JSON.stringify(beforeCounts) !== JSON.stringify(expectedRows)) {
        fail("scratch_restore_row_counts_mismatch");
      }
      const beforeFingerprint = await schemaFingerprint(restoredPool);

      const migrationSql = await readFile(BASELINE_SQL, "utf8");
      const journal = JSON.parse(await readFile(BASELINE_JOURNAL, "utf8")) as {
        entries: Array<{ idx: number; when: number; tag: string }>;
      };
      if (
        journal.entries.length !== 1 ||
        journal.entries[0]?.tag !== "0000_aichm_forward_baseline" ||
        migrationSql
          .split(/\r?\n/)
          .some((line) => line.trim() && !line.trim().startsWith("--"))
      ) {
        fail("baseline_migration_not_noop");
      }

      const url = `postgresql://postgres@127.0.0.1:${port}/${databaseName}`;
      const migrationEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: scratchRoot,
        TMPDIR: scratchRoot,
        LANG: "C",
        LC_ALL: "C",
        NODE_ENV: "test",
        AICHM_FORWARD_TARGET: "scratch",
        AICHM_FORWARD_DATABASE_URL: url,
      };
      const migrate = await runTool(
        path.resolve("node_modules/.bin/drizzle-kit"),
        ["migrate", "--config=drizzle.aichm-forward.config.ts"],
        migrationEnv,
      );
      if (migrate.code !== 0) fail("forward_baseline_migration_failed");

      const afterCounts = await getTableCounts(restoredPool, manifest);
      const afterNames = await getTableNames(restoredPool, true);
      const afterFingerprint = await schemaFingerprint(restoredPool);
      const ledger = await restoredPool.query(
        `SELECT count(*)::int AS count,min(hash) AS hash,min(created_at)::text AS created_at FROM ${quoteIdentifier(BASELINE_SCHEMA)}.${quoteIdentifier(BASELINE_TABLE)}`,
      );
      const expectedHash = createHash("sha256").update(migrationSql).digest("hex");
      if (
        JSON.stringify(afterCounts) !== JSON.stringify(expectedRows) ||
        JSON.stringify(afterNames) !== JSON.stringify(expectedNames) ||
        beforeFingerprint !== afterFingerprint ||
        ledger.rows[0]?.count !== 1 ||
        ledger.rows[0]?.hash !== expectedHash ||
        Number(ledger.rows[0]?.created_at) !== journal.entries[0]?.when
      ) {
        fail("baseline_validation_failed");
      }
      const totalRows = expectedRows.reduce((sum, row) => sum + BigInt(row.rows), 0n);
      report = {
        status: "verified",
        checkedAt: new Date().toISOString(),
        artifact: manifest.artifact.filename,
        sourceSnapshotAt: manifest.createdAt,
        localPostgresVersion: versions[0],
        pgRestoreExitCode,
        archiveAuthentication: "verified",
        ciphertextBytes: cipherCounter.bytes,
        ciphertextSha256,
        ciphertextSha256Matches: true,
        plaintextSha256,
        plaintextSha256Matches: true,
        restoredTableCount: beforeCounts.length,
        restoredRowTotal: totalRows.toString(),
        restoredTableListAndCountsMatch: true,
        baseline: {
          drizzleKitVersion: "0.31.8",
          migrationTag: journal.entries[0].tag,
          migrationSqlHasNoExecutableStatements: true,
          customLedgerSchema: BASELINE_SCHEMA,
          customLedgerTable: BASELINE_TABLE,
          ledgerRowsAfterRun: ledger.rows[0].count,
          recordedHashMatchesMigrationFile: true,
        },
        applicationSchemaFingerprintBefore: beforeFingerprint,
        applicationSchemaFingerprintAfter: afterFingerprint,
        applicationSchemaUnchanged: true,
        applicationRowCountsUnchanged: true,
        scratchRemoved: false,
      };
    } finally {
      await restoredPool.end();
    }
  } catch (error) {
    failureCode = error instanceof SafeFailure ? error.code : "baseline_rehearsal_failed";
  } finally {
    key?.fill(0);
    if (scratchRoot && scratchDataDir && localEnv) {
      const cleanup = await removeScratch(scratchDataDir, scratchRoot, localEnv);
      if (!cleanup.ok) {
        failureCode = cleanup.errorCode;
        report = {
          ...(report ?? {}),
          status: "failed",
          scratchRemoved: false,
          ...(cleanup.scratchPreserved ? { scratchPreservedPath: scratchRoot } : {}),
        };
      } else if (report) {
        report.scratchRemoved = true;
      }
    } else if (scratchRoot && !serverStarted) {
      // If initdb did not produce a usable data directory, status cannot be
      // proven. Preserve the directory instead of making a best-effort delete.
      failureCode ??= "scratch_postgres_state_uncertain";
      report = {
        ...(report ?? {}),
        status: "failed",
        scratchRemoved: false,
        scratchPreservedPath: scratchRoot,
      };
    }
  }

  if (report && !failureCode && report.status === "verified" && report.scratchRemoved === true) {
    const name = `aichm-forward-baseline-rehearsal-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    await writeFile(path.join(OUTPUT_DIRECTORY, name), `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify({ ...report, evidenceFile: name }));
    return;
  }

  console.log(
    JSON.stringify({
      status: "failed",
      errorCode: failureCode ?? "baseline_report_not_verified",
      ...(report ?? {}),
    }),
  );
  process.exitCode = 2;
}

void main().catch(() => {
  console.log(JSON.stringify({ status: "failed", errorCode: "baseline_rehearsal_failed" }));
  process.exitCode = 2;
});
