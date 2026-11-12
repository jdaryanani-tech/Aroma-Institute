import assert from "node:assert/strict";
import test from "node:test";
import { inspectApplicationPreMigrationRoleGate } from "./crm-forward-app-role-preflight";
import { runAfterCrmPreApplyRoleGate } from "./crm-forward-apply-gate";
import type { CrmForwardDatabaseIdentity } from "./crm-forward-migration-guard";

const targetIdentity: CrmForwardDatabaseIdentity = {
  databaseName: "heliumdb",
  databaseOid: "16384",
  databaseUser: "postgres",
  systemIdentifier: "7609038573599248406",
  inRecovery: false,
  defaultTransactionReadOnly: false,
};
const operatorUrl = "postgresql://postgres:operator-pass@db.replit.internal/heliumdb?sslmode=disable";
const baseEnvironment = {
  DATABASE_URL: "postgresql://postgres:platform-pass@db.replit.internal/heliumdb?sslmode=disable",
  AICHM_APP_DATABASE_URL: "postgresql://app-role:app-pass@db.replit.internal/heliumdb?sslmode=disable",
};

function validIdentityRow() {
  return {
    database_name: "heliumdb",
    database_oid: "16384",
    login_role: "aichm_dev_login",
    in_recovery: false,
    transaction_read_only: false,
    login_can_login: true,
    login_is_superuser: false,
    login_can_createdb: false,
    login_can_createrole: false,
    login_inherits: true,
    login_bypasses_rls: false,
    database_owner_member: false,
    app_group_exists: true,
    app_group_can_login: false,
    app_group_is_superuser: false,
    app_group_can_createdb: false,
    app_group_can_createrole: false,
    app_group_inherits: false,
    app_group_bypasses_rls: false,
    app_group_is_member: true,
    app_group_has_memberships: false,
    app_group_member_count: 1,
    app_group_admin_option: false,
    owner_group_member: false,
    migrator_group_member: false,
    direct_memberships: ["aichm_app_runtime"],
  };
}

function poolFor(row: Record<string, unknown>) {
  return {
    async query() {
      return { rows: [row] };
    },
    async end() {},
  };
}

test("preflight blocks missing app secret without opening the candidate pool", async () => {
  let poolOpened = false;
  const gate = await inspectApplicationPreMigrationRoleGate(
    { DATABASE_URL: baseEnvironment.DATABASE_URL },
    targetIdentity,
    operatorUrl,
    () => {
      poolOpened = true;
      return poolFor(validIdentityRow());
    },
  );
  assert.deepEqual(gate, { status: "blocked", reason: "APP_DATABASE_URL_NOT_CONFIGURED" });
  assert.equal(poolOpened, false);
});

test("preflight blocks invalid URL and endpoint mismatch before candidate connection", async () => {
  for (const [environment, reason] of [
    [{ ...baseEnvironment, AICHM_APP_DATABASE_URL: "not-a-url" }, "APP_DATABASE_URL_INVALID"],
    [{
      ...baseEnvironment,
      AICHM_APP_DATABASE_URL: "postgresql://app-role:secret@other.replit.internal/heliumdb?sslmode=disable",
    }, "APP_DATABASE_ENDPOINT_MISMATCH"],
  ] as const) {
    let poolOpened = false;
    const gate = await inspectApplicationPreMigrationRoleGate(
      environment,
      targetIdentity,
      operatorUrl,
      () => {
        poolOpened = true;
        return poolFor(validIdentityRow());
      },
    );
    assert.equal(gate.status, "blocked");
    assert.equal(gate.reason, reason);
    assert.equal(poolOpened, false);
  }
});

test("missing, malformed, or rejected candidate credentials never reach the apply callback", async () => {
  const cases = [
    {
      environment: { DATABASE_URL: baseEnvironment.DATABASE_URL },
      openPool: () => poolFor(validIdentityRow()),
      reason: "APP_DATABASE_URL_NOT_CONFIGURED",
    },
    {
      environment: { ...baseEnvironment, AICHM_APP_DATABASE_URL: "bad-url" },
      openPool: () => poolFor(validIdentityRow()),
      reason: "APP_DATABASE_URL_INVALID",
    },
    {
      environment: baseEnvironment,
      openPool: () => {
        const error = new Error("credentials must not appear in the report") as Error & { code: string };
        error.code = "28P01";
        throw error;
      },
      reason: "APP_DATABASE_PREMIGRATION_ROLE_CHECK_FAILED",
    },
  ];
  for (const scenario of cases) {
    let writes = 0;
    const gate = await inspectApplicationPreMigrationRoleGate(
      scenario.environment,
      targetIdentity,
      operatorUrl,
      scenario.openPool,
    );
    assert.equal(gate.reason, scenario.reason);
    await assert.rejects(
      runAfterCrmPreApplyRoleGate(
        async () => gate,
        async () => {
          writes += 1;
        },
      ),
      new RegExp(scenario.reason),
    );
    assert.equal(writes, 0);
  }
});

test("valid pre-provisioned app login passes the role-only preflight before CRM tables exist", async () => {
  let ended = false;
  const gate = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => ({
      ...poolFor(validIdentityRow()),
      async end() { ended = true; },
    }),
  );
  assert.deepEqual(gate, { status: "ready", reason: null });
  assert.equal(ended, true);
});

test("bad role membership blocks with zero ledger and schema writes", async () => {
  let ledgerWrites = 0;
  let schemaWrites = 0;
  const gate = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => poolFor({
      ...validIdentityRow(),
      direct_memberships: ["aichm_app_runtime", "aichm_crm_owner"],
      owner_group_member: true,
    }),
  );
  await assert.rejects(
    runAfterCrmPreApplyRoleGate(
      async () => gate,
      async () => {
        ledgerWrites += 1;
        schemaWrites += 1;
      },
    ),
    /APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED/,
  );
  assert.equal(ledgerWrites, 0);
  assert.equal(schemaWrites, 0);
});

test("invalid app role attributes block with zero writes, while valid login reaches apply callback", async () => {
  let writes = 0;
  const blockedGate = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => poolFor({ ...validIdentityRow(), login_is_superuser: true }),
  );
  await assert.rejects(
    runAfterCrmPreApplyRoleGate(async () => blockedGate, async () => { writes += 1; }),
    /APP_DATABASE_PREMIGRATION_LOGIN_REJECTED/,
  );
  assert.equal(writes, 0);

  const validGate = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => poolFor(validIdentityRow()),
  );
  const applied = await runAfterCrmPreApplyRoleGate(
    async () => validGate,
    async () => {
      writes += 1;
      return "write callback reached";
    },
  );
  assert.equal(applied, "write callback reached");
  assert.equal(writes, 1);
});
