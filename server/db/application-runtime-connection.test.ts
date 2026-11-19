import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationDatabaseEndpointsMatch,
  APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES,
  APP_DATABASE_URL_ENV,
  buildApplicationPoolConfig,
  classifyApplicationPreMigrationSqlError,
  resolveApplicationRuntimeMode,
  verifyApplicationPreMigrationPool,
  verifyApplicationRuntimePool,
} from "./application-runtime-connection";

const platformUrl = "postgresql://platform_user:platform_pass@db.replit.internal/heliumdb?sslmode=disable";
const appUrl = "postgresql://runtime_user:runtime_pass@db.replit.internal/heliumdb?sslmode=disable";

test("Development without the explicit app URL retains legacy behavior and flags it", async () => {
  const mode = resolveApplicationRuntimeMode({ NODE_ENV: "development", DATABASE_URL: platformUrl });
  assert.deepEqual(mode, { kind: "legacy", connectionString: platformUrl });
  assert.deepEqual(buildApplicationPoolConfig(mode), { connectionString: platformUrl });

  const query = async () => {
    throw new Error("legacy mode must not query a readiness gate");
  };
  const expectedIdentity = { databaseName: "heliumdb", databaseOid: "16384" };
  assert.deepEqual(await verifyApplicationRuntimePool({ query } as never, mode, expectedIdentity), {
    status: "least_privilege_not_enabled",
  });
});

test("Production selects only the explicit app URL after endpoint equality validation", () => {
  const mode = resolveApplicationRuntimeMode({
    NODE_ENV: "production",
    DATABASE_URL: platformUrl,
    [APP_DATABASE_URL_ENV]: appUrl,
  });

  assert.deepEqual(mode, { kind: "least_privilege", connectionString: appUrl, expectedDatabase: "heliumdb" });
  assert.equal(buildApplicationPoolConfig(mode).user, "runtime_user");
});

test("Production fails closed instead of falling back when the app URL is absent", () => {
  assert.throws(
    () => resolveApplicationRuntimeMode({
      NODE_ENV: "production",
      DATABASE_URL: platformUrl,
    }),
    /APP_DATABASE_URL_REQUIRED/,
  );
});

test("Production requires the platform target reference as well as the app login", () => {
  assert.throws(
    () => resolveApplicationRuntimeMode({
      NODE_ENV: "production",
      [APP_DATABASE_URL_ENV]: appUrl,
    }),
    /APP_DATABASE_PLATFORM_REFERENCE_REQUIRED/,
  );
});

test("Production app URL must match the platform database endpoint and transport policy", () => {
  assert.throws(
    () => resolveApplicationRuntimeMode({
      NODE_ENV: "production",
      DATABASE_URL: platformUrl,
      [APP_DATABASE_URL_ENV]: "postgresql://runtime_user:pass@other.replit.internal/heliumdb?sslmode=disable",
    }),
    /APP_DATABASE_ENDPOINT_MISMATCH/,
  );
  assert.throws(
    () => resolveApplicationRuntimeMode({
      NODE_ENV: "production",
      DATABASE_URL: platformUrl,
      [APP_DATABASE_URL_ENV]: "postgresql://runtime_user:runtime_pass@db.replit.internal/heliumdb?sslmode=require",
    }),
    /APP_DATABASE_ENDPOINT_MISMATCH/,
  );
  assert.throws(
    () => resolveApplicationRuntimeMode({
      NODE_ENV: "production",
      DATABASE_URL: platformUrl,
      [APP_DATABASE_URL_ENV]: "postgresql://platform_user:another-password@db.replit.internal/heliumdb?sslmode=disable",
    }),
    /APP_DATABASE_LOGIN_NOT_DISTINCT/,
  );
});

test("test environments retain explicit restricted-mode behavior", () => {
  const mode = resolveApplicationRuntimeMode({
    NODE_ENV: "test",
    DATABASE_URL: platformUrl,
    [APP_DATABASE_URL_ENV]: appUrl,
  });

  assert.equal(mode.kind, "least_privilege");
  assert.equal(mode.connectionString, appUrl);
});

