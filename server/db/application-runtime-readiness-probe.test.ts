import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import {
  probeApplicationRuntimeDatabaseReadiness,
} from "./application-runtime-readiness-probe";
import type { ApplicationRuntimeMode } from "./application-runtime-connection";

const host = "ep-diagnostic-fixture.us-east-1.aws.neon.tech";
const platformUrl = `postgresql://platform_login:platform-only-secret@${host}:5432/neondb?sslmode=require`;
const applicationUrl = `postgresql://application_login:application-only-secret@${host}:5432/neondb?sslmode=require`;
const mode: ApplicationRuntimeMode = {
  kind: "least_privilege",
  connectionString: applicationUrl,
  expectedDatabase: "neondb",
};

function validEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    DATABASE_URL: platformUrl,
    AICHM_APP_DATABASE_URL: applicationUrl,
    ...overrides,
  };
}

function fakeClient(options: {
  schemaMarkers?: boolean;
  tlsActive?: boolean;
  hangOn?: string;
} = {}) {
  const statements: string[] = [];
  let released = false;
  let destroyed = false;
  const client = {
    async query(text: string) {
      statements.push(text);
      if (options.hangOn && text.includes(options.hangOn)) {
        return new Promise(() => undefined);
      }
      if (text.includes("FROM pg_database d")) {
        return { rows: [{
          database_name: "neondb",
          database_oid: "16384",
          is_superuser: false,
          can_login: true,
          can_createdb: false,
          can_createrole: false,
          inherits: true,
          bypass_rls: false,
          in_recovery: false,
          transaction_read_only: true,
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
        }] };
      }
      if (text.includes("current_setting('transaction_read_only')")) {
        return { rows: [{ read_only: "on" }] };
      }
      if (text.includes("pg_stat_ssl")) {
        return { rows: [{ tls_active: options.tlsActive ?? true }] };
      }
      if (text.includes("to_regclass")) {
        return { rows: [{ markers_verified: options.schemaMarkers ?? true }] };
      }
      return { rows: [] };
    },
    release(error?: Error | boolean) {
      released = true;
      destroyed = Boolean(error);
    },
    get released() { return released; },
    get destroyed() { return destroyed; },
    statements,
  };
  return client;
}

function passingVerifier(
  _client: Pick<PoolClient, "query">,
  _runtimeMode: ApplicationRuntimeMode,
  options: { expectedTransactionReadOnly: true },
) {
  assert.equal(options.expectedTransactionReadOnly, true);
  return Promise.resolve({ status: "least_privilege_verified" as const });
}

async function passingGrantVerifier() {}

test("missing or invalid endpoint configuration fails before opening a client", async () => {
  let connections = 0;
  const result = await probeApplicationRuntimeDatabaseReadiness({
    environment: {},
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => { connections += 1; throw new Error("must_not_connect"); },
    verifyRuntime: passingVerifier,
  });
  assert.equal(result.endpointPolicyPassed, false);
  assert.equal(result.runtimeLoginVerified, false);
  assert.equal(result.safeCode, "endpoint_policy_failed");
  assert.equal(connections, 0);

  const tlsMissing = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment({
      DATABASE_URL: platformUrl.replace("?sslmode=require", ""),
    }),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => { connections += 1; throw new Error("must_not_connect"); },
    verifyRuntime: passingVerifier,
  });
  assert.equal(tlsMissing.tlsPolicyPassed, false);
  assert.equal(tlsMissing.safeCode, "tls_policy_failed");
  assert.equal(connections, 0);
});

test("endpoint mismatch blocks before connecting and active TLS is required for managed Neon", async () => {
  let connections = 0;
  const mismatch = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment({
      AICHM_APP_DATABASE_URL: applicationUrl.replace("neondb", "otherdb"),
    }),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => { connections += 1; throw new Error("must_not_connect"); },
    verifyRuntime: passingVerifier,
  });
  assert.equal(mismatch.endpointsMatch, false);
  assert.equal(mismatch.safeCode, "endpoint_mismatch");
  assert.equal(connections, 0);

  const client = fakeClient({ tlsActive: false });
  const noTls = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment(),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => client as unknown as PoolClient,
    verifyRuntime: passingVerifier,
    verifyApprovedGrants: passingGrantVerifier,
  });
  assert.equal(noTls.tlsConnectionRequired, true);
  assert.equal(noTls.tlsActive, false);
  assert.equal(noTls.safeCode, "tls_not_active");
});

