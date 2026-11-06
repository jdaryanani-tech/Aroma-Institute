import { types as pgTypes, type CustomTypesConfig } from "pg";

const PRESERVE_AS_TEXT_OIDS = new Set([
  1082, // date
  1083, // time without time zone
  1114, // timestamp without time zone
  1184, // timestamp with time zone
  1266, // time with time zone
]);

/**
 * Keep PostgreSQL date/time text exact during a migration. The default pg
 * parser turns timestamps into JavaScript Date objects and truncates
 * sub-millisecond precision. The pool also sets its session timezone to UTC.
 */
type TextParser<T> = (value: string) => T | string;
type BinaryParser<T> = (value: Buffer) => T | string;

function getMigrationTypeParser<T>(oid: number): TextParser<T>;
function getMigrationTypeParser<T>(oid: number, format: "text"): TextParser<T>;
function getMigrationTypeParser<T>(oid: number, format: "binary"): BinaryParser<T>;
function getMigrationTypeParser<T>(
  oid: number,
  format: "text" | "binary" = "text",
): TextParser<T> | BinaryParser<T> {
  if (format === "text" && PRESERVE_AS_TEXT_OIDS.has(oid)) {
    return (value: string) => value;
  }
  return format === "binary"
    ? pgTypes.getTypeParser(oid, "binary")
    : pgTypes.getTypeParser(oid, "text");
}

export const migrationPgTypes: CustomTypesConfig = {
  getTypeParser: getMigrationTypeParser,
};
