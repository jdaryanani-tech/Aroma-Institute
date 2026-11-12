import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;
type MigrationStage = "0014" | "0015";

const ASSIGNMENT_TABLES = ["admissions_lead_assignments", "admissions_lead_assignment_history"];

const EXPECTED_COLUMNS: Record<string, Record<string, {
  type: string;
  notNull: boolean;
  defaultExpression: string | null;
}>> = {
  admissions_lead_assignments: {
    lead_id: { type: "uuid", notNull: true, defaultExpression: null },
    assignee_user_id: { type: "integer", notNull: false, defaultExpression: null },
    assigned_by: { type: "integer", notNull: true, defaultExpression: null },
    updated_at: { type: "timestamp with time zone", notNull: true, defaultExpression: "now()" },
    version: { type: "integer", notNull: true, defaultExpression: "1" },
  },
  admissions_lead_assignment_history: {
    id: { type: "uuid", notNull: true, defaultExpression: "gen_random_uuid()" },
    lead_id: { type: "uuid", notNull: true, defaultExpression: null },
    previous_assignee_user_id: { type: "integer", notNull: false, defaultExpression: null },
    new_assignee_user_id: { type: "integer", notNull: false, defaultExpression: null },
    actor_user_id: { type: "integer", notNull: true, defaultExpression: null },
    changed_at: { type: "timestamp with time zone", notNull: true, defaultExpression: "now()" },
    reason: { type: "text", notNull: true, defaultExpression: null },
    source: { type: "text", notNull: true, defaultExpression: null },
    request_id: { type: "uuid", notNull: true, defaultExpression: null },
    assignment_version: { type: "integer", notNull: true, defaultExpression: null },
  },
};

type ConstraintSpec = {
  table: string;
  type: "p" | "u" | "f" | "c";
  columns: string[];
  refTable?: string;
  refColumns?: string[];
  deleteAction?: string;
  updateAction?: string;
  check?: "assignment_version" | "history_reason" | "history_source" | "history_version" | "history_changed";
};

export type CrmConstraintCatalogRow = {
  name: string;
  table_name: string;
  type: string;
  columns: string[];
  ref_schema: string | null;
  ref_table: string | null;
  ref_columns: string[] | null;
  delete_action: string;
  update_action: string;
  match_type: string;
  validated: boolean;
  deferrable: boolean;
  initially_deferred: boolean;
  check_expression: string | null;
};

export type CrmConstraintDiagnosticView = {
  name: string;
  table: string;
  type: string;
  typeCode: string;
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumns: string[] | null;
  onDelete: string | null;
  onUpdate: string | null;
  match: string | null;
  validated: boolean | null;
  deferrable: boolean | null;
  initiallyDeferred: boolean | null;
  checkExpression: string | null;
};

export type CrmConstraintComparisonDiagnostic = {
  expectedCount: number;
  actualCount: number;
  expected: CrmConstraintDiagnosticView[];
  actual: CrmConstraintDiagnosticView[];
  mismatches: Array<{ constraint: string; fields: string[] }>;
};

