import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationDatabaseEndpointsMatch,
  APP_DATABASE_URL_ENV,
  buildApplicationPoolConfig,
  resolveApplicationRuntimeMode,
  verifyApplicationPreMigrationPool,
  verifyApplicationRuntimePool,
} from "./application-runtime-connection";

const platformUrl = "postgresql://platform_user:platform_pass@db.replit.internal/heliumdb?sslmode=disable";
const appUrl = "postgresql://runtime_user:runtime_pass@db.replit.internal/heliumdb?sslmode=disable";

test("without the explicit app URL, existing DATABASE_URL behavior is preserved and flagged", async () => {
  const mode = resolveApplicationRuntimeMode({ DATABASE_URL: platformUrl });
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

test("explicit app URL must target the same host, effective port, and database", () => {
  const mode = resolveApplicationRuntimeMode({
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

test("the app host allowlist rejects near-miss, arbitrary, public DNS, and public IP hosts", () => {
  for (const host of ["helium-other", "database", "db.example.com", "8.8.8.8"]) {
    const url = `postgresql://runtime_user:pass@${host}/heliumdb?sslmode=disable`;
    assert.throws(
      () => resolveApplicationRuntimeMode({
        DATABASE_URL: url,
        [APP_DATABASE_URL_ENV]: url,
      }),
      /APP_DATABASE_ENDPOINT_NOT_INTERNAL/,
      `host ${host} must be rejected`,
    );
  }
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
    ["database owner", { database_owner_member: true }, /PREMIGRATION_LOGIN_REJECTED/],
    ["missing app group", { app_group_exists: false }, /PREMIGRATION_GROUP_REJECTED/],
    ["unsafe app group", { app_group_inherits: true }, /PREMIGRATION_GROUP_REJECTED/],
    ["app group in another group", { app_group_has_memberships: true }, /PREMIGRATION_GROUP_REJECTED/],
    ["multiple runtime logins", { app_group_member_count: 2 }, /PREMIGRATION_GROUP_REJECTED/],
    ["membership with admin option", { app_group_admin_option: true }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["owner member", { owner_group_member: true }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["migrator member", { migrator_group_member: true }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["extra direct membership", { direct_memberships: ["aichm_app_runtime", "other_role"] }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["missing app membership", { direct_memberships: [] }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["malformed membership result", { direct_memberships: null }, /PREMIGRATION_MEMBERSHIP_REJECTED/],
    ["missing privilege field", { login_is_superuser: undefined }, /PREMIGRATION_LOGIN_REJECTED/],
    ["missing role identity", { login_role: undefined }, /PREMIGRATION_LOGIN_REJECTED/],
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
      other_group_member: false,
      database_owner_member: false,
      app_group_member: true,
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
    { other_group_member: true },
    { database_owner_member: true },
    { app_group_member: false },
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
            other_group_member: false,
            database_owner_member: false,
            app_group_member: true,
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
            other_group_member: false,
            database_owner_member: false,
            app_group_member: true,
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
