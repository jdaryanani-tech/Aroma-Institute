import type { PoolClient } from "pg";
import {
  CRM_META_PHONE_IDENTITY_DIAGNOSTIC_COLUMNS,
  CRM_META_PHONE_IDENTITY_DIAGNOSTIC_CONSTRAINT,
  normalizeCrmMetaCatalogExpression,
} from "./crm-meta-migration-postconditions";

type Queryable = Pick<PoolClient, "query">;
type ColumnSpec = { type: "text" | "boolean"; notNull: false };

const TABLE = "admissions_meta_lead_links";
const EXPECTED_COLUMNS: Record<string, ColumnSpec> = {
  phone_number_field_state: { type: "text", notNull: false },
  mobile_phone_field_state: { type: "text", notNull: false },
  whatsapp_number_field_state: { type: "text", notNull: false },
  phone_normalization_outcome: { type: "text", notNull: false },
  phone_selected_field: { type: "text", notNull: false },
  phone_fallback_attempted: { type: "boolean", notNull: false },
  phone_invalid_higher_priority_blocked_fallback: { type: "boolean", notNull: false },
};

export const CRM_META_PHONE_DIAGNOSTIC_CHECK_EXPRESSION = `(
  phone_number_field_state IS NULL
  AND mobile_phone_field_state IS NULL
  AND whatsapp_number_field_state IS NULL
  AND phone_normalization_outcome IS NULL
  AND phone_selected_field IS NULL
  AND phone_fallback_attempted IS NULL
  AND phone_invalid_higher_priority_blocked_fallback IS NULL
) OR (
  phone_number_field_state IS NOT NULL
  AND mobile_phone_field_state IS NOT NULL
  AND whatsapp_number_field_state IS NOT NULL
  AND phone_normalization_outcome IS NOT NULL
  AND phone_fallback_attempted IS NOT NULL
  AND phone_invalid_higher_priority_blocked_fallback IS NOT NULL
  AND phone_number_field_state IN ('missing','blank','populated')
  AND mobile_phone_field_state IN ('missing','blank','populated')
  AND whatsapp_number_field_state IN ('missing','blank','populated')
  AND phone_normalization_outcome IN (
    'valid','no_phone_field','phone_fields_blank',
    'invalid_characters','invalid_length','invalid_mobile_prefix'
  )
  AND (
    phone_selected_field IS NULL
    OR phone_selected_field IN ('phone_number','mobile_phone','whatsapp_number')
  )
  AND phone_fallback_attempted IS NOT NULL
  AND phone_invalid_higher_priority_blocked_fallback IS NOT NULL
)`;

function fail(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

function validateSchema(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail("CRM_META_PHONE_DIAGNOSTICS_SCHEMA_REJECTED");
}

export async function assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent(
  client: Queryable,
  schema = "public",
): Promise<void> {
  validateSchema(schema);
  const { rows: columns } = await client.query<{ column_name: string }>(`
    SELECT a.attname AS column_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND c.relname=$2
      AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname=ANY($3::text[])
  `, [schema, TABLE, CRM_META_PHONE_IDENTITY_DIAGNOSTIC_COLUMNS]);
  const { rows: constraints } = await client.query<{ constraint_name: string }>(`
    SELECT conname AS constraint_name
    FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND k.conname=$3
  `, [schema, TABLE, CRM_META_PHONE_IDENTITY_DIAGNOSTIC_CONSTRAINT]);
  if (columns.length || constraints.length) fail("CRM_META_PHONE_DIAGNOSTICS_SCHEMA_CONFLICT");
}

export async function assertCrmMetaPhoneIdentityDiagnosticsPostconditions(
  client: Queryable,
  schema = "public",
): Promise<void> {
  validateSchema(schema);
  const { rows: columns } = await client.query<{
    column_name: string;
    data_type: string;
    not_null: boolean;
    default_expression: string | null;
    generated: string;
    identity: string;
  }>(`
    SELECT a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS data_type,
      a.attnotnull AS not_null,pg_get_expr(d.adbin,d.adrelid) AS default_expression,
      a.attgenerated AS generated,a.attidentity AS identity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relname=$2
      AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname=ANY($3::text[])
    ORDER BY a.attname
  `, [schema, TABLE, CRM_META_PHONE_IDENTITY_DIAGNOSTIC_COLUMNS]);
  if (columns.length !== CRM_META_PHONE_IDENTITY_DIAGNOSTIC_COLUMNS.length) {
    fail("CRM_META_PHONE_DIAGNOSTICS_COLUMNS_DRIFTED");
  }
  for (const column of columns) {
    const expected = EXPECTED_COLUMNS[column.column_name];
    if (
      !expected || column.data_type !== expected.type || column.not_null !== expected.notNull ||
      column.default_expression !== null || column.generated !== "" || column.identity !== ""
    ) fail("CRM_META_PHONE_DIAGNOSTICS_COLUMNS_DRIFTED");
  }

  const { rows: constraints } = await client.query<{
    constraint_name: string;
    type: string;
    validated: boolean;
    check_expression: string | null;
  }>(`
    SELECT k.conname AS constraint_name,k.contype::text AS type,k.convalidated AS validated,
      pg_get_expr(k.conbin,k.conrelid) AS check_expression
    FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND k.conname=$3
  `, [schema, TABLE, CRM_META_PHONE_IDENTITY_DIAGNOSTIC_CONSTRAINT]);
  if (
    constraints.length !== 1 ||
    constraints[0].type !== "c" ||
    constraints[0].validated !== true ||
    normalizeCrmMetaCatalogExpression(constraints[0].check_expression) !==
      normalizeCrmMetaCatalogExpression(CRM_META_PHONE_DIAGNOSTIC_CHECK_EXPRESSION)
  ) fail("CRM_META_PHONE_DIAGNOSTICS_CONSTRAINT_DRIFTED");
}