const EXPECTED_CONSTRAINTS: Record<string, ConstraintSpec> = {
  admissions_lead_assignments_pkey: {
    table: "admissions_lead_assignments", type: "p", columns: ["lead_id"],
  },
  admissions_lead_assignments_lead_id_fkey: {
    table: "admissions_lead_assignments", type: "f", columns: ["lead_id"],
    refTable: "admissions_leads", refColumns: ["id"], deleteAction: "r", updateAction: "a",
  },
  admissions_lead_assignments_assignee_user_id_fkey: {
    table: "admissions_lead_assignments", type: "f", columns: ["assignee_user_id"],
    refTable: "lms_users", refColumns: ["id"], deleteAction: "r", updateAction: "a",
  },
  admissions_lead_assignments_assigned_by_fkey: {
    table: "admissions_lead_assignments", type: "f", columns: ["assigned_by"],
    refTable: "lms_users", refColumns: ["id"], deleteAction: "r", updateAction: "a",
  },
  admissions_lead_assignments_version_ck: {
    table: "admissions_lead_assignments", type: "c", columns: ["version"], check: "assignment_version",
  },
  admissions_lead_assignment_history_pkey: {
    table: "admissions_lead_assignment_history", type: "p", columns: ["id"],
  },
  admissions_lead_assignment_history_lead_id_fkey: {
    table: "admissions_lead_assignment_history", type: "f", columns: ["lead_id"],
    refTable: "admissions_leads", refColumns: ["id"], deleteAction: "r", updateAction: "a",
  },
  admissions_lead_assignment_history_previous_assignee_user_id_fkey: {
    table: "admissions_lead_assignment_history", type: "f", columns: ["previous_assignee_user_id"],
    refTable: "lms_users", refColumns: ["id"], deleteAction: "r", updateAction: "a",
  },
  admissions_lead_assignment_history_new_assignee_user_id_fkey: {
    table: "admissions_lead_assignment_history", type: "f", columns: ["new_assignee_user_id"],
    refTable: "lms_users", refColumns: ["id"], deleteAction: "r", updateAction: "a",
  },
  admissions_lead_assignment_history_actor_user_id_fkey: {
    table: "admissions_lead_assignment_history", type: "f", columns: ["actor_user_id"],
    refTable: "lms_users", refColumns: ["id"], deleteAction: "r", updateAction: "a",
  },
  admissions_lead_assignment_history_request_id_key: {
    table: "admissions_lead_assignment_history", type: "u", columns: ["request_id"],
  },
  admissions_lead_assignment_history_reason_ck: {
    table: "admissions_lead_assignment_history", type: "c", columns: ["reason"], check: "history_reason",
  },
  admissions_lead_assignment_history_source_ck: {
    table: "admissions_lead_assignment_history", type: "c", columns: ["source"], check: "history_source",
  },
  admissions_lead_assignment_history_version_ck: {
    table: "admissions_lead_assignment_history", type: "c", columns: ["assignment_version"], check: "history_version",
  },
  admissions_lead_assignment_history_changed_ck: {
    table: "admissions_lead_assignment_history", type: "c",
    columns: ["previous_assignee_user_id", "new_assignee_user_id"], check: "history_changed",
  },
};

type IndexSpec = { table: string; columns: string[]; unique: boolean; primary: boolean };
const EXPECTED_INDEXES: Record<string, IndexSpec> = {
  admissions_lead_assignments_pkey: {
    table: "admissions_lead_assignments", columns: ["lead_id"], unique: true, primary: true,
  },
  admissions_lead_assignments_assignee_idx: {
    table: "admissions_lead_assignments", columns: ["assignee_user_id", "lead_id"], unique: false, primary: false,
  },
  admissions_lead_assignment_history_pkey: {
    table: "admissions_lead_assignment_history", columns: ["id"], unique: true, primary: true,
  },
  admissions_lead_assignment_history_request_id_key: {
    table: "admissions_lead_assignment_history", columns: ["request_id"], unique: true, primary: false,
  },
  admissions_lead_assignment_history_lead_time_idx: {
    table: "admissions_lead_assignment_history", columns: ["lead_id", "changed_at"], unique: false, primary: false,
  },
  admissions_lead_assignment_history_assignee_time_idx: {
    table: "admissions_lead_assignment_history",
    columns: ["new_assignee_user_id", "changed_at"], unique: false, primary: false,
  },
  admissions_lead_assignment_history_lead_version_uidx: {
    table: "admissions_lead_assignment_history", columns: ["lead_id", "assignment_version"], unique: true, primary: false,
  },
};

