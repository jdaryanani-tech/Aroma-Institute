import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES,
  APPLICATION_PRE_MIGRATION_STAGE_CODES,
} from "./application-runtime-connection";
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
    in_recovery: false,
    transaction_read_only: false,
    login_role_exists: true,
    is_operator_user: false,
    login_can_login: true,
    login_is_superuser: false,
    login_can_createdb: false,
    login_can_createrole: false,
    login_inherits: true,
    login_bypasses_rls: false,
    not_database_owner: true,
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
    app_group_no_admin_option: true,
    no_memberships_outside_app_group: true,
    no_owner_or_migrator_membership: true,
  };
}

function poolFor(row: Record<string, unknown>) {
  return {
    async connect() {
      return {
        async query() {
          return { rows: [row] };
        },
        release() {},
      };
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
  assert.equal(gate.status, "blocked");
  assert.equal(gate.reason, "APP_DATABASE_URL_NOT_CONFIGURED");
  assert.equal(gate.diagnostics?.endpointMatches, false);
  assert.equal(gate.diagnostics?.pinnedDevelopmentIdentityMatches, true);
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
    assert.equal(gate.diagnostics?.endpointMatches, false);
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
        return {
          async connect() { throw error; },
          async end() {},
        };
      },
      reason: "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE",
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
    assert.ok(gate.diagnostics);
    assert.equal(
      gate.diagnostics.endpointMatches,
      scenario.reason === "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE",
    );
    assert.equal(gate.diagnostics.loginRoleExists, false);
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
  assert.equal(gate.status, "ready");
  assert.equal(gate.reason, null);
  assert.ok(gate.diagnostics);
  assert.ok(Object.values(gate.diagnostics).every(value => value === true));
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
      no_memberships_outside_app_group: false,
      no_owner_or_migrator_membership: false,
    }),
  );
  assert.equal(gate.diagnostics?.noMembershipsOutsideAichmAppRuntime, false);
  assert.equal(gate.diagnostics?.noAichmCrmOwnerOrMigratorMembership, false);
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

test("preflight diagnostics identify each failed login, membership, group, endpoint, and identity check", async () => {
  const cases: Array<{
    label: string;
    row: Record<string, unknown>;
    field: keyof NonNullable<Awaited<ReturnType<typeof inspectApplicationPreMigrationRoleGate>>["diagnostics"]>;
  }> = [
    { label: "login role missing", row: { login_role_exists: false }, field: "loginRoleExists" },
    { label: "LOGIN disabled", row: { login_can_login: false }, field: "login" },
    { label: "superuser", row: { login_is_superuser: true }, field: "noSuperuser" },
    { label: "createdb", row: { login_can_createdb: true }, field: "noCreatedb" },
    { label: "createrole", row: { login_can_createrole: true }, field: "noCreaterole" },
    { label: "no inherit", row: { login_inherits: false }, field: "inherit" },
    { label: "bypass RLS", row: { login_bypasses_rls: true }, field: "noBypassRls" },
    { label: "operator user", row: { is_operator_user: true }, field: "notOperatorUser" },
    { label: "database owner", row: { not_database_owner: false }, field: "notDatabaseOwner" },
    { label: "not an app-group member", row: { app_group_is_member: false }, field: "memberInAichmAppRuntime" },
    { label: "admin option", row: { app_group_no_admin_option: false }, field: "appRuntimeMembershipNoAdminOption" },
    { label: "extra membership", row: { no_memberships_outside_app_group: false }, field: "noMembershipsOutsideAichmAppRuntime" },
    { label: "owner or migrator membership", row: { no_owner_or_migrator_membership: false }, field: "noAichmCrmOwnerOrMigratorMembership" },
    { label: "group missing", row: { app_group_exists: false }, field: "appRuntimeGroupExists" },
    { label: "group login enabled", row: { app_group_can_login: true }, field: "appRuntimeGroupNoLogin" },
    { label: "group superuser", row: { app_group_is_superuser: true }, field: "appRuntimeGroupNoSuperuser" },
    { label: "group createdb", row: { app_group_can_createdb: true }, field: "appRuntimeGroupNoCreatedb" },
    { label: "group createrole", row: { app_group_can_createrole: true }, field: "appRuntimeGroupNoCreaterole" },
    { label: "group inherits", row: { app_group_inherits: true }, field: "appRuntimeGroupNoInherit" },
    { label: "group bypass RLS", row: { app_group_bypasses_rls: true }, field: "appRuntimeGroupNoBypassRls" },
    { label: "group has parent membership", row: { app_group_has_memberships: true }, field: "appRuntimeGroupHasNoParentMembership" },
    { label: "group has more than one login", row: { app_group_member_count: 2 }, field: "appRuntimeGroupHasOnlyCandidateLogin" },
    { label: "candidate database mismatch", row: { database_oid: "16395" }, field: "candidateDatabaseIdentityMatches" },
  ];

  for (const scenario of cases) {
    const gate = await inspectApplicationPreMigrationRoleGate(
      baseEnvironment,
      targetIdentity,
      operatorUrl,
      () => poolFor({ ...validIdentityRow(), ...scenario.row }),
    );
    assert.equal(gate.status, "blocked", scenario.label);
    assert.equal(gate.diagnostics?.[scenario.field], false, scenario.label);
    assert.equal(gate.diagnostics?.endpointMatches, true, scenario.label);
  }

  const endpointBlocked = await inspectApplicationPreMigrationRoleGate(
    {
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      AICHM_APP_DATABASE_URL: "postgresql://app-role:app-pass@other.replit.internal/heliumdb?sslmode=disable",
    },
    targetIdentity,
    operatorUrl,
    () => {
      throw new Error("candidate pool must not open");
    },
  );
  assert.equal(endpointBlocked.diagnostics?.endpointMatches, false);

  const identityBlocked = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    { ...targetIdentity, systemIdentifier: "wrong-system" },
    operatorUrl,
    () => {
      throw new Error("candidate pool must not open");
    },
  );
  assert.equal(identityBlocked.diagnostics?.pinnedDevelopmentIdentityMatches, false);
  assert.equal(identityBlocked.diagnostics?.endpointMatches, false);
});

