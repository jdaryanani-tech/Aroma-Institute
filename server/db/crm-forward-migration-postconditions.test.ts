import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import pg, { type QueryResult } from "pg";
import {
  buildCrmConstraintComparisonDiagnostic,
  postgresStoredConstraintName,
  safeCatalogIdentifierArray,
  type CrmConstraintCatalogRow,
} from "./crm-forward-migration-postconditions";

type FixtureRow = CrmConstraintCatalogRow & Record<string, unknown>;

const schema = "crm_test";
const parseNameArray = pg.types.getTypeParser(1003, "text");
const previousAssigneeConstraintName = "admissions_lead_assignment_history_previous_assignee_user_id_fkey";
const previousAssigneeStoredName = postgresStoredConstraintName(previousAssigneeConstraintName, {
  table: "admissions_lead_assignment_history",
  type: "f",
  columns: ["previous_assignee_user_id"],
});

function driverNameArray(values: string[]): unknown {
  return parseNameArray(`{${values.join(",")}}`);
}

function constraint(
  name: string,
  table_name: string,
  type: string,
  columns: string[],
  options: {
    ref_table?: string;
    ref_columns?: string[];
    check_expression?: string;
  } = {},
): FixtureRow {
  const foreignKey = type === "f";
  return {
    name,
    table_name,
    type,
    columns: driverNameArray(columns),
    ref_schema: foreignKey ? schema : null,
    ref_table: options.ref_table ?? null,
    ref_columns: foreignKey ? driverNameArray(options.ref_columns ?? []) : null,
    delete_action: foreignKey ? "r" : " ",
    update_action: foreignKey ? "a" : " ",
    match_type: foreignKey ? "s" : " ",
    validated: true,
    deferrable: false,
    initially_deferred: false,
    check_expression: options.check_expression ?? null,
  };
}

function expectedRows(): FixtureRow[] {
  return [
    constraint("admissions_lead_assignments_pkey", "admissions_lead_assignments", "p", ["lead_id"]),
    constraint("admissions_lead_assignments_lead_id_fkey", "admissions_lead_assignments", "f", ["lead_id"], {
      ref_table: "admissions_leads", ref_columns: ["id"],
    }),
    constraint("admissions_lead_assignments_assignee_user_id_fkey", "admissions_lead_assignments", "f", ["assignee_user_id"], {
      ref_table: "lms_users", ref_columns: ["id"],
    }),
    constraint("admissions_lead_assignments_assigned_by_fkey", "admissions_lead_assignments", "f", ["assigned_by"], {
      ref_table: "lms_users", ref_columns: ["id"],
    }),
    constraint("admissions_lead_assignments_version_ck", "admissions_lead_assignments", "c", ["version"], {
      check_expression: "version > 0",
    }),
    constraint("admissions_lead_assignment_history_pkey", "admissions_lead_assignment_history", "p", ["id"]),
    constraint("admissions_lead_assignment_history_lead_id_fkey", "admissions_lead_assignment_history", "f", ["lead_id"], {
      ref_table: "admissions_leads", ref_columns: ["id"],
    }),
    constraint(
      previousAssigneeStoredName,
      "admissions_lead_assignment_history",
      "f",
      ["previous_assignee_user_id"],
      { ref_table: "lms_users", ref_columns: ["id"] },
    ),
    constraint("admissions_lead_assignment_history_new_assignee_user_id_fkey", "admissions_lead_assignment_history", "f", ["new_assignee_user_id"], {
      ref_table: "lms_users", ref_columns: ["id"],
    }),
    constraint("admissions_lead_assignment_history_actor_user_id_fkey", "admissions_lead_assignment_history", "f", ["actor_user_id"], {
      ref_table: "lms_users", ref_columns: ["id"],
    }),
    constraint("admissions_lead_assignment_history_request_id_key", "admissions_lead_assignment_history", "u", ["request_id"]),
    constraint("admissions_lead_assignment_history_reason_ck", "admissions_lead_assignment_history", "c", ["reason"], {
      check_expression: "length(btrim(reason)) >= 3 AND length(btrim(reason)) <= 1000",
    }),
    constraint("admissions_lead_assignment_history_source_ck", "admissions_lead_assignment_history", "c", ["source"], {
      check_expression: "source = 'admin_ui'",
    }),
    constraint("admissions_lead_assignment_history_version_ck", "admissions_lead_assignment_history", "c", ["assignment_version"], {
      check_expression: "assignment_version > 0",
    }),
    constraint(
      "admissions_lead_assignment_history_changed_ck",
      "admissions_lead_assignment_history",
      "c",
      ["previous_assignee_user_id", "new_assignee_user_id"],
      { check_expression: "previous_assignee_user_id IS DISTINCT FROM new_assignee_user_id" },
    ),
  ];
}

