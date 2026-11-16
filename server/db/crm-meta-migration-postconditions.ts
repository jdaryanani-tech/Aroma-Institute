import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export const CRM_META_LEAD_ADS_TABLES = [
  "admissions_marketing_consent_events",
  "admissions_lead_touchpoints",
  "admissions_meta_lead_links",
  "admissions_meta_event_outbox",
] as const;

export const CRM_META_LEAD_ADS_INDEXES = [
  "admissions_marketing_consent_visitor_idx",
  "admissions_marketing_consent_lead_idx",
  "admissions_touchpoints_lead_time_idx",
  "admissions_touchpoints_inquiry_time_idx",
  "admissions_touchpoints_meta_lead_unique",
  "admissions_meta_lead_link_lead_idx",
  "admissions_meta_lead_link_inquiry_idx",
  "admissions_meta_outbox_due_idx",
  "admissions_meta_outbox_lead_idx",
] as const;

export const CRM_META_PHONE_IDENTITY_DIAGNOSTIC_COLUMNS = [
  "phone_number_field_state",
  "mobile_phone_field_state",
  "whatsapp_number_field_state",
  "phone_normalization_outcome",
  "phone_selected_field",
  "phone_fallback_attempted",
  "phone_invalid_higher_priority_blocked_fallback",
] as const;
export const CRM_META_PHONE_IDENTITY_DIAGNOSTIC_CONSTRAINT =
  "admissions_meta_lead_links_phone_diag_ck";

type ColumnSpec = { type: string; notNull: boolean; defaultExpression: string | null };
type IndexSpec = {
  table: string;
  keys: Array<{ column: string; descending?: boolean }>;
  unique?: boolean;
  primary?: boolean;
  predicate?: string;
};
type ConstraintSpec = {
  table: string;
  type: "p" | "f" | "c";
  columns: string[];
  refTable?: string;
  refColumns?: string[];
  check?: string;
};

const EXPECTED_COLUMNS: Record<string, Record<string, ColumnSpec>> = {
  admissions_marketing_consent_events: {
    id: { type: "uuid", notNull: true, defaultExpression: "gen_random_uuid()" },
    visitor_key_hash: { type: "text", notNull: true, defaultExpression: null },
    lead_id: { type: "uuid", notNull: false, defaultExpression: null },
    consent_status: { type: "text", notNull: true, defaultExpression: null },
    occurred_at: { type: "timestamp with time zone", notNull: true, defaultExpression: "now()" },
    policy_version: { type: "text", notNull: true, defaultExpression: null },
    source: { type: "text", notNull: true, defaultExpression: null },
    source_path: { type: "text", notNull: false, defaultExpression: null },
  },
  admissions_lead_touchpoints: {
    id: { type: "uuid", notNull: true, defaultExpression: "gen_random_uuid()" },
    lead_id: { type: "uuid", notNull: false, defaultExpression: null },
    inquiry_id: { type: "integer", notNull: false, defaultExpression: null },
    source_channel: { type: "text", notNull: true, defaultExpression: null },
    source: { type: "text", notNull: false, defaultExpression: null },
    medium: { type: "text", notNull: false, defaultExpression: null },
    campaign: { type: "text", notNull: false, defaultExpression: null },
    campaign_id: { type: "text", notNull: false, defaultExpression: null },
    ad_id: { type: "text", notNull: false, defaultExpression: null },
    adset_id: { type: "text", notNull: false, defaultExpression: null },
    form_id: { type: "text", notNull: false, defaultExpression: null },
    meta_lead_id: { type: "text", notNull: false, defaultExpression: null },
    fbc: { type: "text", notNull: false, defaultExpression: null },
    fbp: { type: "text", notNull: false, defaultExpression: null },
    occurred_at: { type: "timestamp with time zone", notNull: true, defaultExpression: "now()" },
  },
  admissions_meta_lead_links: {
    meta_lead_id: { type: "text", notNull: true, defaultExpression: null },
    page_id: { type: "text", notNull: true, defaultExpression: null },
    form_id: { type: "text", notNull: false, defaultExpression: null },
    campaign_id: { type: "text", notNull: false, defaultExpression: null },
    ad_id: { type: "text", notNull: false, defaultExpression: null },
    adset_id: { type: "text", notNull: false, defaultExpression: null },
    lead_created_at: { type: "timestamp with time zone", notNull: false, defaultExpression: null },
    received_at: { type: "timestamp with time zone", notNull: true, defaultExpression: "now()" },
    lead_id: { type: "uuid", notNull: false, defaultExpression: null },
    inquiry_id: { type: "integer", notNull: false, defaultExpression: null },
    state: { type: "text", notNull: true, defaultExpression: "'processed'" },
    error_code: { type: "text", notNull: false, defaultExpression: null },
  },
  admissions_meta_event_outbox: {
    event_id: { type: "text", notNull: true, defaultExpression: null },
    visitor_key_hash: { type: "text", notNull: true, defaultExpression: null },
    lead_id: { type: "uuid", notNull: false, defaultExpression: null },
    inquiry_id: { type: "integer", notNull: false, defaultExpression: null },
    event_name: { type: "text", notNull: true, defaultExpression: null },
    event_time: { type: "timestamp with time zone", notNull: true, defaultExpression: null },
    event_source_url: { type: "text", notNull: true, defaultExpression: null },
    custom_data: { type: "jsonb", notNull: true, defaultExpression: "'{}'::jsonb" },
    state: { type: "text", notNull: true, defaultExpression: "'pending'" },
    attempt_count: { type: "integer", notNull: true, defaultExpression: "0" },
    available_at: { type: "timestamp with time zone", notNull: true, defaultExpression: "now()" },
    last_attempt_at: { type: "timestamp with time zone", notNull: false, defaultExpression: null },
    response_at: { type: "timestamp with time zone", notNull: false, defaultExpression: null },
    http_status: { type: "integer", notNull: false, defaultExpression: null },
    last_error: { type: "text", notNull: false, defaultExpression: null },
    locked_at: { type: "timestamp with time zone", notNull: false, defaultExpression: null },
    lock_token: { type: "uuid", notNull: false, defaultExpression: null },
  },
};

