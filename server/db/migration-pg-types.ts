import { types as pgTypes } from "pg";

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
export const migrationPgTypes = {
  getTypeParser(oid: number, format?: string) {
    if (format !== "binary" && PRESERVE_AS_TEXT_OIDS.has(oid)) {
      return (value: string) => value;
    }
    return pgTypes.getTypeParser(oid, format);
  },
};
