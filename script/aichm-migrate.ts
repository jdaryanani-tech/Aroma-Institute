import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSupabaseMigrationConnection } from "../server/db/supabase-migration";
import { createAichmSourceMigrationPool } from "../server/db/aichm-source-migration";
import { migrationStoreFromPool } from "../server/db/aichm-migration-postgres";
import {
  assertApplyPrerequisites,
  runAichmMigration,
  type ApplyPrerequisiteInput,
  type BackupManifest,
  type OwnerApprovalManifest,
  type ReconciliationManifest,
  type SchemaVersionManifest,
  type SignedDocument,
} from "../server/db/aichm-migration-engine";
import { buildMigrationDryRunPlan, type InventorySnapshot } from "../server/db/aichm-migration-plan";

type Arguments = {
  mode: "snapshot" | "live-dry-run" | "apply";
  productionCutover: boolean;
  runId?: string;
  backupManifest?: string;
  reconciliationManifest?: string;
  schemaVersionManifest?: string;
  ownerApproval?: string;
};

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const inventoryDirectory = path.join(projectRoot, "docs/aichm-supabase-migration-prep");

function fail(message: string): never {
  throw new Error(message);
}

function parseArguments(args: string[]): Arguments {
  const result: Arguments = { mode: "snapshot", productionCutover: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) fail("Duplicate migration argument.");
    seen.add(arg);
    if (arg === "--dry-run") {
      result.mode = "snapshot";
    } else if (arg === "--live-dry-run") {
      result.mode = "live-dry-run";
    } else if (arg === "--apply") {
      result.mode = "apply";
    } else if (arg === "--production-cutover") {
      result.productionCutover = true;
    } else if (["--run-id", "--backup-manifest", "--reconciliation-manifest", "--schema-version-manifest", "--owner-approval"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value.`);
      if (arg === "--run-id") result.runId = value;
      if (arg === "--backup-manifest") result.backupManifest = value;
      if (arg === "--reconciliation-manifest") result.reconciliationManifest = value;
      if (arg === "--schema-version-manifest") result.schemaVersionManifest = value;
      if (arg === "--owner-approval") result.ownerApproval = value;
    } else {
      fail("Unsupported migration argument.");
    }
  }
  if (result.mode === "apply" && !result.productionCutover) {
    fail("Apply requires the distinct --production-cutover approval flag.");
  }
  if (result.mode !== "apply" && result.productionCutover) {
    fail("--production-cutover can only be used together with --apply.");
  }
  if (result.mode === "apply") {
    if (!result.runId || !result.backupManifest || !result.reconciliationManifest || !result.schemaVersionManifest || !result.ownerApproval) {
      fail("Apply requires a run ID and all four reviewed manifest files.");
    }
  }
  return result;
}

function readJson<T>(filename: string): T {
  try {
    return JSON.parse(readFileSync(path.resolve(filename), "utf8")) as T;
  } catch {
    fail("A required migration manifest could not be read or parsed.");
  }
}

function readSnapshot(filename: string): InventorySnapshot {
  return JSON.parse(readFileSync(path.join(inventoryDirectory, filename), "utf8")) as InventorySnapshot;
}

function sanitizedError(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code.replace(/[^A-Z0-9_]/gi, "").slice(0, 40)
      : "";
  return code ? `Migration halted safely (database error code ${code}).` : "Migration halted safely; no sensitive error details were written.";
}

function usage(): string {
  return [
    "AICHM migration tool",
    "  default / --dry-run      Snapshot-only plan; no database connections",
    "  --live-dry-run           Live metadata/row comparison; read-only opt-in",
    "  --apply --production-cutover --run-id <id> --backup-manifest <file>",
    "      --reconciliation-manifest <file> --schema-version-manifest <file>",
    "      --owner-approval <file>",
  ].join("\n");
}

async function liveRun(args: Arguments): Promise<void> {
  const isApply = args.mode === "apply";
  if (isApply && process.env.NODE_ENV !== "production") {
    fail("Production apply requires NODE_ENV=production.");
  }
  if (!isApply && process.env.NODE_ENV === "test") {
    fail("Live database access is disabled while NODE_ENV=test.");
  }

  const backupManifest = isApply ? readJson<BackupManifest>(args.backupManifest!) : undefined;
  const reconciliation = args.reconciliationManifest
    ? readJson<SignedDocument<ReconciliationManifest>>(args.reconciliationManifest)
    : undefined;
  const schemaVersion = isApply
    ? readJson<SignedDocument<SchemaVersionManifest>>(args.schemaVersionManifest!)
    : undefined;
  const ownerApproval = isApply
    ? readJson<SignedDocument<OwnerApprovalManifest>>(args.ownerApproval!)
    : undefined;
  const publicKey = process.env.AICHM_MIGRATION_APPROVAL_PUBLIC_KEY;

  const sourcePool = createAichmSourceMigrationPool();
  const targetConnection = createSupabaseMigrationConnection();
  try {
    const sourceUrl = new URL(process.env.AICHM_SOURCE_PROD_DATABASE_URL!);
    const targetUrl = new URL(process.env.SUPABASE_DATABASE_URL!);
    const source = migrationStoreFromPool(sourcePool, {
      host: sourceUrl.hostname,
      port: Number(sourceUrl.port || "5432"),
    });
    const target = migrationStoreFromPool(targetConnection.pool, {
      host: targetUrl.hostname,
      port: Number(targetUrl.port || "5432"),
      projectRef: "xylqezjvqqqjozenuygh",
    });

    let applyPrerequisites: ApplyPrerequisiteInput | undefined;
    if (isApply) {
      const [sourceIdentity, targetIdentity, leadRows, userRows] = await Promise.all([
        source.identity(),
        target.identity(),
        sourcePool.query<{ id: string }>('SELECT id FROM public.admissions_leads ORDER BY id'),
        sourcePool.query<{ id: number }>('SELECT id FROM public.lms_users ORDER BY id'),
      ]);
      applyPrerequisites = {
        flags: { apply: true, productionCutover: args.productionCutover },
        runtimeEnvironment: process.env.NODE_ENV ?? "",
        environment: process.env,
        backupManifest,
        reconciliation,
        schemaVersion,
        ownerApproval,
        approvalPublicKey: publicKey,
        sourceIdentity,
        targetIdentity,
        sourceLeadIds: leadRows.rows.map((row) => row.id),
        sourceLmsUserIds: userRows.rows.map((row) => row.id),
      };
      assertApplyPrerequisites(applyPrerequisites);
    }

    const plan = await runAichmMigration(source, target, {
      mode: isApply ? "apply" : "dry-run",
      runId: args.runId ?? `read-only-${randomUUID()}`,
      reconciliation: reconciliation?.document,
      applyPrerequisites,
      logger: (entry) => console.log(JSON.stringify(entry)),
    });
    console.log(JSON.stringify(plan, null, 2));
  } finally {
    await Promise.allSettled([sourcePool.end(), targetConnection.pool.end()]);
  }
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.mode === "snapshot") {
      const plan = buildMigrationDryRunPlan(
        readSnapshot("source-production.json"),
        readSnapshot("supabase-target.json"),
      );
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    await liveRun(args);
  } catch (error) {
    console.error(sanitizedError(error));
    process.exitCode = 2;
  }
}

if (process.argv.includes("--help")) {
  console.log(usage());
} else {
  void main();
}