const EXPECTED_CONSTRAINTS: Record<string, ConstraintSpec> = {
  admissions_marketing_consent_events_pkey: {
    table: "admissions_marketing_consent_events", type: "p", columns: ["id"],
  },
  admissions_marketing_consent_events_lead_id_fkey: {
    table: "admissions_marketing_consent_events", type: "f", columns: ["lead_id"],
    refTable: "admissions_leads", refColumns: ["id"],
  },
  admissions_marketing_consent_events_visitor_key_hash_check: {
    table: "admissions_marketing_consent_events", type: "c", columns: ["visitor_key_hash"],
    check: "visitor_key_hash ~ '^[0-9a-f]{64}$'",
  },
  admissions_marketing_consent_events_consent_status_check: {
    table: "admissions_marketing_consent_events", type: "c", columns: ["consent_status"],
    check: "consent_status IN ('granted','denied','withdrawn')",
  },
  admissions_marketing_consent_events_source_path_check: {
    table: "admissions_marketing_consent_events", type: "c", columns: ["source_path"],
    check: "source_path IS NULL OR source_path IN ('/','/vsl','/vsl-video','/counselling')",
  },
  admissions_lead_touchpoints_pkey: {
    table: "admissions_lead_touchpoints", type: "p", columns: ["id"],
  },
  admissions_lead_touchpoints_lead_id_fkey: {
    table: "admissions_lead_touchpoints", type: "f", columns: ["lead_id"],
    refTable: "admissions_leads", refColumns: ["id"],
  },
  admissions_lead_touchpoints_inquiry_id_fkey: {
    table: "admissions_lead_touchpoints", type: "f", columns: ["inquiry_id"],
    refTable: "inquiries", refColumns: ["id"],
  },
  admissions_lead_touchpoints_check: {
    table: "admissions_lead_touchpoints", type: "c", columns: ["lead_id", "inquiry_id"],
    check: "lead_id IS NOT NULL OR inquiry_id IS NOT NULL",
  },
  admissions_meta_lead_links_pkey: {
    table: "admissions_meta_lead_links", type: "p", columns: ["meta_lead_id"],
  },
  admissions_meta_lead_links_lead_id_fkey: {
    table: "admissions_meta_lead_links", type: "f", columns: ["lead_id"],
    refTable: "admissions_leads", refColumns: ["id"],
  },
  admissions_meta_lead_links_inquiry_id_fkey: {
    table: "admissions_meta_lead_links", type: "f", columns: ["inquiry_id"],
    refTable: "inquiries", refColumns: ["id"],
  },
  admissions_meta_lead_links_state_check: {
    table: "admissions_meta_lead_links", type: "c", columns: ["state"],
    check: "state IN ('processed','review','failed')",
  },
  admissions_meta_lead_links_check: {
    table: "admissions_meta_lead_links", type: "c", columns: ["inquiry_id", "state"],
    check: "inquiry_id IS NOT NULL OR state IN ('review','failed')",
  },
  admissions_meta_event_outbox_pkey: {
    table: "admissions_meta_event_outbox", type: "p", columns: ["event_id"],
  },
  admissions_meta_event_outbox_lead_id_fkey: {
    table: "admissions_meta_event_outbox", type: "f", columns: ["lead_id"],
    refTable: "admissions_leads", refColumns: ["id"],
  },
  admissions_meta_event_outbox_inquiry_id_fkey: {
    table: "admissions_meta_event_outbox", type: "f", columns: ["inquiry_id"],
    refTable: "inquiries", refColumns: ["id"],
  },
  admissions_meta_event_outbox_visitor_key_hash_check: {
    table: "admissions_meta_event_outbox", type: "c", columns: ["visitor_key_hash"],
    check: "visitor_key_hash ~ '^[0-9a-f]{64}$'",
  },
  admissions_meta_event_outbox_event_name_check: {
    table: "admissions_meta_event_outbox", type: "c", columns: ["event_name"],
    check: "event_name IN ('PageView','Lead','VslRegistered','VslProgress','VslCompleted','CounsellingSubmitted')",
  },
  admissions_meta_event_outbox_event_source_url_check: {
    table: "admissions_meta_event_outbox", type: "c", columns: ["event_source_url"],
    check: "event_source_url !~ '[?#]' AND event_source_url ~ '^https://[^/]+(/|/vsl|/vsl-video|/counselling)$'",
  },
  admissions_meta_event_outbox_custom_data_check: {
    table: "admissions_meta_event_outbox", type: "c", columns: ["custom_data"],
    check: "jsonb_typeof(custom_data)='object' AND NOT (custom_data ? 'user_data') AND NOT (custom_data ?| ARRAY['email','phone','name','full_name','answers','questionnaire']) AND custom_data - ARRAY['funnel_step','milestone','observed_percent'] = '{}'::jsonb",
  },
  admissions_meta_event_outbox_state_check: {
    table: "admissions_meta_event_outbox", type: "c", columns: ["state"],
    check: "state IN ('pending','sending','sent','failed','suppressed')",
  },
  admissions_meta_event_outbox_attempt_count_check: {
    table: "admissions_meta_event_outbox", type: "c", columns: ["attempt_count"],
    check: "attempt_count >= 0",
  },
};

