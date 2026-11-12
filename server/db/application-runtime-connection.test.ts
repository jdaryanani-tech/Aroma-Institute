import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_DATABASE_URL_ENV,
  buildApplicationPoolConfig,
  resolveApplicationRuntimeMode,
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