function mismatchFields(rows: FixtureRow[], name: string): string[] {
  return buildCrmConstraintComparisonDiagnostic(schema, rows).mismatches
    .find(mismatch => mismatch.constraint === name)?.fields ?? [];
}

test("pg QueryResult rows with pg 8.16.3 name[] text values compare without drift", () => {
  const rows = expectedRows();
  const result: QueryResult<FixtureRow> = {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };

  assert.equal(typeof result.rows[0]?.columns, "string");
  assert.deepEqual(
    safeCatalogIdentifierArray(result.rows[0]?.columns),
    ["lead_id"],
  );
  const diagnostic = buildCrmConstraintComparisonDiagnostic(schema, result.rows);
  assert.equal(diagnostic.expectedCount, 15);
  assert.equal(diagnostic.actualCount, 15);
  assert.deepEqual(diagnostic.mismatches, []);
});

test("PostgreSQL identifier truncation is byte-bounded, deterministic, and collision-checked", () => {
  const stored = previousAssigneeStoredName;
  const diagnostic = buildCrmConstraintComparisonDiagnostic(schema, expectedRows());
  const expectedNames = diagnostic.expected.map(item => item.name);

  assert.equal(stored, "admissions_lead_assignment_histo_previous_assignee_user_id_fkey");
  assert.equal(Buffer.byteLength(stored, "utf8"), 63);
  assert.equal(new Set(expectedNames).size, expectedNames.length);
  assert.ok(expectedNames.includes(stored));
  assert.equal(expectedNames.includes(previousAssigneeConstraintName), false);
});

test("name[] normalization handles quoted, escaped, empty, and malformed values safely", () => {
  const quotedEscaped = String.raw`{"lead_id","comma,name","quote\"name","slash\\name"}`;
  assert.deepEqual(
    safeCatalogIdentifierArray(parseNameArray(quotedEscaped)),
    ["lead_id", "<invalid-identifier>", "<invalid-identifier>", "<invalid-identifier>"],
  );
  assert.deepEqual(safeCatalogIdentifierArray(parseNameArray("{}")), []);

  for (const malformed of [
    { rows: ["lead_id"] },
    42,
    "{lead_id,}",
    `{"unterminated}`,
    "{NULL}",
    "{lead_id",
  ]) {
    assert.throws(
      () => safeCatalogIdentifierArray(malformed),
      /CRM_SCHEMA_POSTCONDITION_CATALOG_ARRAY_INVALID/,
    );
  }
  assert.equal(safeCatalogIdentifierArray(null), null);
});

test("foreign-key postconditions reject every structural and action mismatch", () => {
  const foreignKeyName = "admissions_lead_assignments_lead_id_fkey";
  const mutations: Array<[string, (row: Record<string, unknown>) => void]> = [
    ["table", row => { row.table_name = "other_table"; }],
    ["columns", row => { row.columns = driverNameArray(["other_id"]); }],
    ["referencedSchema", row => { row.ref_schema = "other_schema"; }],
    ["referencedTable", row => { row.ref_table = "other_table"; }],
    ["referencedColumns", row => { row.ref_columns = driverNameArray(["other_id"]); }],
    ["onDelete", row => { row.delete_action = "c"; }],
    ["onUpdate", row => { row.update_action = "r"; }],
    ["match", row => { row.match_type = "f"; }],
    ["validated", row => { row.validated = false; }],
    ["deferrable", row => { row.deferrable = true; }],
    ["initiallyDeferred", row => { row.initially_deferred = true; }],
  ];

  for (const [field, mutate] of mutations) {
    const rows = expectedRows();
    const target = rows.find(row => row.name === foreignKeyName)!;
    mutate(target);
    assert.ok(
      mismatchFields(rows, foreignKeyName).includes(field),
      `foreign-key ${field} mismatch must be rejected`,
    );
  }
});

test("check expressions, unique constraint type, and unexpected constraints remain enforced", () => {
  const checkName = "admissions_lead_assignment_history_source_ck";
  const checkRows = expectedRows();
  checkRows.find(row => row.name === checkName)!.check_expression = "source = 'other'";
  assert.ok(mismatchFields(checkRows, checkName).includes("checkExpression"));

  const uniqueRows = expectedRows();
  uniqueRows.find(row => row.name === "admissions_lead_assignment_history_request_id_key")!.type = "c";
  assert.ok(mismatchFields(uniqueRows, "admissions_lead_assignment_history_request_id_key").includes("type"));

  const extraRows = expectedRows();
  extraRows.push(constraint("unexpected_extra_ck", "admissions_lead_assignments", "c", ["lead_id"]));
  assert.ok(buildCrmConstraintComparisonDiagnostic(schema, extraRows).mismatches
    .some(mismatch => mismatch.constraint === "unexpected_extra_ck" && mismatch.fields.includes("unexpected")));
});