const EXPLICIT_INDEXES: Record<string, IndexSpec> = {
  admissions_marketing_consent_visitor_idx: {
    table: "admissions_marketing_consent_events",
    keys: [{ column: "visitor_key_hash" }, { column: "occurred_at", descending: true }],
  },
  admissions_marketing_consent_lead_idx: {
    table: "admissions_marketing_consent_events",
    keys: [{ column: "lead_id" }, { column: "occurred_at", descending: true }],
  },
  admissions_touchpoints_lead_time_idx: {
    table: "admissions_lead_touchpoints", keys: [{ column: "lead_id" }, { column: "occurred_at" }],
  },
  admissions_touchpoints_inquiry_time_idx: {
    table: "admissions_lead_touchpoints", keys: [{ column: "inquiry_id" }, { column: "occurred_at" }],
  },
  admissions_touchpoints_meta_lead_unique: {
    table: "admissions_lead_touchpoints", keys: [{ column: "meta_lead_id" }],
    unique: true, predicate: "meta_lead_id IS NOT NULL",
  },
  admissions_meta_lead_link_lead_idx: {
    table: "admissions_meta_lead_links", keys: [{ column: "lead_id" }],
  },
  admissions_meta_lead_link_inquiry_idx: {
    table: "admissions_meta_lead_links", keys: [{ column: "inquiry_id" }],
  },
  admissions_meta_outbox_due_idx: {
    table: "admissions_meta_event_outbox", keys: [{ column: "state" }, { column: "available_at" }],
  },
  admissions_meta_outbox_lead_idx: {
    table: "admissions_meta_event_outbox", keys: [{ column: "lead_id" }, { column: "event_time" }],
  },
};