test("explicit app URL must target the same host, effective port, and database", () => {
  const mode = resolveApplicationRuntimeMode({
    NODE_ENV: "development",
    DATABASE_URL: platformUrl,
    [APP_DATABASE_URL_ENV]: appUrl,
  });
  assert.equal(mode.kind, "least_privilege");
  assert.deepEqual(buildApplicationPoolConfig(mode), {
    connectionString: appUrl,
    host: "db.replit.internal",
    port: 5432,
    user: "runtime_user",
    password: "runtime_pass",
    database: "heliumdb",
  });

  const explicitPortMode = resolveApplicationRuntimeMode({
      DATABASE_URL: "postgresql://platform_user:pass@db.replit.internal:5544/heliumdb",
      [APP_DATABASE_URL_ENV]: "postgresql://runtime_user:pass@db.replit.internal:5544/heliumdb",
  });
  assert.equal(buildApplicationPoolConfig(explicitPortMode).port, 5544);
});

test("the exact Replit Helium hostname is allowed with the restricted app URL", () => {
  const mode = resolveApplicationRuntimeMode({
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://platform_user:platform_pass@helium/heliumdb?sslmode=disable",
    [APP_DATABASE_URL_ENV]: "postgresql://runtime_user:runtime_pass@helium/heliumdb?sslmode=disable",
  });
  assert.equal(mode.kind, "least_privilege");
  assert.deepEqual(buildApplicationPoolConfig(mode), {
    connectionString: "postgresql://runtime_user:runtime_pass@helium/heliumdb?sslmode=disable",
    host: "helium",
    port: 5432,
    user: "runtime_user",
    password: "runtime_pass",
    database: "heliumdb",
  });
});

test("Replit-managed legacy Neon endpoints are accepted only with matching TLS-protected URLs", () => {
  const endpoint = "ep-a1b2c3.us-east-1.aws.neon.tech";
  const platform = `postgresql://platform_user:platform_pass@${endpoint}:5432/neondb?sslmode=require`;
  const app = `postgresql://runtime_user:runtime_pass@${endpoint}:5432/neondb?sslmode=require`;
  const mode = resolveApplicationRuntimeMode({
    NODE_ENV: "production",
    DATABASE_URL: platform,
    [APP_DATABASE_URL_ENV]: app,
  });

  assert.deepEqual(mode, {
    kind: "least_privilege",
    connectionString: app,
    expectedDatabase: "neondb",
  });
  assert.equal(applicationDatabaseEndpointsMatch(app, platform), true);

  const mismatches: Array<[string, RegExp]> = [
    [
      `postgresql://runtime_user:runtime_pass@ep-other.us-east-1.aws.neon.tech:5432/neondb?sslmode=require`,
      /APP_DATABASE_ENDPOINT_MISMATCH/,
    ],
    [
      `postgresql://runtime_user:runtime_pass@${endpoint}:5433/neondb?sslmode=require`,
      /APP_DATABASE_ENDPOINT_MISMATCH/,
    ],
    [
      `postgresql://runtime_user:runtime_pass@${endpoint}:5432/otherdb?sslmode=require`,
      /APP_DATABASE_ENDPOINT_MISMATCH/,
    ],
    [
      `postgresql://runtime_user:runtime_pass@${endpoint}:5432/neondb?sslmode=verify-full`,
      /APP_DATABASE_ENDPOINT_NOT_INTERNAL/,
    ],
  ];
  for (const [mismatchedAppUrl, expectedError] of mismatches) {
    assert.throws(
      () => resolveApplicationRuntimeMode({
        NODE_ENV: "production",
        DATABASE_URL: platform,
        [APP_DATABASE_URL_ENV]: mismatchedAppUrl,
      }),
      expectedError,
    );
    assert.equal(applicationDatabaseEndpointsMatch(mismatchedAppUrl, platform), false);
  }
});

test("Replit-managed legacy Neon endpoints require sslmode=require on both URLs", () => {
  const endpoint = "ep-a1b2c3.us-east-1.aws.neon.tech";
  const platform = `postgresql://platform_user:platform_pass@${endpoint}/neondb?sslmode=require`;
  for (const [app, reference] of [
    [
      `postgresql://runtime_user:runtime_pass@${endpoint}/neondb?sslmode=disable`,
      platform,
    ],
    [
      `postgresql://runtime_user:runtime_pass@${endpoint}/neondb`,
      `postgresql://platform_user:platform_pass@${endpoint}/neondb`,
    ],
    [
      `postgresql://runtime_user:runtime_pass@${endpoint}/neondb?sslmode=require&sslmode=require`,
      `postgresql://platform_user:platform_pass@${endpoint}/neondb?sslmode=require&sslmode=require`,
    ],
  ]) {
    assert.throws(
      () => resolveApplicationRuntimeMode({
        NODE_ENV: "production",
        DATABASE_URL: reference,
        [APP_DATABASE_URL_ENV]: app,
      }),
      /APP_DATABASE_ENDPOINT_NOT_INTERNAL/,
    );
    assert.equal(applicationDatabaseEndpointsMatch(app, reference), false);
  }
});

