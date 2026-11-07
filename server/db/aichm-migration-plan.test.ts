import assert from "node:assert/strict";
import test from "node:test";
import {
  AICHM_MIGRATION_ORDER,
  assertOperationalDataCopyMode,
  FUTURE_CALENDAR_TABLES,
  assertDryRunOnly,
  buildMigrationDryRunPlan,
  validateMigrationOrder,
  type InventorySnapshot,
} from "./aichm-migration-plan";

const source: InventorySnapshot = {
  database: { database_name: "source" },
  tables: [
    { schema_name: "public", table_name: "lms_users", exact_rows: "2" },
    { schema_name: "public", table_name: "admissions_leads", exact_rows: "1" },
    { schema_name: "public", table_name: "inquiries", exact_rows: "8" },
  ],
};

const target: InventorySnapshot = {
  database: { database_name: "target" },
  tables: [
    { schema_name: "public", table_name: "leads", exact_rows: null },
    { schema_name: "public", table_name: "conversations", exact_rows: null },
    { schema_name: "public", table_name: "course_knowledge", exact_rows: null },
  ],
  exactTableCounts: [
    { schema: "public", table: "leads", exactRows: "31" },
    { schema: "public", table: "conversations", exactRows: "300" },
    { schema: "public", table: "course_knowledge", exactRows: "54" },
  ],
};

test("migration planning defaults to dry-run and refuses apply mode", () => {
  assert.doesNotThrow(() => assertDryRunOnly([]));
  assert.doesNotThrow(() => assertDryRunOnly(["--dry-run"]));
  assert.throws(() => assertDryRunOnly(["--apply"]), /Apply mode is not implemented/);
  assert.throws(() => assertDryRunOnly(["--production"]), /Only the default dry-run/);
});

test("the old operational Replit-to-Supabase data-copy apply path is disabled by the two-database architecture", () => {
  assert.doesNotThrow(() => assertOperationalDataCopyMode("snapshot"));
  assert.doesNotThrow(() => assertOperationalDataCopyMode("live-dry-run"));
  assert.throws(() => assertOperationalDataCopyMode("apply"), /disabled under the approved two-database architecture/);
});

test("migration order is deterministic and respects every declared foreign-key dependency", () => {
  assert.doesNotThrow(() => validateMigrationOrder());
  const index = new Map(AICHM_MIGRATION_ORDER.map((entry, position) => [entry.table, position]));
  for (const entry of AICHM_MIGRATION_ORDER) {
    for (const dependency of entry.dependsOn) {
      assert.ok(index.get(dependency)! < index.get(entry.table)!, `${dependency} precedes ${entry.table}`);
    }
  }
});

test("dry-run maps source tables to aichm and preserves existing public n8n tables", () => {
  const first = buildMigrationDryRunPlan(source, target);
  const second = buildMigrationDryRunPlan(source, target);
  assert.deepEqual(first, second);
  assert.equal(first.mode, "dry-run");
  assert.equal(first.writesEnabled, false);
  assert.equal(first.rowContentsRead, false);
  assert.equal(first.mappedTables.find((entry) => entry.target === "aichm.lms_users")?.sourceRows, "2");
  assert.equal(first.mappedTables.find((entry) => entry.target === "aichm.inquiries")?.sourceRows, "8");
  assert.equal(first.mappedTables.find((entry) => entry.target === "aichm.calendar_events")?.state, "future-calendar-schema");
  assert.ok(
    FUTURE_CALENDAR_TABLES.every(
      (table) => first.mappedTables.find((entry) => entry.target === `aichm.${table}`)?.state === "future-calendar-schema",
    ),
  );
  assert.equal(first.mappedTables.find((entry) => entry.target === "aichm.lms_lessons")?.state, "source-table-not-in-snapshot");
  assert.deepEqual(first.preservedTables.map((entry) => [entry.table, entry.rows]), [
    ["public.leads", "31"],
    ["public.conversations", "300"],
    ["public.course_knowledge", "54"],
  ]);
  assert.ok(first.mappedTables.every((entry) => entry.target.startsWith("aichm.")));
});

test("planning refuses same-named source and target database identities", () => {
  assert.throws(
    () =>
      buildMigrationDryRunPlan(
        { database: { database_name: "same" } },
        { database: { database_name: "same" } },
      ),
    /Source and target database names match/,
  );
});
