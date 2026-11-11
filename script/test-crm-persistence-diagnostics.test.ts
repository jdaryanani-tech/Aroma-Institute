import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScratchIdentityMismatchDiagnostic,
  type ScratchProof,
} from "./test-crm-persistence";

const scratchRoot = "/dev/shm/aichm-crm-test-0123456789abcdef0123456789abcdef";
const proof: ScratchProof = {
  version: 1,
  instanceId: "0123456789abcdef0123456789abcdef",
  databaseName: "aichm_test_0123456789abcdef0123456789abcdef",
  port: 55432,
  dataDirectory: `${scratchRoot}/data`,
  systemIdentifier: "7609038573599248406",
  postmasterPid: 4321,
};

const matchingIdentity = {
  database_name: proof.databaseName,
  database_user: "postgres",
  data_directory: proof.dataDirectory,
  host: "127.0.0.1",
  port: proof.port,
  system_identifier: proof.systemIdentifier,
  in_recovery: false,
};

function diagnostic(
  identity: typeof matchingIdentity,
  resolvedDirectory = proof.dataDirectory,
) {
  return buildScratchIdentityMismatchDiagnostic(proof, identity, resolvedDirectory);
}

test("scratch identity diagnostics report every required comparison without changing acceptance", () => {
  const cases = [
    ["databaseName", { ...matchingIdentity, database_name: "other_test_db" }, proof.dataDirectory],
    ["databaseUser", { ...matchingIdentity, database_user: "other_user" }, proof.dataDirectory],
    ["dataDirectory", matchingIdentity, `${scratchRoot}/other-data`],
    ["serverAddress", { ...matchingIdentity, host: "::1" }, proof.dataDirectory],
    ["port", { ...matchingIdentity, port: proof.port + 1 }, proof.dataDirectory],
    ["systemIdentifier", { ...matchingIdentity, system_identifier: "1234" }, proof.dataDirectory],
    ["recoveryState", { ...matchingIdentity, in_recovery: true }, proof.dataDirectory],
  ] as const;

  assert.deepEqual(diagnostic(matchingIdentity).mismatches, []);
  for (const [field, identity, resolvedDirectory] of cases) {
    const result = diagnostic(identity, resolvedDirectory);
    assert.equal(result.code, "CRM_TEST_SCRATCH_IDENTITY_MISMATCH");
    assert.deepEqual(result.mismatches.map(mismatch => mismatch.field), [field]);
  }
});

test("scratch identity diagnostic reports multiple mismatches with sanitized expected and observed values", () => {
  const result = diagnostic({
    ...matchingIdentity,
    database_name: "unexpected database with password",
    database_user: "user-with-secret",
    data_directory: "/outside/secret/path",
    host: "10.20.30.40",
    port: 6432,
    system_identifier: "123456",
    in_recovery: true,
  }, "/outside/secret/path");

  assert.deepEqual(result, {
    status: "failed",
    code: "CRM_TEST_SCRATCH_IDENTITY_MISMATCH",
    mismatches: [
      {
        field: "databaseName",
        expected: proof.databaseName,
        observed: "<invalid-value>",
      },
      { field: "databaseUser", expected: "postgres", observed: "user-with-secret" },
      {
        field: "dataDirectory",
        expected: "<scratch-root>/data",
        observed: "<outside-scratch>",
      },
      { field: "serverAddress", expected: "127.0.0.1", observed: "10.20.30.40" },
      { field: "port", expected: proof.port, observed: 6432 },
      {
        field: "systemIdentifier",
        expected: proof.systemIdentifier,
        observed: "123456",
      },
      { field: "recoveryState", expected: false, observed: true },
    ],
  });

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "postgresql://",
    "password",
    "/dev/shm/aichm-crm-test-0123456789abcdef0123456789abcdef",
    "/outside/secret/path",
    "DATABASE_URL",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("missing identity data is reported without exposing paths or environment values", () => {
  const result = buildScratchIdentityMismatchDiagnostic(proof, undefined, undefined);
  assert.deepEqual(
    result.mismatches.map(mismatch => mismatch.field),
    [
      "databaseName",
      "databaseUser",
      "dataDirectory",
      "serverAddress",
      "port",
      "systemIdentifier",
      "recoveryState",
    ],
  );
  assert.deepEqual(
    result.mismatches.map(mismatch => [mismatch.field, mismatch.observed]),
    [
      ["databaseName", "<unavailable>"],
      ["databaseUser", "<unavailable>"],
      ["dataDirectory", "<unavailable>"],
      ["serverAddress", "<unavailable>"],
      ["port", "<invalid-port>"],
      ["systemIdentifier", "<unavailable>"],
      ["recoveryState", "<invalid-boolean>"],
    ],
  );
});