test("read-only probe checks TLS, schema markers, runtime role, and approved grants", async () => {
  const client = fakeClient();
  let grantsChecked = false;
  const result = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment(),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => client as unknown as PoolClient,
    verifyApprovedGrants: async (_queryable, schema, migrationSql) => {
      assert.equal(schema, "public");
      assert.equal(migrationSql, "synthetic migration contract");
      grantsChecked = true;
    },
  });
  assert.equal(result.endpointPolicyPassed, true);
  assert.equal(result.tlsPolicyPassed, true);
  assert.equal(result.endpointsMatch, true);
  assert.equal(result.distinctApplicationLogin, true);
  assert.equal(result.tlsConnectionRequired, true);
  assert.equal(result.tlsActive, true);
  assert.equal(result.runtimeLoginVerified, true);
  assert.equal(result.effectiveMinimumGrantsVerified, true);
  assert.equal(result.schemaMarkersVerified, true);
  assert.equal(result.safeCode, "probe_passed");
  assert.equal(grantsChecked, true);
  assert.ok(client.statements.includes("BEGIN READ ONLY"));
  assert.ok(client.statements.some(statement => statement.includes("statement_timeout")));
  assert.ok(client.statements.some(statement => statement.includes("transaction_read_only")));
  assert.ok(client.statements.some(statement => statement.includes("FROM pg_database d")));
  assert.ok(client.statements.includes("ROLLBACK"));
  assert.ok(client.released);
  assert.equal(client.destroyed, false);
  assert.equal(client.statements.some(statement => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(statement)), false);
  assert.equal(client.statements.some(statement => /FROM\s+public\.(admissions_leads|inquiries|lms_users)/i.test(statement)), false);
});

test("wrong runtime role is reported as a safe failure without exposing its name", async () => {
  const client = fakeClient();
  const wrongRole = Object.assign(new Error("aichm_crm_owner private detail"), {
    code: "APP_DATABASE_RUNTIME_IDENTITY_REJECTED",
  });
  const result = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment(),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => client as unknown as PoolClient,
    verifyRuntime: async () => { throw wrongRole; },
  });
  assert.equal(result.runtimeLoginVerified, false);
  assert.equal(result.effectiveMinimumGrantsVerified, false);
  assert.equal(result.safeCode, "runtime_login_not_approved");
  assert.doesNotMatch(JSON.stringify(result), /aichm_crm_owner|private detail/);
});

test("unexpected effective grants fail closed while retaining verified login status", async () => {
  const client = fakeClient();
  const excessiveGrant = Object.assign(new Error("role grant detail"), {
    code: "CRM_RUNTIME_ROLE_PRIVILEGE_CONTRACT_REJECTED",
  });
  const result = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment(),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => client as unknown as PoolClient,
    verifyRuntime: passingVerifier,
    verifyApprovedGrants: async () => { throw excessiveGrant; },
  });
  assert.equal(result.runtimeLoginVerified, true);
  assert.equal(result.effectiveMinimumGrantsVerified, false);
  assert.equal(result.safeCode, "effective_grants_not_approved");
  assert.doesNotMatch(JSON.stringify(result), /role grant detail|CRM_RUNTIME_ROLE/);
});

test("missing schema markers fail closed before the role verifier runs", async () => {
  const client = fakeClient({ schemaMarkers: false });
  let verifierCalled = false;
  const result = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment(),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => client as unknown as PoolClient,
    verifyRuntime: async () => {
      verifierCalled = true;
      return { status: "least_privilege_verified" };
    },
  });
  assert.equal(result.schemaMarkersVerified, false);
  assert.equal(result.safeCode, "schema_markers_missing");
  assert.equal(verifierCalled, false);
});

test("database probe timeouts return a safe category and discard the timed-out client", async () => {
  const client = fakeClient({ hangOn: "pg_stat_ssl" });
  const result = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment(),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    statementTimeoutMs: 250,
    connect: async () => client as unknown as PoolClient,
    verifyApprovedGrants: passingGrantVerifier,
    verifyRuntime: passingVerifier,
  });
  assert.equal(result.safeCode, "probe_timeout");
  assert.equal(result.runtimeLoginVerified, false);
  assert.equal(client.released, true);
  assert.equal(client.destroyed, true);
});

test("probe report contains only sanitized booleans and safe categories", async () => {
  const client = fakeClient();
  const result = await probeApplicationRuntimeDatabaseReadiness({
    environment: validEnvironment(),
    mode,
    runtimeRoleMigrationSql: "synthetic migration contract",
    connect: async () => client as unknown as PoolClient,
    verifyApprovedGrants: passingGrantVerifier,
    verifyRuntime: passingVerifier,
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of [host, "platform_login", "application_login", "platform-only-secret", "application-only-secret", platformUrl, applicationUrl]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.deepEqual(Object.values(result).filter(value => typeof value === "boolean").length, 9);
});