const PRIMARY_INDEXES: Record<string, IndexSpec> = {
  admissions_marketing_consent_events_pkey: {
    table: "admissions_marketing_consent_events", keys: [{ column: "id" }], unique: true, primary: true,
  },
  admissions_lead_touchpoints_pkey: {
    table: "admissions_lead_touchpoints", keys: [{ column: "id" }], unique: true, primary: true,
  },
  admissions_meta_lead_links_pkey: {
    table: "admissions_meta_lead_links", keys: [{ column: "meta_lead_id" }], unique: true, primary: true,
  },
  admissions_meta_event_outbox_pkey: {
    table: "admissions_meta_event_outbox", keys: [{ column: "event_id" }], unique: true, primary: true,
  },
};

const BASE_PREREQUISITE_COLUMNS: Record<string, Record<string, string>> = {
  admissions_leads: {
    id: "uuid",
    canonical_phone: "text",
    name: "text",
    legacy_match_status: "text",
    questionnaire_status: "text",
    questionnaire_completed_at: "timestamp with time zone",
  },
  inquiries: {
    id: "integer",
    lead_id: "uuid",
    name: "text",
    email: "text",
    phone: "text",
    program_interest: "text",
    message: "text",
    submission_source: "text",
    counselling_answers: "jsonb",
    counselling_submitted_at: "timestamp with time zone",
    counselling_delivery_status: "text",
  },
};

function fail(code: string, diagnostic?: string): never {
  const error = new Error(diagnostic ? `${code} ${diagnostic}` : code) as Error & { code: string };
  error.code = code;
  throw error;
}

function validateSchema(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail("CRM_META_SCHEMA_SCHEMA_REJECTED");
}

export function normalizeCrmMetaCatalogExpression(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\bin\s*\(([^()]*)\)/g, " in [$1]")
    .replace(/=\s*any\s*\(\s*array\s*\[([^\]]*)\]\s*\)/g, " in [$1]")
    .replace(/::(?:text|jsonb|integer|character varying|timestamp with time zone)\b/g, "")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .replaceAll("=anyarray[", "in[");
}

function expectedIndexDefinition(name: string, schema: string, spec: IndexSpec): string {
  const keys = spec.keys
    .map(key => `${key.column}${key.descending ? " DESC" : ""}`)
    .join(", ");
  return `CREATE ${spec.unique ? "UNIQUE " : ""}INDEX ${name} ON ${schema}.${spec.table} USING btree (${keys})${
    spec.predicate ? ` WHERE ${spec.predicate}` : ""
  }`;
}

export async function assertCrmMetaLeadAdsPrerequisites(
  client: Queryable,
  schema = "public",
): Promise<void> {
  validateSchema(schema);
  const tables = Object.keys(BASE_PREREQUISITE_COLUMNS);
  const columns = tables.flatMap(table => Object.entries(BASE_PREREQUISITE_COLUMNS[table]).map(([column, type]) => ({
    table,
    column,
    type,
  })));
  const { rows } = await client.query<{
    table_name: string; column_name: string; data_type: string; relkind: string;
  }>(`
    SELECT c.relname AS table_name,a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS data_type,c.relkind::text AS relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
      AND a.attnum>0 AND NOT a.attisdropped
  `, [schema, tables]);
  const actual = new Map(rows.map(row => [`${row.table_name}.${row.column_name}`, row]));
  if (columns.some(item => {
    const row = actual.get(`${item.table}.${item.column}`);
    return !row || row.data_type !== item.type || !["r", "p"].includes(row.relkind);
  })) {
    fail("CRM_META_SCHEMA_BASE_PREREQUISITES_MISSING");
  }
}

