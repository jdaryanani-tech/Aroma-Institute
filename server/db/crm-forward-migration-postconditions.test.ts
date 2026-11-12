import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import pg, { type QueryResult } from "pg";
import {
  buildCrmIndexComparisonDiagnostic,
  buildCrmConstraintComparisonDiagnostic,
  postgresStoredConstraintName,
  postgresStoredIndexName,
  safeCatalogIdentifierArray,
  type CrmConstraintCatalogRow,
  type CrmIndexCatalogRow,
  type IndexKeySpec,
} from "./crm-forward-migration-postconditions";

type FixtureRow = CrmConstraintCatalogRow & Record<string, unknown>;

const schema = "crm_test";
const parseNameArray = pg.types.getTypeParser(1003, "text");
const parseJsonb = pg.types.getTypeParser(3802, "text");
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

type FixtureIndexRow = CrmIndexCatalogRow & Record<string, unknown>;

function driverJsonb(value: unknown): unknown {
  return parseJsonb(JSON.stringify(value));
}

function indexKey(
  column: string,
  position: number,
  opclassName: string,
  options: Partial<IndexKeySpec> = {},
): IndexKeySpec {
  return {
    position,
    column,
    definition: column,
    descending: false,
    nullsFirst: false,
    collationSchema: null,
    collationName: null,
    opclassSchema: "pg_catalog",
    opclassName,
    ...options,
  };
}

function indexRow(
  name: string,
  table_name: string,
  keys: IndexKeySpec[],
  options: {
    unique?: boolean;
    primary?: boolean;
    constraint_name?: string | null;
    constraint_type?: string | null;
    included_columns?: string[];
    predicate?: string | null;
    expressions?: string | null;
    valid?: boolean;
    ready?: boolean;
    live?: boolean;
  } = {},
): FixtureIndexRow {
  const includedColumns = options.included_columns ?? [];
  const uniqueness = options.unique ?? false ? "UNIQUE " : "";
  return {
    name,
    table_name,
    method: "btree",
    unique: options.unique ?? false,
    primary: options.primary ?? false,
    constraint_name: options.constraint_name ?? null,
    constraint_type: options.constraint_type ?? null,
    valid: options.valid ?? true,
    ready: options.ready ?? true,
    live: options.live ?? true,
    key_count: keys.length,
    attr_count: keys.length + includedColumns.length,
    key_details: driverJsonb(keys),
    included_columns: driverJsonb(includedColumns),
    predicate: options.predicate ?? null,
    expressions: options.expressions ?? null,
    definition: `CREATE ${uniqueness}INDEX ${name} ON ${schema}.${table_name} USING btree (${keys.map(key => key.definition).join(", ")})`,
  };
}

function expectedIndexRows(): FixtureIndexRow[] {
  return [
    indexRow("admissions_lead_assignments_pkey", "admissions_lead_assignments", [
      indexKey("lead_id", 1, "uuid_ops"),
    ], { unique: true, primary: true, constraint_name: "admissions_lead_assignments_pkey", constraint_type: "p" }),
    indexRow("admissions_lead_assignments_assignee_idx", "admissions_lead_assignments", [
      indexKey("assignee_user_id", 1, "int4_ops"),
      indexKey("lead_id", 2, "uuid_ops"),
    ]),
    indexRow("admissions_lead_assignment_history_pkey", "admissions_lead_assignment_history", [
      indexKey("id", 1, "uuid_ops"),
    ], { unique: true, primary: true, constraint_name: "admissions_lead_assignment_history_pkey", constraint_type: "p" }),
    indexRow("admissions_lead_assignment_history_request_id_key", "admissions_lead_assignment_history", [
      indexKey("request_id", 1, "uuid_ops"),
    ], { unique: true, constraint_name: "admissions_lead_assignment_history_request_id_key", constraint_type: "u" }),
    indexRow("admissions_lead_assignment_history_lead_time_idx", "admissions_lead_assignment_history", [
      indexKey("lead_id", 1, "uuid_ops"),
      indexKey("changed_at", 2, "timestamptz_ops"),
    ]),
    indexRow("admissions_lead_assignment_history_assignee_time_idx", "admissions_lead_assignment_history", [
      indexKey("new_assignee_user_id", 1, "int4_ops"),
      indexKey("changed_at", 2, "timestamptz_ops"),
    ]),
    indexRow("admissions_lead_assignment_history_lead_version_uidx", "admissions_lead_assignment_history", [
      indexKey("lead_id", 1, "uuid_ops"),
      indexKey("assignment_version", 2, "int4_ops"),
    ], { unique: true }),
  ];
}