test("the app host allowlist rejects near-miss, arbitrary, public DNS, and public IP hosts", () => {
  for (const host of [
    "helium-other",
    "database",
    "db.example.com",
    "db.neon.tech",
    "ep-a1b2c3.us-east-1.neon.tech",
    "ep-a1b2c3.aws.neon.tech",
    "ep-a1b2c3.extra.us-east-1.aws.neon.tech",
    "8.8.8.8",
  ]) {
    const url = `postgresql://runtime_user:pass@${host}/heliumdb?sslmode=disable`;
    assert.throws(
      () => resolveApplicationRuntimeMode({
        NODE_ENV: "development",
        DATABASE_URL: url,
        [APP_DATABASE_URL_ENV]: url,
      }),
      /APP_DATABASE_ENDPOINT_NOT_INTERNAL/,
      `host ${host} must be rejected`,
    );
  }
  assert.throws(
    () => resolveApplicationRuntimeMode({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://platform_user:pass@db.replit.internal/heliumdb?sslmode=disable",
      [APP_DATABASE_URL_ENV]: "postgresql://runtime_user:pass@db.neon.tech/heliumdb?sslmode=disable",
    }),
    /APP_DATABASE_ENDPOINT_NOT_INTERNAL/,
  );
});

test("preflight endpoint comparison allows a dedicated login but binds transport and database", () => {
  assert.equal(applicationDatabaseEndpointsMatch(
    "postgresql://aichm_login:app_pass@db.replit.internal/heliumdb?sslmode=disable",
    "postgresql://postgres:operator_pass@db.replit.internal:5432/heliumdb?sslmode=disable",
  ), true);
  for (const other of [
    "postgresql://aichm_login:app_pass@other.replit.internal/heliumdb?sslmode=disable",
    "postgresql://aichm_login:app_pass@db.replit.internal:5433/heliumdb?sslmode=disable",
    "postgresql://aichm_login:app_pass@db.replit.internal/otherdb?sslmode=disable",
    "postgresql://aichm_login:app_pass@db.replit.internal/heliumdb?sslmode=require",
  ]) {
    assert.equal(applicationDatabaseEndpointsMatch(
      other,
      "postgresql://postgres:operator_pass@db.replit.internal/heliumdb?sslmode=disable",
    ), false);
  }
});

