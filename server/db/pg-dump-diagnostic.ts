export type PgDumpErrorCategory =
  | "connection"
  | "authentication"
  | "ssl"
  | "permission"
  | "unsupported_feature"
  | "serialization"
  | "missing_relation"
  | "disk_io"
  | "version"
  | "unknown";

export type PgDumpDiagnostic = {
  phase: "pg_dump" | "encrypted_stream";
  exitCode: number;
  sqlState: string | null;
  category: PgDumpErrorCategory;
};

export function classifyPgDumpDiagnostic(
  stderr: string,
  exitCode: number,
  phase: PgDumpDiagnostic["phase"] = "pg_dump",
  systemErrorCode?: string,
): PgDumpDiagnostic {
  const text = stderr.toLowerCase();
  const sqlState =
    stderr.match(/(?:sqlstate|sql state)\s*[:=]?\s*([0-9a-z]{5})/i)?.[1]?.toUpperCase() ??
    stderr.match(/\[([0-9a-z]{5})\]/i)?.[1]?.toUpperCase() ??
    null;
  let category: PgDumpErrorCategory = "unknown";

  if (/certificate|ssl|tls/.test(text)) {
    category = "ssl";
  } else if (
    /password authentication|authentication failed|no password supplied|pg_hba/.test(text) ||
    sqlState?.startsWith("28")
  ) {
    category = "authentication";
  } else if (
    /could not connect|connection refused|connection timed out|network is unreachable|name or service not known/.test(text) ||
    sqlState?.startsWith("08")
  ) {
    category = "connection";
  } else if (
    /permission denied|must be owner|not have permission|insufficient privilege/.test(text) ||
    sqlState === "42501"
  ) {
    category = "permission";
  } else if (/relation .* does not exist|undefined table/.test(text) || sqlState === "42P01") {
    category = "missing_relation";
  } else if (
    /unsupported feature|feature not supported|not supported|unrecognized parameter/.test(text) ||
    sqlState === "0A000"
  ) {
    category = "unsupported_feature";
  } else if (
    /serialization failure|could not serialize|deadlock detected/.test(text) ||
    sqlState === "40001" ||
    sqlState === "40P01"
  ) {
    category = "serialization";
  } else if (
    /no space left|disk quota|i\/o error|input\/output error|could not write|could not read/.test(text) ||
    sqlState?.startsWith("58") ||
    ["ENOSPC", "EDQUOT", "EIO"].includes(systemErrorCode ?? "")
  ) {
    category = "disk_io";
  } else if (/server version mismatch|unsupported version|archive version/.test(text)) {
    category = "version";
  }

  return { phase, exitCode, sqlState, category };
}