function indexMismatchFields(rows: FixtureIndexRow[], name: string): string[] {
  return buildCrmIndexComparisonDiagnostic(schema, rows).mismatches
    .find(mismatch => mismatch.index === name)?.fields ?? [];
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

test("pg QueryResult rows normalize JSONB catalog index metadata and match all seven migration indexes", () => {
  const rows = expectedIndexRows();
  const result: QueryResult<FixtureIndexRow> = {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };

  assert.ok(Array.isArray(result.rows[0]?.key_details));
  assert.ok(Array.isArray(result.rows[0]?.included_columns));
  const diagnostic = buildCrmIndexComparisonDiagnostic(schema, result.rows);
  assert.equal(diagnostic.expectedCount, 7);
  assert.equal(diagnostic.actualCount, 7);
  assert.deepEqual(diagnostic.mismatches, []);
  assert.ok(diagnostic.actual.every(index => index.normalizedDefinition.length > 0));
  assert.equal(
    diagnostic.actual.find(index => index.name === "admissions_lead_assignments_pkey")?.constraintBacked,
    true,
  );
});

test("index names are resolved to PostgreSQL's 63-byte stored form without collisions", () => {
  const longName = `idx_${"a".repeat(80)}`;
  const storedName = postgresStoredIndexName(longName);
  const expectedNames = buildCrmIndexComparisonDiagnostic(schema, expectedIndexRows())
    .expected.map(index => index.name);

  assert.equal(Buffer.byteLength(storedName, "utf8"), 63);
  assert.equal(storedName, longName.slice(0, 63));
  assert.equal(new Set(expectedNames).size, expectedNames.length);
});

test("index comparison rejects missing, unexpected, and malformed catalog metadata", () => {
  const missing = expectedIndexRows().slice(1);
  assert.ok(buildCrmIndexComparisonDiagnostic(schema, missing).mismatches
    .some(mismatch => mismatch.index === "admissions_lead_assignments_pkey" && mismatch.fields.includes("missing")));

  const extra = expectedIndexRows();
  extra.push(indexRow("unexpected_index", "admissions_lead_assignments", [
    indexKey("lead_id", 1, "uuid_ops"),
  ]));
  assert.ok(buildCrmIndexComparisonDiagnostic(schema, extra).mismatches
    .some(mismatch => mismatch.index === "unexpected_index" && mismatch.fields.includes("unexpected")));

  const malformedKeyDetails = expectedIndexRows();
  malformedKeyDetails[0]!.key_details = { rows: [] };
  assert.throws(
    () => buildCrmIndexComparisonDiagnostic(schema, malformedKeyDetails),
    /CRM_SCHEMA_POSTCONDITION_INDEX_METADATA_INVALID/,
  );
  const malformedIncludes = expectedIndexRows();
  malformedIncludes[0]!.included_columns = "not-json-array";
  assert.throws(
    () => buildCrmIndexComparisonDiagnostic(schema, malformedIncludes),
    /CRM_SCHEMA_POSTCONDITION_INDEX_METADATA_INVALID/,
  );
});

test("index comparison rejects definition, key, include, order, and predicate drift", () => {
  const indexName = "admissions_lead_assignments_assignee_idx";
  const mutations: Array<[string, (row: FixtureIndexRow) => void, string]> = [
    ["table", row => { row.table_name = "other_table"; }, "table"],
    ["method", row => { row.method = "hash"; }, "method"],
    ["uniqueness", row => { row.unique = true; }, "unique"],
    ["primary", row => { row.primary = true; }, "primary"],
    ["backing constraint", row => { row.constraint_name = "unexpected_constraint"; }, "constraintBacked"],
    ["key column", row => {
      const keys = structuredClone(row.key_details) as Array<Record<string, unknown>>;
      keys[0]!.column = "other_column";
      row.key_details = driverJsonb(keys);
    }, "keyColumns"],
    ["key order", row => {
      const keys = structuredClone(row.key_details) as Array<Record<string, unknown>>;
      row.key_details = driverJsonb(keys.reverse());
    }, "keyOrder"],
    ["key expression", row => {
      const keys = structuredClone(row.key_details) as Array<Record<string, unknown>>;
      keys[0]!.definition = "lower(assignee_user_id)";
      row.key_details = driverJsonb(keys);
    }, "keyExpressions"],
    ["sort order", row => {
      const keys = structuredClone(row.key_details) as Array<Record<string, unknown>>;
      keys[0]!.descending = true;
      row.key_details = driverJsonb(keys);
    }, "sortOrder"],
    ["null ordering", row => {
      const keys = structuredClone(row.key_details) as Array<Record<string, unknown>>;
      keys[0]!.nullsFirst = true;
      row.key_details = driverJsonb(keys);
    }, "nullOrder"],
    ["collation", row => {
      const keys = structuredClone(row.key_details) as Array<Record<string, unknown>>;
      keys[0]!.collationName = "C";
      keys[0]!.collationSchema = "pg_catalog";
      row.key_details = driverJsonb(keys);
    }, "collation"],
    ["operator class", row => {
      const keys = structuredClone(row.key_details) as Array<Record<string, unknown>>;
      keys[0]!.opclassName = "other_ops";
      row.key_details = driverJsonb(keys);
    }, "operatorClass"],
    ["included column", row => {
      row.included_columns = driverJsonb(["extra_column"]);
      row.attr_count += 1;
    }, "includedColumns"],
    ["predicate", row => { row.predicate = "lead_id IS NOT NULL"; }, "predicate"],
    ["expressions", row => { row.expressions = "lower(assignee_user_id)"; }, "expressions"],
    ["validity", row => { row.valid = false; }, "valid"],
    ["readiness", row => { row.ready = false; }, "ready"],
    ["live state", row => { row.live = false; }, "live"],
    ["definition", row => { row.definition = "CREATE INDEX changed_definition"; }, "normalizedDefinition"],
  ];

  for (const [label, mutate, expectedField] of mutations) {
    const rows = expectedIndexRows();
    mutate(rows.find(row => row.name === indexName)!);
    assert.ok(
      indexMismatchFields(rows, indexName).includes(expectedField),
      `index ${label} drift must be rejected`,
    );
  }
});