export async function assertCrmMetaLeadAdsSchemaAbsent(
  client: Queryable,
  schema = "public",
): Promise<void> {
  validateSchema(schema);
  const objectNames = [
    ...CRM_META_LEAD_ADS_TABLES,
    ...CRM_META_LEAD_ADS_INDEXES,
    ...Object.keys(EXPECTED_CONSTRAINTS),
  ];
  const { rows } = await client.query<{ name: string; kind: string }>(`
    SELECT c.relname AS name,c.relkind::text AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
    UNION ALL
    SELECT p.proname AS name,'function' AS kind
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[])
    UNION ALL
    SELECT t.typname AS name,'type' AS kind
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname=$1 AND t.typname=ANY($2::text[])
  `, [schema, objectNames]);
  if (rows.length) fail("CRM_META_SCHEMA_UNTRACKED_STATE");
}

export async function assertCrmMetaLeadAdsPostconditions(
  client: Queryable,
  schema = "public",
): Promise<void> {
  validateSchema(schema);

  const { rows: tables } = await client.query<{
    table_name: string; relkind: string; persistence: string; owner_name: string;
  }>(`
    SELECT c.relname AS table_name,c.relkind::text AS relkind,
      c.relpersistence::text AS persistence,r.rolname AS owner_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
  `, [schema, CRM_META_LEAD_ADS_TABLES]);
  if (
    tables.length !== CRM_META_LEAD_ADS_TABLES.length ||
    tables.some(row =>
      row.relkind !== "r" || row.persistence !== "p" || row.owner_name !== "aichm_crm_owner",
    )
  ) fail("CRM_META_SCHEMA_TABLES_OR_OWNERSHIP_DRIFTED");

  const { rows: columns } = await client.query<{
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
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
      AND a.attnum>0 AND NOT a.attisdropped
      AND NOT (
        c.relname='admissions_meta_lead_links'
        AND a.attname=ANY($3::text[])
      )
    ORDER BY c.relname,a.attnum
  `, [schema, CRM_META_LEAD_ADS_TABLES, CRM_META_PHONE_IDENTITY_DIAGNOSTIC_COLUMNS]);
  const expectedColumnCount = Object.values(EXPECTED_COLUMNS).reduce(
    (sum, tableColumns) => sum + Object.keys(tableColumns).length,
    0,
  );
  if (columns.length !== expectedColumnCount) fail("CRM_META_SCHEMA_COLUMNS_DRIFTED");
  for (const row of columns) {
    const expected = EXPECTED_COLUMNS[row.table_name]?.[row.column_name];
    if (
      !expected || row.data_type !== expected.type || row.not_null !== expected.notNull ||
      normalizeCrmMetaCatalogExpression(row.default_expression) !==
        normalizeCrmMetaCatalogExpression(expected.defaultExpression) ||
      row.generated !== "" || row.identity !== ""
    ) fail("CRM_META_SCHEMA_COLUMNS_DRIFTED");
  }

  const { rows: constraints } = await client.query<{
    name: string; table_name: string; type: string; columns: unknown;
    ref_schema: string | null; ref_table: string | null; ref_columns: unknown;
    delete_action: string | null; update_action: string | null; match_type: string | null;
    validated: boolean; deferrable: boolean; initially_deferred: boolean; check_expression: string | null;
  }>(`
    SELECT k.conname AS name,t.relname AS table_name,k.contype::text AS type,
      COALESCE((
        SELECT jsonb_agg(a.attname::text ORDER BY x.ord)
        FROM unnest(k.conkey) WITH ORDINALITY x(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=x.attnum
      ),'[]'::jsonb) AS columns,
      rn.nspname AS ref_schema,rt.relname AS ref_table,
      COALESCE((
        SELECT jsonb_agg(a.attname::text ORDER BY x.ord)
        FROM unnest(k.confkey) WITH ORDINALITY x(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=rt.oid AND a.attnum=x.attnum
      ),'[]'::jsonb) AS ref_columns,
      CASE WHEN k.contype='f' THEN k.confdeltype::text END AS delete_action,
      CASE WHEN k.contype='f' THEN k.confupdtype::text END AS update_action,
      CASE WHEN k.contype='f' THEN k.confmatchtype::text END AS match_type,
      k.convalidated AS validated,
      k.condeferrable AS deferrable,k.condeferred AS initially_deferred,
      pg_get_expr(k.conbin,k.conrelid) AS check_expression
    FROM pg_constraint k
    JOIN pg_class t ON t.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_class rt ON rt.oid=k.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid=rt.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[])
      AND k.conname<>$3
    ORDER BY t.relname,k.conname
  `, [schema, CRM_META_LEAD_ADS_TABLES, CRM_META_PHONE_IDENTITY_DIAGNOSTIC_CONSTRAINT]);
  if (constraints.length !== Object.keys(EXPECTED_CONSTRAINTS).length) {
    fail("CRM_META_SCHEMA_CONSTRAINTS_DRIFTED", "field=constraint_count");
  }
  const constraintNames = new Set<string>();
  for (const row of constraints) {
    const expected = EXPECTED_CONSTRAINTS[row.name];
    const localColumns = Array.isArray(row.columns) ? row.columns : null;
    const referencedColumns = Array.isArray(row.ref_columns) ? row.ref_columns : null;
    let mismatch: string | undefined;
    if (!expected) mismatch = "unexpected_constraint";
    else if (constraintNames.has(row.name)) mismatch = "duplicate_constraint";
    else if (row.table_name !== expected.table) mismatch = "table";
    else if (row.type !== expected.type) mismatch = "type";
    else if (!localColumns || JSON.stringify(localColumns) !== JSON.stringify(expected.columns)) {
      mismatch = "local_columns";
    } else if (expected.type === "f" &&
      (row.ref_schema !== schema || row.ref_table !== expected.refTable ||
        !referencedColumns || JSON.stringify(referencedColumns) !== JSON.stringify(expected.refColumns))) {
      mismatch = "referenced_target";
    } else if (expected.type !== "f" &&
      (row.ref_schema !== null || row.ref_table !== null ||
        !referencedColumns || referencedColumns.length !== 0)) {
      mismatch = "unexpected_referenced_target";
    } else if (row.delete_action !== (expected.type === "f" ? "a" : null) ||
      row.update_action !== (expected.type === "f" ? "a" : null) ||
      row.match_type !== (expected.type === "f" ? "s" : null)) {
      mismatch = "foreign_key_actions";
    } else if (row.validated !== true) mismatch = "validation_state";
    else if (row.deferrable !== false || row.initially_deferred !== false) mismatch = "deferrability";
    else if (
      normalizeCrmMetaCatalogExpression(row.check_expression) !==
      normalizeCrmMetaCatalogExpression(expected.check)
    ) mismatch = "check_expression";
    if (mismatch) {
      fail("CRM_META_SCHEMA_CONSTRAINTS_DRIFTED", `field=${mismatch} constraint=${row.name}`);
    }
    constraintNames.add(row.name);
  }

  const { rows: indexes } = await client.query<{
    name: string; table_name: string; method: string; unique: boolean; primary: boolean;
    valid: boolean; ready: boolean; live: boolean; key_count: number; attr_count: number;
    constraint_name: string | null; key_details: unknown; included_columns: unknown;
    predicate: string | null; expressions: string | null; definition: string;
  }>(`
    SELECT i.relname::text AS name,t.relname::text AS table_name,am.amname::text AS method,
      x.indisunique AS unique,x.indisprimary AS primary,x.indisvalid AS valid,
      x.indisready AS ready,x.indislive AS live,x.indnkeyatts::integer AS key_count,
      x.indnatts::integer AS attr_count,
      backing.conname::text AS constraint_name,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'column',a.attname::text,
          'descending',((x.indoption[k.ord::integer-1]::integer & 1) <> 0),
          'nullsFirst',((x.indoption[k.ord::integer-1]::integer & 2) <> 0),
          'collationMatchesColumn',(x.indcollation[k.ord::integer-1]=a.attcollation),
          'defaultOpclass',opc.opcdefault
        ) ORDER BY k.ord)
        FROM unnest(x.indkey) WITH ORDINALITY k(attnum,ord)
        LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
        LEFT JOIN pg_opclass opc ON opc.oid=x.indclass[k.ord::integer-1]
        WHERE k.ord<=x.indnkeyatts
      ),'[]'::jsonb) AS key_details,
      COALESCE((
        SELECT jsonb_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(x.indkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
        WHERE k.ord>x.indnkeyatts
      ),'[]'::jsonb) AS included_columns,
      pg_get_expr(x.indpred,x.indrelid) AS predicate,
      pg_get_expr(x.indexprs,x.indrelid) AS expressions,
      pg_get_indexdef(x.indexrelid) AS definition
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_am am ON am.oid=i.relam
    LEFT JOIN LATERAL (
      SELECT c.conname FROM pg_constraint c
      WHERE c.conindid=x.indexrelid AND c.conrelid=x.indrelid
      ORDER BY c.conname LIMIT 1
    ) backing ON true
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[])
    ORDER BY t.relname,i.relname
  `, [schema, CRM_META_LEAD_ADS_TABLES]);
  const expectedIndexes = { ...PRIMARY_INDEXES, ...EXPLICIT_INDEXES };
  if (indexes.length !== Object.keys(expectedIndexes).length) fail("CRM_META_SCHEMA_INDEXES_DRIFTED");
  const indexNames = new Set<string>();
  for (const row of indexes) {
    const expected = expectedIndexes[row.name];
    const keyDetails = Array.isArray(row.key_details)
      ? row.key_details as Array<{
        column: string; descending: boolean; nullsFirst: boolean;
        collationMatchesColumn: boolean; defaultOpclass: boolean;
      }>
      : null;
    const includedColumns = Array.isArray(row.included_columns) ? row.included_columns : null;
    const expectedConstraint = expected?.primary ? row.name : null;
    if (
      !expected || indexNames.has(row.name) || row.table_name !== expected.table ||
      row.method !== "btree" || row.unique !== Boolean(expected.unique) ||
      row.primary !== Boolean(expected.primary) || !row.valid || !row.ready || !row.live ||
      row.key_count !== expected.keys.length || row.attr_count !== expected.keys.length ||
      row.constraint_name !== expectedConstraint || !keyDetails ||
      keyDetails.length !== expected.keys.length || !includedColumns || includedColumns.length !== 0 ||
      normalizeCrmMetaCatalogExpression(row.predicate) !==
        normalizeCrmMetaCatalogExpression(expected.predicate) ||
      row.expressions !== null ||
      normalizeCrmMetaCatalogExpression(row.definition) !==
        normalizeCrmMetaCatalogExpression(expectedIndexDefinition(row.name, schema, expected))
    ) fail("CRM_META_SCHEMA_INDEXES_DRIFTED");
    for (let position = 0; position < expected.keys.length; position += 1) {
      const key = expected.keys[position];
      const actual = keyDetails[position];
      const descending = Boolean(key.descending);
      let keyMismatch: string | undefined;
      if (actual.column !== key.column) keyMismatch = "column_order";
      else if (actual.descending !== descending) keyMismatch = "sort_direction";
      else if (actual.nullsFirst !== descending) keyMismatch = "null_order";
      else if (actual.collationMatchesColumn !== true) keyMismatch = "collation";
      else if (actual.defaultOpclass !== true) keyMismatch = "operator_class";
      if (keyMismatch) {
        fail(
          "CRM_META_SCHEMA_INDEXES_DRIFTED",
          `field=${keyMismatch} index=${row.name} position=${position + 1}`,
        );
      }
    }
    indexNames.add(row.name);
  }

  const { rows: grants } = await client.query<{
    table_name: string; owner_name: string; grantee_name: string | null; privilege_type: string | null;
    is_grantable: boolean | null; can_select: boolean; can_insert: boolean; can_update: boolean;
    can_delete: boolean; can_truncate: boolean; can_reference: boolean; can_trigger: boolean;
  }>(`
    SELECT c.relname AS table_name,owner.rolname AS owner_name,
      grantee.rolname AS grantee_name,acl.privilege_type,acl.is_grantable,
      has_table_privilege('aichm_app_runtime',c.oid,'SELECT') AS can_select,
      has_table_privilege('aichm_app_runtime',c.oid,'INSERT') AS can_insert,
      has_table_privilege('aichm_app_runtime',c.oid,'UPDATE') AS can_update,
      has_table_privilege('aichm_app_runtime',c.oid,'DELETE') AS can_delete,
      has_table_privilege('aichm_app_runtime',c.oid,'TRUNCATE') AS can_truncate,
      has_table_privilege('aichm_app_runtime',c.oid,'REFERENCES') AS can_reference,
      has_table_privilege('aichm_app_runtime',c.oid,'TRIGGER') AS can_trigger
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles owner ON owner.oid=c.relowner
    LEFT JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
      ON acl.grantee<>c.relowner
    LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
    ORDER BY c.relname,grantee.rolname,acl.privilege_type
  `, [schema, CRM_META_LEAD_ADS_TABLES]);
  const expectedPrivileges: Record<string, Set<string>> = {
    admissions_marketing_consent_events: new Set(["SELECT", "INSERT", "UPDATE"]),
    admissions_lead_touchpoints: new Set(["SELECT", "INSERT"]),
    admissions_meta_lead_links: new Set(["SELECT", "INSERT"]),
    admissions_meta_event_outbox: new Set(["SELECT", "INSERT", "UPDATE"]),
  };
  const grouped = new Map<string, typeof grants>();
  for (const row of grants) {
    const key = row.table_name;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  if (grouped.size !== CRM_META_LEAD_ADS_TABLES.length) fail("CRM_META_SCHEMA_RUNTIME_GRANTS_DRIFTED");
  for (const table of CRM_META_LEAD_ADS_TABLES) {
    const rows = grouped.get(table) ?? [];
    const first = rows[0];
    const aclPairs = new Set(
      rows.filter(row => row.privilege_type !== null).map(row =>
        `${row.grantee_name ?? "PUBLIC"}:${row.privilege_type}:${row.is_grantable ? "grantable" : "plain"}`,
      ),
    );
    const expectedPairs = new Set(
      Array.from(expectedPrivileges[table], privilege => `aichm_app_runtime:${privilege}:plain`),
    );
    if (
      first.owner_name !== "aichm_crm_owner" ||
      aclPairs.size !== expectedPairs.size ||
      Array.from(expectedPairs).some(pair => !aclPairs.has(pair)) ||
      first.can_select !== true || first.can_insert !== true ||
      first.can_update !== expectedPrivileges[table].has("UPDATE") ||
      first.can_delete !== false || first.can_truncate !== false ||
      first.can_reference !== false || first.can_trigger !== false
    ) fail("CRM_META_SCHEMA_RUNTIME_GRANTS_DRIFTED");
  }

  const { rows: sequences } = await client.query<{ sequence_name: string }>(`
    SELECT seq.relname AS sequence_name
    FROM pg_class seq
    JOIN pg_namespace n ON n.oid=seq.relnamespace
    JOIN pg_depend d ON d.objid=seq.oid AND d.classid='pg_class'::regclass
    JOIN pg_class tbl ON tbl.oid=d.refobjid
    WHERE n.nspname=$1 AND seq.relkind='S' AND tbl.relname=ANY($2::text[])
  `, [schema, CRM_META_LEAD_ADS_TABLES]);
  if (sequences.length) fail("CRM_META_SCHEMA_SEQUENCE_DRIFTED");
}
