import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("isolated restore preserves template0 public schema and all archived source objects", () => {
  const scriptPath = fileURLToPath(
    new URL("../../script/create-aichm-encrypted-backups.ts", import.meta.url),
  );
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /createdb", \["--template=template0", dbName\]/);
  assert.doesNotMatch(source, /DROP SCHEMA IF EXISTS public CASCADE/);
  assert.match(source, /"--exit-on-error", "--single-transaction", "--no-owner", "--no-acl"/);
  assert.doesNotMatch(source, /--exclude-schema|--schema=/);
  assert.match(source, /const expectedNames = manifest\.source\.tables\.map/);
  assert.match(source, /JSON\.stringify\(restored\.tables\) === JSON\.stringify\(manifest\.source\.tables\)/);
});
