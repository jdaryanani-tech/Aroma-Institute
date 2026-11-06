import assert from "node:assert/strict";
import test from "node:test";
import { selectDumpScopes, selectRestoreBackups } from "./aichm-backup-restore-policy";

function backup(scope: "full_database" | "public_schema", name: string) {
  return { name, manifest: { source: { scope } } };
}

test("source-only restore selects exactly one production source artifact", () => {
  const source = backup("full_database", "source");
  const supabase = backup("public_schema", "supabase");

  assert.deepEqual(selectRestoreBackups([source, supabase], true), [source]);
  assert.deepEqual(selectRestoreBackups([supabase], true), []);
  assert.deepEqual(selectRestoreBackups([source, source], true), []);
  assert.deepEqual(selectRestoreBackups([source, supabase], false), [source, supabase]);
});

test("source refresh creates only a new production dump and preserves existing artifacts", () => {
  assert.deepEqual(
    selectDumpScopes("refresh_source", ["full_database", "public_schema"]),
    ["full_database"],
  );
  assert.deepEqual(selectDumpScopes("initial", []), ["full_database", "public_schema"]);
  assert.deepEqual(selectDumpScopes("initial", ["public_schema"]), ["full_database"]);
});