type TriggerSpec = {
  table: string;
  functionName: string;
  eventMask: number;
  deferrable: boolean;
  initiallyDeferred: boolean;
};
const TRIGGERS_0014: Record<string, TriggerSpec> = {
  admissions_lead_assignments_validate_trg: {
    table: "admissions_lead_assignments", functionName: "aichm_validate_lead_assignment",
    eventMask: 23, deferrable: false, initiallyDeferred: false,
  },
  admissions_lead_assignment_history_validate_trg: {
    table: "admissions_lead_assignment_history", functionName: "aichm_validate_lead_assignment_history",
    eventMask: 7, deferrable: false, initiallyDeferred: false,
  },
  admissions_lead_assignment_history_immutable_trg: {
    table: "admissions_lead_assignment_history", functionName: "aichm_reject_lead_assignment_history_mutation",
    eventMask: 27, deferrable: false, initiallyDeferred: false,
  },
  admissions_lead_assignment_history_no_truncate_trg: {
    table: "admissions_lead_assignment_history", functionName: "aichm_reject_lead_assignment_history_mutation",
    eventMask: 34, deferrable: false, initiallyDeferred: false,
  },
};
const TRIGGERS_0015: Record<string, TriggerSpec> = {
  admissions_lead_assignments_history_required_trg: {
    table: "admissions_lead_assignments", functionName: "aichm_require_assignment_history_for_change",
    eventMask: 21, deferrable: true, initiallyDeferred: true,
  },
  admissions_lead_assignments_no_delete_trg: {
    table: "admissions_lead_assignments", functionName: "aichm_reject_lead_assignment_mutation",
    eventMask: 11, deferrable: false, initiallyDeferred: false,
  },
  admissions_lead_assignments_no_truncate_trg: {
    table: "admissions_lead_assignments", functionName: "aichm_reject_lead_assignment_mutation",
    eventMask: 34, deferrable: false, initiallyDeferred: false,
  },
};

function fail(code: string): never {
  throw new Error(code);
}

function normalizeExpression(value: string | null): string {
  if (!value) return "";
  return value.toLowerCase()
    .replaceAll('"', "")
    .replace(/::[a-z_][a-z0-9_ ]*/g, "")
    .replace(/\s+/g, "")
    .replace(/^\(+|\)+$/g, "");
}

function checkMatches(kind: NonNullable<ConstraintSpec["check"]>, expression: string | null): boolean {
  const normalized = normalizeExpression(expression).replace(/[()]/g, "");
  switch (kind) {
    case "assignment_version":
      return /^version>0$/.test(normalized);
    case "history_reason":
      return /^lengthbtrimreason>=3andlengthbtrimreason<=1000$/.test(normalized);
    case "history_source":
      return /^source='admin_ui'$/.test(normalized);
    case "history_version":
      return /^assignment_version>0$/.test(normalized);
    case "history_changed":
      return /^previous_assignee_user_idisdistinctfromnew_assignee_user_id$/.test(normalized);
  }
}

const CHECK_EXPRESSIONS: Record<NonNullable<ConstraintSpec["check"]>, string> = {
  assignment_version: "version > 0",
  history_reason: "length(btrim(reason)) >= 3 AND length(btrim(reason)) <= 1000",
  history_source: "source = 'admin_ui'",
  history_version: "assignment_version > 0",
  history_changed: "previous_assignee_user_id IS DISTINCT FROM new_assignee_user_id",
};

const CONSTRAINT_TYPE_LABELS: Record<string, string> = {
  p: "PRIMARY KEY",
  u: "UNIQUE",
  f: "FOREIGN KEY",
  c: "CHECK",
};

const REFERENTIAL_ACTION_LABELS: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

const MATCH_TYPE_LABELS: Record<string, string> = {
  s: "SIMPLE",
  f: "FULL",
  p: "PARTIAL",
};

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const SAFE_CHECK_EXPRESSION = /^[A-Za-z0-9_ '"().,<>!=:+-]{1,512}$/;

function safeCatalogIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return SAFE_IDENTIFIER.test(value) ? value : "<invalid-identifier>";
}

export function safeCatalogIdentifierArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;

  let identifiers: unknown[];
  if (Array.isArray(value)) {
    identifiers = value;
  } else if (typeof value === "string") {
    // pg 8.16.3 has no text parser for PostgreSQL name[] (OID 1003), so
    // catalog ARRAY(name) values arrive as their raw PostgreSQL array literal.
    // Accept only the unquoted identifier form used by these catalog names.
    const match = /^\{([A-Za-z_][A-Za-z0-9_$]{0,62}(?:,[A-Za-z_][A-Za-z0-9_$]{0,62})*)?\}$/.exec(value);
    if (!match) return null;
    identifiers = match[1] === undefined ? [] : match[1].split(",");
  } else {
    return null;
  }

  return identifiers.map(item =>
    typeof item === "string"
      ? safeCatalogIdentifier(item) ?? "<invalid-identifier>"
      : "<invalid-identifier>",
  );
}

function safeCheckExpression(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return SAFE_CHECK_EXPRESSION.test(normalized) ? normalized : "<redacted-expression>";
}

function actionLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return REFERENTIAL_ACTION_LABELS[value] ?? "<unknown-action>";
}

function matchTypeLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return MATCH_TYPE_LABELS[value] ?? "<unknown-match>";
}

function expectedConstraintView(
  name: string,
  spec: ConstraintSpec,
  schema: string,
): CrmConstraintDiagnosticView {
  return {
    name,
    table: spec.table,
    type: CONSTRAINT_TYPE_LABELS[spec.type] ?? "UNKNOWN",
    typeCode: spec.type,
    columns: [...spec.columns],
    referencedSchema: spec.type === "f" ? schema : null,
    referencedTable: spec.refTable ?? null,
    referencedColumns: spec.refColumns ? [...spec.refColumns] : null,
    onDelete: actionLabel(spec.deleteAction),
    onUpdate: actionLabel(spec.updateAction),
    match: spec.type === "f" ? "SIMPLE" : null,
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
    checkExpression: spec.check ? CHECK_EXPRESSIONS[spec.check] : null,
  };
}

function actualConstraintView(row: CrmConstraintCatalogRow): CrmConstraintDiagnosticView {
  return {
    name: safeCatalogIdentifier(row.name) ?? "<invalid-identifier>",
    table: safeCatalogIdentifier(row.table_name) ?? "<invalid-identifier>",
    type: CONSTRAINT_TYPE_LABELS[row.type] ?? "UNKNOWN",
    typeCode: /^[pufc]$/.test(row.type) ? row.type : "<unknown-type>",
    columns: safeCatalogIdentifierArray(row.columns) ?? [],
    referencedSchema: safeCatalogIdentifier(row.ref_schema),
    referencedTable: safeCatalogIdentifier(row.ref_table),
    referencedColumns: safeCatalogIdentifierArray(row.ref_columns),
    onDelete: actionLabel(row.delete_action),
    onUpdate: actionLabel(row.update_action),
    match: matchTypeLabel(row.match_type),
    validated: typeof row.validated === "boolean" ? row.validated : null,
    deferrable: typeof row.deferrable === "boolean" ? row.deferrable : null,
    initiallyDeferred: typeof row.initially_deferred === "boolean" ? row.initially_deferred : null,
    checkExpression: safeCheckExpression(row.check_expression),
  };
}

export function buildCrmConstraintComparisonDiagnostic(
  schema: string,
  rows: readonly CrmConstraintCatalogRow[],
): CrmConstraintComparisonDiagnostic {
  const expectedEntries = Object.entries(EXPECTED_CONSTRAINTS);
  const expected = expectedEntries.map(([name, spec]) => expectedConstraintView(name, spec, schema));
  const actual = rows.map(actualConstraintView).sort((left, right) =>
    left.table.localeCompare(right.table) || left.name.localeCompare(right.name));
  const mismatches: CrmConstraintComparisonDiagnostic["mismatches"] = [];

  if (rows.length !== expectedEntries.length) {
    mismatches.push({
      constraint: "<constraint-set>",
      fields: ["count"],
    });
  }

  for (const [name, spec] of expectedEntries) {
    const matchingRows = rows.filter(row => row.name === name);
    if (matchingRows.length === 0) {
      mismatches.push({ constraint: name, fields: ["missing"] });
      continue;
    }
    if (matchingRows.length > 1) {
      mismatches.push({ constraint: name, fields: ["duplicateName"] });
      continue;
    }

    const row = matchingRows[0]!;
    const fields: string[] = [];
    if (row.table_name !== spec.table) fields.push("table");
    if (row.type !== spec.type) fields.push("type");
    if (JSON.stringify(row.columns) !== JSON.stringify(spec.columns)) fields.push("columns");
    if (!row.validated) fields.push("validated");
    if (row.deferrable) fields.push("deferrable");
    if (row.initially_deferred) fields.push("initiallyDeferred");
    if (spec.type === "f") {
      if (row.ref_schema !== schema) fields.push("referencedSchema");
      if (row.ref_table !== spec.refTable) fields.push("referencedTable");
      if (JSON.stringify(row.ref_columns) !== JSON.stringify(spec.refColumns)) fields.push("referencedColumns");
      if (row.delete_action !== spec.deleteAction) fields.push("onDelete");
      if (row.update_action !== spec.updateAction) fields.push("onUpdate");
      if (row.match_type !== "s") fields.push("match");
    } else if (spec.check && !checkMatches(spec.check, row.check_expression)) {
      fields.push("checkExpression");
    }
    if (fields.length) mismatches.push({ constraint: name, fields });
  }

  const expectedNames = new Set(expectedEntries.map(([name]) => name));
  for (const row of rows) {
    if (!expectedNames.has(row.name)) {
      mismatches.push({
        constraint: safeCatalogIdentifier(row.name) ?? "<invalid-identifier>",
        fields: ["unexpected"],
      });
    }
  }

  return {
    expectedCount: expected.length,
    actualCount: rows.length,
    expected,
    actual,
    mismatches,
  };
}

