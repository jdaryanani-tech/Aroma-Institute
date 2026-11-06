import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDryRunOnly,
  buildMigrationDryRunPlan,
  type InventorySnapshot,
} from "../server/db/aichm-migration-plan";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepDirectory = path.join(projectRoot, "docs/aichm-supabase-migration-prep");

function readSnapshot(filename: string): InventorySnapshot {
  return JSON.parse(readFileSync(path.join(prepDirectory, filename), "utf8")) as InventorySnapshot;
}

try {
  assertDryRunOnly(process.argv.slice(2));
  const source = readSnapshot("source-production.json");
  const target = readSnapshot("supabase-target.json");
  const plan = buildMigrationDryRunPlan(source, target);
  console.log(JSON.stringify(plan, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Migration preparation stopped safely.";
  console.error(message);
  process.exitCode = 2;
}
