import assert from "node:assert/strict";
import test from "node:test";
import { runAfterCrmPreApplyRoleGate } from "./crm-forward-apply-gate";

for (const [label, reason] of [
  ["missing app credentials", "APP_DATABASE_URL_NOT_CONFIGURED"],
  ["invalid app credentials", "APP_DATABASE_URL_INVALID"],
  ["mismatched identity", "APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH"],
  ["invalid role membership", "APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED"],
] as const) {
  test(`pre-apply gate blocks ${label} before ledger or schema writes`, async () => {
    let ledgerWrites = 0;
    let schemaWrites = 0;
    await assert.rejects(
      runAfterCrmPreApplyRoleGate(
        async () => ({ status: "blocked", reason }),
        async () => {
          ledgerWrites += 1;
          schemaWrites += 1;
        },
      ),
      new RegExp(reason),
    );
    assert.equal(ledgerWrites, 0);
    assert.equal(schemaWrites, 0);
  });
}

test("pre-apply gate permits writes only after the valid candidate login passes", async () => {
  let ledgerWrites = 0;
  let schemaWrites = 0;
  const result = await runAfterCrmPreApplyRoleGate(
    async () => ({ status: "ready", reason: null }),
    async () => {
      ledgerWrites += 1;
      schemaWrites += 1;
      return "applied";
    },
  );
  assert.equal(result, "applied");
  assert.equal(ledgerWrites, 1);
  assert.equal(schemaWrites, 1);
});

test("a failed pre-apply probe never invokes the write callback", async () => {
  let writes = 0;
  await assert.rejects(
    runAfterCrmPreApplyRoleGate(
      async () => {
        throw new Error("APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE");
      },
      async () => {
        writes += 1;
      },
    ),
    /APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE/,
  );
  assert.equal(writes, 0);
});