function failWithConstraintDiagnostic(
  code: string,
  diagnostic: CrmConstraintComparisonDiagnostic,
): never {
  throw new Error(`${code} ${JSON.stringify(diagnostic)}`);
}

function extractFunctionSources(sql: string): Map<string, string> {
  const sources = new Map<string, string>();
  const pattern = /CREATE OR REPLACE FUNCTION\s+(?:(?:public)\.)?([a-z0-9_]+)\s*\(\s*\)\s*RETURNS\s+trigger\b[\s\S]*?\bAS\s+\$\$(.*?)\$\$;/gi;
  for (const match of Array.from(sql.matchAll(pattern))) sources.set(match[1], match[2].trim());
  return sources;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

export async function assertCrmAssignmentSchemaPostconditions(
  client: Queryable,
  schema: string,
  stage: MigrationStage,
  migration0014Sql: string,
  migration0015Sql: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail("CRM_SCHEMA_POSTCONDITION_SCHEMA_REJECTED");
  const expectedTables = new Set(ASSIGNMENT_TABLES);

  const { rows: tableRows } = await client.query<{ relname: string; relkind: string; relpersistence: string }>(`
    SELECT c.relname,c.relkind,c.relpersistence
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
  `, [schema, ASSIGNMENT_TABLES]);
  if (
    tableRows.length !== expectedTables.size ||
    tableRows.some(row => !expectedTables.has(row.relname) || row.relkind !== "r" || row.relpersistence !== "p")
  ) fail("CRM_SCHEMA_POSTCONDITION_TABLES_DRIFTED");

  const { rows: columnRows } = await client.query<{
    table_name: string; column_name: string; data_type: string; not_null: boolean;
    default_expression: string | null; generated: string; identity: string;
  }>(`
    SELECT c.relname AS table_name,a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS not_null,
      pg_get_expr(d.adbin,d.adrelid) AS default_expression,
      a.attgenerated AS generated,a.attidentity AS identity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum
  `, [schema, ASSIGNMENT_TABLES]);
  const expectedColumnCount = Object.values(EXPECTED_COLUMNS).reduce((sum, columns) => sum + Object.keys(columns).length, 0);
  if (columnRows.length !== expectedColumnCount) fail("CRM_SCHEMA_POSTCONDITION_COLUMNS_DRIFTED");
  for (const row of columnRows) {
    const expected = EXPECTED_COLUMNS[row.table_name]?.[row.column_name];
    if (
      !expected ||
      row.data_type !== expected.type ||
      row.not_null !== expected.notNull ||
      normalizeExpression(row.default_expression) !== normalizeExpression(expected.defaultExpression) ||
      row.generated !== "" ||
      row.identity !== ""
    ) fail("CRM_SCHEMA_POSTCONDITION_COLUMNS_DRIFTED");
  }

  const { rows: constraintRows } = await client.query<CrmConstraintCatalogRow>(`
    SELECT k.conname AS name,t.relname AS table_name,k.contype AS type,
      ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY x(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=x.attnum ORDER BY x.ord) AS columns,
      rn.nspname AS ref_schema,rt.relname AS ref_table,
      CASE WHEN k.confkey IS NULL THEN NULL ELSE ARRAY(
        SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY x(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=rt.oid AND a.attnum=x.attnum ORDER BY x.ord
      ) END AS ref_columns,
      k.confdeltype AS delete_action,k.confupdtype AS update_action,k.confmatchtype AS match_type,
      k.convalidated AS validated,k.condeferrable AS deferrable,k.condeferred AS initially_deferred,
      pg_get_expr(k.conbin,k.conrelid) AS check_expression
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_class rt ON rt.oid=k.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid=rt.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[])
    ORDER BY t.relname,k.conname
  `, [schema, ASSIGNMENT_TABLES]);
  const constraintDiagnostic = buildCrmConstraintComparisonDiagnostic(schema, constraintRows);
  if (constraintRows.length !== Object.keys(EXPECTED_CONSTRAINTS).length) {
    failWithConstraintDiagnostic("CRM_SCHEMA_POSTCONDITION_CONSTRAINTS_DRIFTED", constraintDiagnostic);
  }
  for (const row of constraintRows) {
    const expected = EXPECTED_CONSTRAINTS[row.name];
    if (
      !expected || row.table_name !== expected.table || row.type !== expected.type ||
      JSON.stringify(row.columns) !== JSON.stringify(expected.columns) ||
      !row.validated || row.deferrable || row.initially_deferred
    ) failWithConstraintDiagnostic("CRM_SCHEMA_POSTCONDITION_CONSTRAINTS_DRIFTED", constraintDiagnostic);
    if (expected.type === "f") {
      if (
        row.ref_schema !== schema ||
        row.ref_table !== expected.refTable ||
        JSON.stringify(row.ref_columns) !== JSON.stringify(expected.refColumns) ||
        row.delete_action !== expected.deleteAction ||
        row.update_action !== expected.updateAction ||
        row.match_type !== "s"
      ) failWithConstraintDiagnostic("CRM_SCHEMA_POSTCONDITION_FOREIGN_KEYS_DRIFTED", constraintDiagnostic);
    } else if (expected.check && !checkMatches(expected.check, row.check_expression)) {
      failWithConstraintDiagnostic("CRM_SCHEMA_POSTCONDITION_CONSTRAINTS_DRIFTED", constraintDiagnostic);
    }
  }

  const { rows: indexRows } = await client.query<{
    name: string; table_name: string; method: string; unique: boolean; primary: boolean;
    valid: boolean; ready: boolean; live: boolean; key_count: number; attr_count: number;
    columns: string[]; predicate: string | null; expressions: string | null;
  }>(`
    SELECT i.relname AS name,t.relname AS table_name,am.amname AS method,
      x.indisunique AS unique,x.indisprimary AS primary,x.indisvalid AS valid,
      x.indisready AS ready,x.indislive AS live,x.indnkeyatts::integer AS key_count,
      x.indnatts::integer AS attr_count,
      ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
        WHERE k.ord<=x.indnkeyatts ORDER BY k.ord) AS columns,
      pg_get_expr(x.indpred,x.indrelid) AS predicate,
      pg_get_expr(x.indexprs,x.indrelid) AS expressions
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[])
    ORDER BY t.relname,i.relname
  `, [schema, ASSIGNMENT_TABLES]);
  if (indexRows.length !== Object.keys(EXPECTED_INDEXES).length) fail("CRM_SCHEMA_POSTCONDITION_INDEXES_DRIFTED");
  for (const row of indexRows) {
    const expected = EXPECTED_INDEXES[row.name];
    if (
      !expected || row.table_name !== expected.table || row.method !== "btree" ||
      row.unique !== expected.unique || row.primary !== expected.primary ||
      !row.valid || !row.ready || !row.live ||
      row.key_count !== expected.columns.length || row.attr_count !== expected.columns.length ||
      JSON.stringify(row.columns) !== JSON.stringify(expected.columns) ||
      row.predicate !== null || row.expressions !== null
    ) fail("CRM_SCHEMA_POSTCONDITION_INDEXES_DRIFTED");
  }

  const expectedTriggers = { ...TRIGGERS_0014, ...(stage === "0015" ? TRIGGERS_0015 : {}) };
  const { rows: triggerRows } = await client.query<{
    name: string; table_name: string; function_name: string; function_schema: string;
    enabled: string; trigger_type: number; deferrable: boolean; initially_deferred: boolean;
  }>(`
    SELECT g.tgname AS name,t.relname AS table_name,p.proname AS function_name,
      pn.nspname AS function_schema,g.tgenabled AS enabled,g.tgtype::integer AS trigger_type,
      g.tgdeferrable AS deferrable,g.tginitdeferred AS initially_deferred
    FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_proc p ON p.oid=g.tgfoid
    JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND NOT g.tgisinternal
    ORDER BY g.tgname
  `, [schema, ASSIGNMENT_TABLES]);
  if (triggerRows.length !== Object.keys(expectedTriggers).length) fail("CRM_SCHEMA_POSTCONDITION_TRIGGERS_DRIFTED");
  for (const row of triggerRows) {
    const expected = expectedTriggers[row.name];
    if (
      !expected || row.table_name !== expected.table || row.function_name !== expected.functionName ||
      row.function_schema !== schema || row.enabled !== "O" ||
      row.trigger_type !== expected.eventMask || row.deferrable !== expected.deferrable ||
      row.initially_deferred !== expected.initiallyDeferred
    ) fail("CRM_SCHEMA_POSTCONDITION_TRIGGERS_DRIFTED");
  }

  const sources14 = extractFunctionSources(migration0014Sql);
  const sources15 = extractFunctionSources(migration0015Sql);
  const expectedFunctions = new Map(sources14);
  if (stage === "0015") {
    for (const [name, source] of Array.from(sources15.entries())) expectedFunctions.set(name, source);
  }
  const allFunctionNames = new Set([
    ...Array.from(sources14.keys()),
    ...Array.from(sources15.keys()),
  ]);
  const functionNames = Array.from(expectedFunctions.keys()).sort();
  const { rows: functionRows } = await client.query<{
    name: string; source: string; language: string; return_type: string;
    argument_count: number; config: string[] | null; kind: string;
  }>(`
    SELECT p.proname AS name,p.prosrc AS source,l.lanname AS language,
      p.prorettype::regtype::text AS return_type,p.pronargs::integer AS argument_count,
      p.proconfig AS config,p.prokind AS kind
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[])
    ORDER BY p.proname
  `, [schema, Array.from(allFunctionNames)]);
  if (functionRows.length !== functionNames.length) fail("CRM_SCHEMA_POSTCONDITION_FUNCTIONS_DRIFTED");
  for (const row of functionRows) {
    const expected = expectedFunctions.get(row.name);
    const expectedConfig = `search_path=pg_catalog, ${schema}`;
    const actualConfig = row.config?.map(value => value.replaceAll('"', "").replace(/\s+/g, " ").trim()) ?? [];
    if (
      expected === undefined || normalizeBody(row.source) !== normalizeBody(expected) ||
      row.language !== "plpgsql" || row.return_type !== "trigger" ||
      row.argument_count !== 0 || row.kind !== "f" ||
      actualConfig.length !== 1 ||
      actualConfig[0] !== expectedConfig
    ) fail("CRM_SCHEMA_POSTCONDITION_FUNCTIONS_DRIFTED");
  }

  const { rows: grants } = await client.query<{ privilege_type: string }>(`
    SELECT acl.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
    WHERE n.nspname=$1 AND c.relname='admissions_lead_assignment_history'
      AND acl.grantee=0 AND acl.privilege_type=ANY($2::text[])
  `, [schema, ["UPDATE", "DELETE", "TRUNCATE"]]);
  if (grants.length) fail("CRM_SCHEMA_POSTCONDITION_HISTORY_GRANTS_DRIFTED");
}

export async function assertCrmAssignmentSchemaAbsent(
  client: Queryable,
  schema: string,
  migration0014Sql: string,
  migration0015Sql: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail("CRM_SCHEMA_POSTCONDITION_SCHEMA_REJECTED");
  const functionNames = Array.from(new Set([
    ...Array.from(extractFunctionSources(migration0014Sql).keys()),
    ...Array.from(extractFunctionSources(migration0015Sql).keys()),
  ]));
  const { rows: tables } = await client.query<{ relname: string }>(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
  `, [schema, ASSIGNMENT_TABLES]);
  const { rows: functions } = await client.query<{ proname: string }>(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[])
  `, [schema, functionNames]);
  const { rows: triggers } = await client.query<{ tgname: string }>(`
    SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT g.tgisinternal
  `, [schema, ASSIGNMENT_TABLES]);
  if (tables.length || functions.length || triggers.length) {
    fail("CRM_SCHEMA_POSTCONDITION_UNTRACKED_STATE");
  }
}
