import assert from "node:assert/strict";
import test from "node:test";
import { classifyPgDumpDiagnostic } from "./pg-dump-diagnostic";

test("pg_dump diagnostics return only allowlisted categories and safe metadata", () => {
  const cases = [
    ["could not connect to server", "connection"],
    ["password authentication failed", "authentication"],
    ["SSL certificate verification failed", "ssl"],
    ["permission denied for relation", "permission"],
    ["feature not supported", "unsupported_feature"],
    ["SQLSTATE 40001 serialization failure", "serialization"],
    ['relation "opaque" does not exist', "missing_relation"],
    ["could not write file: no space left", "disk_io"],
    ["server version mismatch", "version"],
    ["unrecognized safe-classifier text", "unknown"],
  ] as const;

  for (const [stderr, category] of cases) {
    const diagnostic = classifyPgDumpDiagnostic(stderr, 1);
    assert.deepEqual(diagnostic, {
      phase: "pg_dump",
      exitCode: 1,
      sqlState: category === "serialization" ? "40001" : null,
      category,
    });
    assert.equal("stderr" in diagnostic, false);
  }
});

test("diagnostic preserves numeric process result and SQLSTATE, not raw error text", () => {
  const diagnostic = classifyPgDumpDiagnostic(
    "server returned SQL state: 42501; private-looking raw detail",
    2,
    "pg_dump",
  );
  assert.deepEqual(diagnostic, {
    phase: "pg_dump",
    exitCode: 2,
    sqlState: "42501",
    category: "permission",
  });
  assert.equal(JSON.stringify(diagnostic).includes("private-looking"), false);
});

test("encrypted stream failures map known local I/O codes to disk_io", () => {
  assert.deepEqual(
    classifyPgDumpDiagnostic("", -1, "encrypted_stream", "ENOSPC"),
    {
      phase: "encrypted_stream",
      exitCode: -1,
      sqlState: null,
      category: "disk_io",
    },
  );
});