test("preflight diagnostics expose booleans only and never serialize role or connection details", async () => {
  let queryText = "";
  const gate = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => ({
      async connect() {
        return {
          async query(sql: string) {
            queryText = sql;
            return {
              rows: [{
                ...validIdentityRow(),
                no_memberships_outside_app_group: false,
                private_membership_marker: "unrelated_role_name_must_not_escape",
              }],
            };
          },
          release() {},
        };
      },
      async end() {},
    }),
  );

  const serialized = JSON.stringify(gate);
  for (const forbidden of [
    "platform-pass",
    "app-pass",
    "operator-pass",
    "app-role",
    "db.replit.internal",
    "unrelated_role_name_must_not_escape",
    "direct_memberships",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(queryText.trimStart(), /^SELECT\b/);
  assert.doesNotMatch(queryText, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
  assert.doesNotMatch(queryText, /array_agg|direct_memberships/);
  assert.equal(gate.diagnostics?.noMembershipsOutsideAichmAppRuntime, false);
});

test("candidate pool connection errors emit only stage and allowlisted category", async () => {
  const error = new Error(
    "postgres://sensitive-user:sensitive-password@private-host/private-db?token=private-token",
  ) as Error & { code: string };
  error.code = "28P01";
  const gate = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => ({
      async connect() { throw error; },
      async end() {},
    }),
  );

  assert.equal(gate.status, "blocked");
  assert.equal(gate.reason, "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE");
  assert.deepEqual(gate.failureDiagnostic, {
    stageCode: APPLICATION_PRE_MIGRATION_STAGE_CODES.candidatePoolConnection,
    categoryCode: APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.invalidPassword,
  });
  const serialized = JSON.stringify(gate);
  for (const forbidden of [
    error.message,
    "sensitive-user",
    "sensitive-password",
    "private-host",
    "private-db",
    "private-token",
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("candidate identity SELECT errors report safe SQLSTATE categories and stage", async () => {
  const error = new Error(
    "permission denied at postgres://user:pass@host/db?secret=never-log",
  ) as Error & { code: string };
  error.code = "42501";
  const gate = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => ({
      async connect() {
        return {
          async query() { throw error; },
          release() {},
        };
      },
      async end() {},
    }),
  );

  assert.equal(gate.status, "blocked");
  assert.equal(gate.reason, "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE");
  assert.deepEqual(gate.failureDiagnostic, {
    stageCode: APPLICATION_PRE_MIGRATION_STAGE_CODES.identityReadinessSelect,
    categoryCode: APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.insufficientPrivilege,
  });
  assert.equal(gate.diagnostics?.roleMetadataRead, false);
  assert.equal(JSON.stringify(gate).includes(error.message), false);
  assert.equal(JSON.stringify(gate).includes("never-log"), false);
});

test("candidate query errors without SQLSTATE remain generic and role failures identify validation stage", async () => {
  const connectionError = new Error("sensitive text must never escape");
  const queryFailure = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => ({
      async connect() {
        return {
          async query() { throw connectionError; },
          release() {},
        };
      },
      async end() {},
    }),
  );
  assert.deepEqual(queryFailure.failureDiagnostic, {
    stageCode: APPLICATION_PRE_MIGRATION_STAGE_CODES.identityReadinessSelect,
    categoryCode: APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionOrQueryFailed,
  });
  assert.equal(JSON.stringify(queryFailure).includes(connectionError.message), false);

  const roleFailure = await inspectApplicationPreMigrationRoleGate(
    baseEnvironment,
    targetIdentity,
    operatorUrl,
    () => poolFor({ ...validIdentityRow(), login_is_superuser: true }),
  );
  assert.deepEqual(roleFailure.failureDiagnostic, {
    stageCode: APPLICATION_PRE_MIGRATION_STAGE_CODES.roleMetadataValidation,
    categoryCode: APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.roleValidationFailed,
  });
  assert.equal(roleFailure.diagnostics?.noSuperuser, false);
});
