import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationStoreFromPool } from "../server/db/aichm-migration-postgres";
import { createAichmSourceMigrationPool } from "../server/db/aichm-source-migration";
import {
  AICHM_STAGE1_ENUM_TYPES,
  AICHM_STAGE1_TABLES,
  buildAichmStage1ApplicationSql,
  type EnumDefinition,
} from "../server/db/aichm-schema-stage1";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "supabase/migrations/20261106_aichm_app_schema_v1.sql");

function escapePgpass(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function requiredSourceUrl(): URL {
  const raw = process.env.AICHM_SOURCE_PROD_DATABASE_URL?.trim();
  if (!raw) throw new Error("AICHM_SOURCE_PROD_DATABASE_URL is required.");
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.pathname !== "/neondb" ||
    !url.hostname ||
    !url.password
  ) {
    throw new Error("The configured source is not the approved production database.");
  }
  return url;
}

function runSchemaDump(url: URL, passFile: string): string {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.dirname(passFile),
    TMPDIR: path.dirname(passFile),
    LANG: "C",
    LC_ALL: "C",
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGPASSFILE: passFile,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "system",
    PGOPTIONS: "-c timezone=UTC",
    PGAPPNAME: "aichm-stage1-schema-only",
  };
  const args = [
    "--schema-only",
    "--no-owner",
    "--no-acl",
    "--no-comments",
    "--no-security-labels",
    "--schema=public",
    ...AICHM_STAGE1_TABLES.map((table) => `--table=public.${table}`),
  ];
  const result = spawnSync("pg_dump", args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    throw new Error("The metadata-only source schema export failed safely.");
  }
  return result.stdout;
}

async function readEnumDefinitions(): Promise<EnumDefinition[]> {
  const pool = createAichmSourceMigrationPool();
  try {
    const result = await pool.query<{ type_name: string; label: string }>(
      `SELECT t.typname AS type_name, e.enumlabel AS label
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname = 'public' AND t.typname = ANY($1::text[])
       ORDER BY t.typname, e.enumsortorder`,
      [[...AICHM_STAGE1_ENUM_TYPES]],
    );
    const grouped = new Map<string, string[]>();
    for (const row of result.rows) {
      const labels = grouped.get(row.type_name) ?? [];
      labels.push(row.label);
      grouped.set(row.type_name, labels);
    }
    return [...grouped].map(([name, labels]) => ({ name, labels }));
  } finally {
    await pool.end();
  }
}

async function main() {
  if (process.argv.slice(2).join(" ") !== "--write") {
    throw new Error("Run this metadata-only generator with the explicit --write flag.");
  }

  const sourceUrl = requiredSourceUrl();
  const pool = createAichmSourceMigrationPool();
  let temporaryDirectory: string | undefined;
  try {
    const store = migrationStoreFromPool(pool, {
      host: sourceUrl.hostname,
      port: Number(sourceUrl.port || "5432"),
    });
    const identity = await store.identity();
    if (
      identity.database !== "neondb" ||
      identity.isRecovery ||
      identity.isReadOnly ||
      !identity.tlsAuthorized ||
      identity.tlsServername !== identity.host
    ) {
      throw new Error("The source identity or strict TLS verification failed.");
    }

    const tableResult = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [[...AICHM_STAGE1_TABLES]],
    );
    if (tableResult.rows.length !== AICHM_STAGE1_TABLES.length) {
      throw new Error("The production source table set does not match the reviewed Stage 1 allowlist.");
    }

    const version = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
    if (version.status !== 0 || !/^pg_dump \(PostgreSQL\) 17\./.test(version.stdout.trim())) {
      throw new Error("A compatible pg_dump 17 client is required.");
    }

    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "aichm-schema-export-"));
    await chmod(temporaryDirectory, 0o700);
    const pgpassPath = path.join(temporaryDirectory, "pgpass");
    const passEntry = [
      sourceUrl.hostname,
      sourceUrl.port || "5432",
      decodeURIComponent(sourceUrl.pathname.slice(1)),
      decodeURIComponent(sourceUrl.username),
      decodeURIComponent(sourceUrl.password),
    ].map(escapePgpass).join(":");
    await writeFile(pgpassPath, `${passEntry}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(pgpassPath, 0o600);

    const [schemaDump, enumDefinitions] = await Promise.all([
      Promise.resolve(runSchemaDump(sourceUrl, pgpassPath)),
      readEnumDefinitions(),
    ]);
    const migrationSql = buildAichmStage1ApplicationSql(schemaDump, enumDefinitions);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, migrationSql, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(outputPath, 0o600);

    console.log(JSON.stringify({
      generated: true,
      migrationVersion: "aichm-app-schema-v1",
      tableCount: AICHM_STAGE1_TABLES.length,
      enumTypeCount: enumDefinitions.length,
      pgDumpVersion: version.stdout.trim(),
      migrationBytes: Buffer.byteLength(migrationSql),
      migrationSha256: createHash("sha256").update(migrationSql).digest("hex"),
      file: path.relative(projectRoot, outputPath),
      rowDataRequested: false,
    }));
  } finally {
    await pool.end();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error("AICHM schema generation stopped safely; no connection details or raw database errors were logged.");
  process.exitCode = 2;
});