function validPreMigrationRow() {
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

test("pre-migration app-role verifier accepts only the pinned database and app group login", async () => {
  let queryText = "";
  await verifyApplicationPreMigrationPool({
    async query(sql: string) {
      queryText = sql;
      return { rows: [validPreMigrationRow()] };
    },
  } as never, { databaseName: "heliumdb", databaseOid: "16384" });
  assert.doesNotMatch(queryText, /admissions_lead_assignments|admissions_lead_assignment_history|aichm_assign_crm_lead/);
});

test("pre-migration app-role verifier fails closed for database, login, group, and membership drift", async () => {
  const invalidCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["database OID", { database_oid: "16395" }, /PREMIGRATION_IDENTITY_MISMATCH/],
    ["recovery", { in_recovery: true }, /PREMIGRATION_IDENTITY_MISMATCH/],
    ["read-only default", { transaction_read_only: true }, /PREMIGRATION_IDENTITY_MISMATCH/],
    ["superuser", { login_is_superuser: true }, /PREMIGRATION_LOGIN_REJECTED/],
    ["non-login actor", { login_can_login: false }, /PREMIGRATION_LOGIN_REJECTED/],
    ["database owner", { not_database_owner: false }, /PREMIGRATION_LOGIN_REJECTED/],
    ["missing app group", { app_group_exists: false }, /PREMIGRATION_GROUP_REJECTED/],
    ["unsafe app group", { app_group_inherits: true }, /PREMIGRATION_GROUP_REJECTED/],
    ["app group in another group", { app_group_has_memberships: true }, /PREMIGRATION_GROUP_REJECTED/],
    ["multiple runtime logins", { app_group_member_count: 2 }, /PREMIGRATION_GROUP_REJECTED/],
    ["membership with admin option", { app_group_no_admin_option: false }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["owner or migrator member", { no_owner_or_migrator_membership: false }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["extra direct membership", { no_memberships_outside_app_group: false }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["missing app membership", { app_group_is_member: false }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["missing privilege field", { login_is_superuser: undefined }, /PREMIGRATION_LOGIN_REJECTED/],
    ["missing role identity", { login_role_exists: undefined }, /PREMIGRATION_LOGIN_REJECTED/],
  ];
  for (const [label, changes, expected] of invalidCases) {
    await assert.rejects(
      verifyApplicationPreMigrationPool({
        async query() {
          return { rows: [{ ...validPreMigrationRow(), ...changes }] };
        },
      } as never, { databaseName: "heliumdb", databaseOid: "16384" }),
      error => {
        assert.match((error as Error).message, expected, label);
        return true;
      },
    );
  }
});

test("pre-migration SQLSTATE classifier maps only the approved categories", () => {
  const expected = [
    ["28P01", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.invalidPassword],
    ["28000", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.authorizationFailed],
    ["42501", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.insufficientPrivilege],
    ["3D000", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.invalidDatabase],
    ["08000", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed],
    ["08001", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed],
    ["08003", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed],
    ["08004", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed],
    ["08006", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed],
    ["08007", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed],
    ["08P01", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed],
    ["42601", APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.databaseQueryFailed],
  ] as const;
  for (const [sqlState, category] of expected) {
    assert.equal(classifyApplicationPreMigrationSqlError({ code: sqlState }), category, sqlState);
  }
  assert.equal(
    classifyApplicationPreMigrationSqlError({ code: "ECONNREFUSED" }),
    APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionOrQueryFailed,
  );
  assert.equal(
    classifyApplicationPreMigrationSqlError(new Error("sensitive content")),
    APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionOrQueryFailed,
  );
  assert.equal(
    classifyApplicationPreMigrationSqlError({
      code: "XX000",
      message: "postgres://username:password@private-host/db?token=secret",
    }),
    APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.databaseQueryFailed,
  );
});

test("an invalid explicit app URL fails closed instead of falling back", () => {
  for (const explicit of [
    "",
    "not a URL",
    "postgresql://runtime_user:pass@other.replit.internal/heliumdb",
    "postgresql://runtime_user:pass@db.replit.internal:5433/heliumdb",
    "postgresql://runtime_user:pass@db.replit.internal:70000/heliumdb",
    "postgresql://runtime_user:pass@db.replit.internal/otherdb",
    "postgresql://runtime_user:pass@db.replit.internal/heliumdb?sslmode=require",
    "postgresql://runtime_user:pass@db.replit.internal/heliumdb?host=other.example",
    "postgresql://runtime_user:pass@db.replit.internal/heliumdb#fragment",
  ]) {
    assert.throws(
      () => resolveApplicationRuntimeMode({
        DATABASE_URL: platformUrl,
        [APP_DATABASE_URL_ENV]: explicit,
      }),
      /APP_DATABASE_URL_INVALID|APP_DATABASE_ENDPOINT_MISMATCH/,
    );
  }
  assert.throws(() => resolveApplicationRuntimeMode({
    [APP_DATABASE_URL_ENV]: appUrl,
  }), /APP_DATABASE_PLATFORM_REFERENCE_REQUIRED/);
  assert.throws(
    () => resolveApplicationRuntimeMode({
      DATABASE_URL: "postgresql://platform_user:pass@db.neon.tech/heliumdb?sslmode=disable",
      [APP_DATABASE_URL_ENV]: "postgresql://runtime_user:pass@db.neon.tech/heliumdb?sslmode=disable",
    }),
    /APP_DATABASE_ENDPOINT_NOT_INTERNAL/,
  );
});

test("explicit app mode requires the app group, a login, and a non-superuser role", async () => {
  const mode = resolveApplicationRuntimeMode({
    DATABASE_URL: platformUrl,
    [APP_DATABASE_URL_ENV]: appUrl,
  });
  const query = async () => ({
    rows: [{
      database_name: "heliumdb",
      database_oid: "16384",
      is_superuser: false,
      can_login: true,
      can_createdb: false,
      can_createrole: false,
      inherits: true,
      bypass_rls: false,
      in_recovery: false,
      transaction_read_only: false,
      other_group_member: false,
      database_owner_member: false,
      app_group_member: true,
      app_group_exists: true,
      app_group_can_login: false,
      app_group_is_superuser: false,
      app_group_can_createdb: false,
      app_group_can_createrole: false,
      app_group_inherits: false,
      app_group_bypasses_rls: false,
      app_group_has_parent_membership: false,
      app_group_member_count: 1,
      app_group_membership_admin_option: false,
      owner_group_member: false,
      migrator_group_member: false,
      core_privileges_ok: true,
      crm_assignment_read_only_ok: true,
      assignment_function_execute: true,
      schema_create: false,
    }],
  });
  const expectedIdentity = { databaseName: "heliumdb", databaseOid: "16384" };
  assert.deepEqual(await verifyApplicationRuntimePool({ query } as never, mode, expectedIdentity), {
    status: "least_privilege_verified",
  });

  for (const changed of [
    { is_superuser: true },
    { can_login: false },
    { can_createdb: true },
    { can_createrole: true },
    { inherits: false },
    { bypass_rls: true },
    { in_recovery: true },
    { transaction_read_only: true },
    { other_group_member: true },
    { database_owner_member: true },
    { app_group_member: false },
    { app_group_exists: false },
    { app_group_can_login: true },
    { app_group_is_superuser: true },
    { app_group_can_createdb: true },
    { app_group_can_createrole: true },
    { app_group_inherits: true },
    { app_group_bypasses_rls: true },
    { app_group_has_parent_membership: true },
    { app_group_member_count: 2 },
    { app_group_membership_admin_option: true },
    { owner_group_member: true },
    { migrator_group_member: true },
    { database_name: "neondb" },
    { database_oid: "16395" },
  ]) {
    await assert.rejects(
      verifyApplicationRuntimePool({
        query: async () => ({
          rows: [{
            database_name: "heliumdb",
            database_oid: "16384",
            is_superuser: false,
            can_login: true,
            can_createdb: false,
            can_createrole: false,
            inherits: true,
            bypass_rls: false,
            in_recovery: false,
            transaction_read_only: false,
            other_group_member: false,
            database_owner_member: false,
            app_group_member: true,
            app_group_exists: true,
            app_group_can_login: false,
            app_group_is_superuser: false,
            app_group_can_createdb: false,
            app_group_can_createrole: false,
            app_group_inherits: false,
            app_group_bypasses_rls: false,
            app_group_has_parent_membership: false,
            app_group_member_count: 1,
            app_group_membership_admin_option: false,
            owner_group_member: false,
            migrator_group_member: false,
            core_privileges_ok: true,
            crm_assignment_read_only_ok: true,
            assignment_function_execute: true,
            schema_create: false,
            ...changed,
          }],
        }),
      } as never, mode, expectedIdentity),
      /APP_DATABASE_RUNTIME_IDENTITY_REJECTED/,
    );
  }
  for (const changed of [
    { core_privileges_ok: false },
    { crm_assignment_read_only_ok: false },
    { assignment_function_execute: false },
    { schema_create: true },
  ]) {
    await assert.rejects(
      verifyApplicationRuntimePool({
        query: async () => ({
          rows: [{
            database_name: "heliumdb",
            database_oid: "16384",
            is_superuser: false,
            can_login: true,
            can_createdb: false,
            can_createrole: false,
            inherits: true,
            bypass_rls: false,
            in_recovery: false,
            transaction_read_only: false,
            other_group_member: false,
            database_owner_member: false,
            app_group_member: true,
            app_group_exists: true,
            app_group_can_login: false,
            app_group_is_superuser: false,
            app_group_can_createdb: false,
            app_group_can_createrole: false,
            app_group_inherits: false,
            app_group_bypasses_rls: false,
            app_group_has_parent_membership: false,
            app_group_member_count: 1,
            app_group_membership_admin_option: false,
            owner_group_member: false,
            migrator_group_member: false,
            core_privileges_ok: true,
            crm_assignment_read_only_ok: true,
            assignment_function_execute: true,
            schema_create: false,
            ...changed,
          }],
        }),
      } as never, mode, expectedIdentity),
      /APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY/,
    );
  }
});
