import { AICHM_MIGRATION_ORDER, FUTURE_CALENDAR_TABLES } from "./aichm-migration-plan";

export const AICHM_CONTROL_MIGRATION_VERSION = "aichm-migration-control-v1";
export const AICHM_APP_SCHEMA_MIGRATION_VERSION = "aichm-app-schema-v1";
export const AICHM_APP_SCHEMA_MIGRATION_NAME = "empty-production-application-schema";

export const AICHM_STAGE1_TABLES = Object.freeze(
  AICHM_MIGRATION_ORDER
    .map(({ table }) => table)
    .filter((table) => !FUTURE_CALENDAR_TABLES.includes(table as (typeof FUTURE_CALENDAR_TABLES)[number])),
);

export const AICHM_STAGE1_ENUM_TYPES = Object.freeze([
  "lms_certificate_status",
  "lms_content_status",
  "lms_enrollment_status",
  "lms_invitation_status",
  "lms_role",
]);

export function normalizeAichmColumnDefault(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/\bpublic\./g, "aichm.")
    .replace(
      /nextval\('(?:(?:"?(?:public|aichm)"?)\.)?"?([a-z_][a-z0-9_]*)"?\'::regclass\)/gi,
      "nextval('aichm.$1'::regclass)",
    )
    .replace(
      /::(?:(?:"?(?:public|aichm)"?)\.)?"?(lms_(?:certificate_status|content_status|enrollment_status|invitation_status|role))"?\b/gi,
      "::aichm.$1",
    );
}

export interface EnumDefinition {
  name: string;
  labels: string[];
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertEnumDefinitions(definitions: EnumDefinition[]): void {
  const names = definitions.map(({ name }) => name).sort();
  const expected = [...AICHM_STAGE1_ENUM_TYPES].sort();
  if (
    JSON.stringify(names) !== JSON.stringify(expected) ||
    definitions.some(({ labels }) => !labels.length || new Set(labels).size !== labels.length)
  ) {
    throw new Error("The live source enum definitions do not match the reviewed Stage 1 type allowlist.");
  }
}

export function buildAichmStage1ApplicationSql(
  sourceSchemaDump: string,
  enumDefinitions: EnumDefinition[],
): string {
  assertEnumDefinitions(enumDefinitions);
  const normalizedDump = sourceSchemaDump.replace(/\r\n/g, "\n");
  if (/^(?:COPY|INSERT INTO)\s/m.test(normalizedDump)) {
    throw new Error("A schema-only source dump must not contain row-data statements.");
  }

  const sourceTables: string[] = [];
  const tablePattern = /^CREATE TABLE public\.([a-z_][a-z0-9_]*)\s*\(/gim;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tablePattern.exec(normalizedDump)) !== null) {
    sourceTables.push(tableMatch[1]);
  }
  sourceTables.sort();
  const expectedTables = [...AICHM_STAGE1_TABLES].sort();
  if (JSON.stringify(sourceTables) !== JSON.stringify(expectedTables)) {
    throw new Error("The schema-only source dump does not match the complete Stage 1 table allowlist.");
  }

  let rewritten = normalizedDump
    .split("\n")
    .filter((line) => !/^\\(?:restrict|unrestrict)\b/.test(line))
    .join("\n")
    .replace(/^CREATE SCHEMA public;\s*$/gm, "")
    .replace(/\bpublic\./g, "aichm.")
    .replace(/Schema: public;/g, "Schema: aichm;")
    .replace(/SET search_path = public(?:, pg_catalog)?;/g, "SET search_path = aichm, pg_catalog;");

  const executableLines = rewritten
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  if (
    /\bpublic\./.test(executableLines) ||
    /^CREATE SCHEMA public\b/m.test(executableLines) ||
    /^CREATE TABLE (?!aichm\.)/m.test(executableLines) ||
    /^GRANT\b/m.test(executableLines) ||
    /^COPY\b/m.test(executableLines) ||
    /^INSERT INTO (?!aichm\.schema_migrations\b)/m.test(executableLines)
  ) {
    throw new Error("The transformed application schema contains an unexpected schema, privilege, or data statement.");
  }

  const enumSql = enumDefinitions
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, labels }) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
        throw new Error("The source enum catalog contains an invalid type identifier.");
      }
      return `CREATE TYPE aichm.${name} AS ENUM (${labels.map(quoteLiteral).join(", ")});`;
    })
    .join("\n");
  const rowSecuritySql = AICHM_STAGE1_TABLES.map(
    (table) => `ALTER TABLE aichm.${table} ENABLE ROW LEVEL SECURITY;`,
  ).join("\n");
  const accessRevocationSql = `
REVOKE ALL ON SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA aichm
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA aichm
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
`;
  const migrationRecord = `
INSERT INTO aichm.schema_migrations (version, migration_name)
VALUES (${quoteLiteral(AICHM_APP_SCHEMA_MIGRATION_VERSION)}, ${quoteLiteral(AICHM_APP_SCHEMA_MIGRATION_NAME)})
ON CONFLICT (version) DO NOTHING;
`;

  return [
    "-- Generated from a fresh production-primary schema-only catalog export.",
    "-- Contains no application row data; Replit internal schemas and Calendar are excluded.",
    enumSql,
    rewritten.trim(),
    rowSecuritySql,
    accessRevocationSql.trim(),
    migrationRecord.trim(),
    "",
  ].filter(Boolean).join("\n\n");
}
