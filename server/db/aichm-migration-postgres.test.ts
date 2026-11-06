import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresMigrationStore } from "./aichm-migration-postgres";

test("schema introspection casts PostgreSQL name arrays to text arrays", async () => {
  let constraintQuery = "";
  const pool = {
    async query(sql: string) {
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [{
            column_name: "id",
            data_type: "integer",
            udt_name: "int4",
            is_nullable: "NO",
            column_default: null,
            character_maximum_length: null,
            numeric_precision: 32,
            numeric_scale: 0,
            ordinal_position: 1,
          }],
        };
      }
      constraintQuery = sql;
      return { rows: [{ contype: "p", columns: ["id"] }] };
    },
  } as unknown as Pool;

  const store = new PostgresMigrationStore(pool, "metadata-only.invalid", 5432);
  const metadata = await store.inspectTable("public", "sample");

  assert.match(constraintQuery, /array_agg\(a\.attname::text ORDER BY/);
  assert.deepEqual(metadata?.primaryKey, ["id"]);
  assert.deepEqual(metadata?.uniqueKeys, [["id"]]);
});
