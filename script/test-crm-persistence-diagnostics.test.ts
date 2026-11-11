import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScratchIdentityMismatchDiagnostic,
  runAfterScratchIdentityVerification,
  verifyScratchIdentityObservation,
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

test("the live identity gate rejects each mismatch and prevents the test child from launching", async () => {
  const cases = [
    ["databaseName", { ...matchingIdentity, database_name: "other_test_db" }, proof.dataDirectory],
    ["databaseUser", { ...matchingIdentity, database_user: "other_user" }, proof.dataDirectory],
    ["dataDirectory", matchingIdentity, `${scratchRoot}/other-data`],
    ["serverAddress", { ...matchingIdentity, host: "::1" }, proof.dataDirectory],
    ["port", { ...matchingIdentity, port: proof.port + 1 }, proof.dataDirectory],
    ["systemIdentifier", { ...matchingIdentity, system_identifier: "1234" }, proof.dataDirectory],
    ["recoveryState", { ...matchingIdentity, in_recovery: true }, proof.dataDirectory],
  ] as const;

  let childLaunches = 0;
  await runAfterScratchIdentityVerification(
    async () => verifyScratchIdentityObservation(proof, matchingIdentity, proof.dataDirectory, () => {}),
    async () => { childLaunches += 1; },
  );
  assert.equal(childLaunches, 1);

  for (const [field, identity, resolvedDirectory] of cases) {
    const emitted: string[] = [];
    await assert.rejects(
      runAfterScratchIdentityVerification(
        async () => verifyScratchIdentityObservation(
          proof,
          identity,
          resolvedDirectory,
          line => emitted.push(line),
        ),
        async () => { childLaunches += 1; },
      ),
      /CRM_TEST_SCRATCH_IDENTITY_MISMATCH/,
    );
    assert.equal(childLaunches, 1, `${field} mismatch must prevent child launch`);
    assert.equal(emitted.length, 1);
    const result = JSON.parse(emitted[0]) as ReturnType<typeof diagnostic>;
    assert.equal(result.code, "CRM_TEST_SCRATCH_IDENTITY_MISMATCH");
    assert.deepEqual(result.mismatches.map(mismatch => mismatch.field), [field]);
  }
});

test("structured identity diagnostic is emitted before cleanup and remains observable afterward", async () => {
  const output: string[] = [];
  const order: string[] = [];
  const scratch = new Map<string, string>([["identity.json", JSON.stringify(proof)]]);
  const badIdentity = { ...matchingIdentity, host: "::1" };

  await assert.rejects(async () => {
    try {
      await runAfterScratchIdentityVerification(
        async () => verifyScratchIdentityObservation(
          proof,
          badIdentity,
          proof.dataDirectory,
          line => {
            output.push(line);
            order.push("diagnostic");
          },
        ),
        async () => {
          order.push("test-child");
        },
      );
    } finally {
      order.push("cleanup-start");
      scratch.clear();
    }
  }, /CRM_TEST_SCRATCH_IDENTITY_MISMATCH/);

  assert.deepEqual(order, ["diagnostic", "cleanup-start"]);
  assert.equal(scratch.size, 0);
  assert.equal(output.length, 1);
  const diagnosticOutput = JSON.parse(output[0]) as ReturnType<typeof diagnostic>;
  assert.equal(diagnosticOutput.code, "CRM_TEST_SCRATCH_IDENTITY_MISMATCH");
  assert.equal(diagnosticOutput.mismatches[0]?.field, "serverAddress");
  assert.equal(diagnosticOutput.mismatches[0]?.expected, "127.0.0.1");
  assert.equal(diagnosticOutput.mismatches[0]?.observed, "::1");
});

test("multiple mismatches are reported with redacted credential-like values and paths", () => {
  const result = diagnostic({
    ...matchingIdentity,
    database_name: "postgresql://private-user:private-password@host/db",
    database_user: "user-with-secret-token",
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
        observed: "<redacted>",
      },
      { field: "databaseUser", expected: "postgres", observed: "<redacted>" },
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
    "private-user",
    "private-password",
    "secret-token",
    "/dev/shm/aichm-crm-test-0123456789abcdef0123456789abcdef",
    "/outside/secret/path",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("credentials, URLs, tokens, and arbitrary environment values are excluded from output", () => {
  const identityWithUnrelatedFields = {
    ...matchingIdentity,
    database_name: "postgresql://user:password@remote.invalid/db",
    database_user: "api-key-secret-value",
    connectionString: "postgresql://must-not-appear:pass@host/db",
    password: "password-sentinel-must-not-appear",
    accessToken: "token-sentinel-must-not-appear",
    arbitraryEnvironmentValue: "environment-sentinel-must-not-appear",
  };
  const result = buildScratchIdentityMismatchDiagnostic(
    proof,
    identityWithUnrelatedFields,
    "/outside/environment-sentinel-must-not-appear",
  );
  const serialized = JSON.stringify(result);

  assert.equal(result.code, "CRM_TEST_SCRATCH_IDENTITY_MISMATCH");
  assert.equal(result.mismatches.find(mismatch => mismatch.field === "databaseName")?.observed, "<redacted>");
  assert.equal(result.mismatches.find(mismatch => mismatch.field === "databaseUser")?.observed, "<redacted>");
  for (const forbidden of [
    "postgresql://",
    "password-sentinel-must-not-appear",
    "token-sentinel-must-not-appear",
    "environment-sentinel-must-not-appear",
    "DATABASE_URL",
    "/outside/environment-sentinel-must-not-appear",
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
