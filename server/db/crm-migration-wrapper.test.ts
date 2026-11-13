import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CRM_MIGRATION_WRAPPER_ERROR,
  unwrapCrmMigration,
} from "./crm-migration-wrapper";

function assertInvalidWrapper(sql: string): void {
  assert.throws(
    () => unwrapCrmMigration(sql),
    { code: CRM_MIGRATION_WRAPPER_ERROR },
  );
}

test("accepts leading whitespace and line comments before BEGIN", () => {
  const body = unwrapCrmMigration(
    " \n\t-- migration notes\n-- second line\nBEGIN;\nSELECT 1;\nCOMMIT;\n",
  );
  assert.equal(body, "SELECT 1;");
});

test("accepts leading block comments including nested comments", () => {
  const body = unwrapCrmMigration(
    "/* migration /* nested */ notes */\nBEGIN;\nSELECT 2;\nCOMMIT;",
  );
  assert.equal(body, "SELECT 2;");
});

test("accepts consecutive mixed comments and whitespace before BEGIN", () => {
  const body = unwrapCrmMigration(
    "\n-- line one\n /* block one */ \t-- line two\n/* outer /* inner */ done */\nBEGIN;\nSELECT 3;\nCOMMIT;",
  );
  assert.equal(body, "SELECT 3;");
});

test("accepts the checked-in CRM migration files with explanatory leading comments", async () => {
  for (const file of [
    "migrations/0014_crm_canonical_assignments.sql",
    "migrations/0015_crm_assignment_audit_invariants.sql",
    "migrations/0016_crm_runtime_role_separation.sql",
  ]) {
    const sql = await readFile(file, "utf8");
    const body = unwrapCrmMigration(sql);
    assert.ok(body.length > 0, `${file} should have a non-empty transaction body`);
    assert.doesNotMatch(body, /^\s*BEGIN\s*;/i);
    assert.doesNotMatch(body, /;\s*COMMIT\s*;\s*$/i);
  }
});

test("ignores transaction words inside quoted strings and dollar-quoted function bodies", () => {
  const body = unwrapCrmMigration(
    "BEGIN;\nSELECT 'COMMIT; ROLLBACK;';\nDO $body$ BEGIN; COMMIT; END $body$;\nCOMMIT;",
  );
  assert.match(body, /SELECT 'COMMIT; ROLLBACK;';/);
  assert.match(body, /DO \$body\$ BEGIN; COMMIT; END \$body\$;/);
});

test("rejects executable statements before the required BEGIN wrapper", () => {
  assertInvalidWrapper("SELECT 1;\nBEGIN;\nSELECT 2;\nCOMMIT;");
  assertInvalidWrapper("-- comment\nCREATE TABLE unsafe(id integer);\nBEGIN;\nCOMMIT;");
});

test("rejects missing, expanded, or unterminated BEGIN wrappers", () => {
  assertInvalidWrapper("SELECT 1;\nCOMMIT;");
  assertInvalidWrapper("BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;");
  assertInvalidWrapper("BEGIN\nSELECT 1;\nCOMMIT;");
});

test("rejects nested transaction control and misplaced COMMIT or ROLLBACK", () => {
  assertInvalidWrapper("BEGIN;\nSELECT 1;\nBEGIN;\nSELECT 2;\nCOMMIT;\nCOMMIT;");
  assertInvalidWrapper("BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\nCOMMIT;");
  assertInvalidWrapper("BEGIN;\nROLLBACK;\nCOMMIT;");
  assertInvalidWrapper("BEGIN;\nSAVEPOINT nested;\nCOMMIT;");
});

test("rejects missing terminal COMMIT, trailing executable SQL, and empty wrappers", () => {
  assertInvalidWrapper("BEGIN;\nSELECT 1;");
  assertInvalidWrapper("BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;");
  assertInvalidWrapper("BEGIN;\nCOMMIT;");
  assertInvalidWrapper("BEGIN;\nSELECT 1;\nCOMMIT");
});

test("rejects malformed block comments, stray comment terminators, and unterminated quotes", () => {
  assertInvalidWrapper("/* never closed\nBEGIN;\nSELECT 1;\nCOMMIT;");
  assertInvalidWrapper("*/\nBEGIN;\nSELECT 1;\nCOMMIT;");
  assertInvalidWrapper("BEGIN;\nSELECT 'unterminated;\nCOMMIT;");
  assertInvalidWrapper("BEGIN;\nDO $body$ unclosed;\nCOMMIT;");
});
