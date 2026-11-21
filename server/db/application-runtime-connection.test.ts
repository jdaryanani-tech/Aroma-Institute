import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationDatabaseEndpointsMatch,
  APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES,
  APP_DATABASE_URL_ENV,
  buildApplicationPoolConfig,
  classifyApplicationPreMigrationSqlError,
  inspectApplicationDatabaseEndpointPolicy,
  inspectApplicationDatabaseStartupPreflight,
  resolveApplicationRuntimeMode,
  verifyApplicationPreMigrationPool,
  verifyApplicationRuntimePool,
} from "./application-runtime-connection";

const platformUrl = "postgresql://platform_user:platform_pass@db.replit.internal/heliumdb?sslmode=disable";
const appUrl = "postgresql://runtime_user:runtime_pass@db.replit.internal/heliumdb?sslmode=disable";

test("endpoint readiness reports only host-policy and required-TLS booleans", () => {
  const host = "ep-readiness-fixture.us-east-1.aws.neon.tech";
  const platform = `postgresql://fixture-platform:DO_NOT_RETURN_PLATFORM@${host}:5432/neondb?sslmode=require`;
  const app = `postgresql://fixture-app:DO_NOT_RETURN_APP@${host}:5432/neondb?sslmode=require`;

  const result = inspectApplicationDatabaseEndpointPolicy({
    NODE_ENV: "production",
    DATABASE_URL: platform,
    [APP_DATABASE_URL_ENV]: app,
  });

  assert.deepEqual(result, {
    hostPolicySatisfied: true,
    requiredTlsPolicySatisfied: true,
  });
  assert.deepEqual(Object.values(result), [true, true]);
  const serialized = JSON.stringify(result);
  for (const sensitive of [host, "fixture-platform", "fixture-app", "DO_NOT_RETURN"]) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test("endpoint readiness distinguishes an allowed Neon host from missing required TLS mode", () => {
  const host = "ep-readiness-fixture.us-east-1.aws.neon.tech";
  const result = inspectApplicationDatabaseEndpointPolicy({
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://fixture-platform:secret@${host}:5432/neondb?sslmode=require`,
    [APP_DATABASE_URL_ENV]: `postgresql://fixture-app:secret@${host}:5432/neondb`,
  });

  assert.deepEqual(result, {
    hostPolicySatisfied: true,
    requiredTlsPolicySatisfied: false,
  });
});

test("endpoint readiness rejects a disallowed host without exposing its value", () => {
  const forbiddenHost = "public.example.invalid";
  const result = inspectApplicationDatabaseEndpointPolicy({
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://fixture-platform:secret@${forbiddenHost}/neondb?sslmode=require`,
    [APP_DATABASE_URL_ENV]: `postgresql://fixture-app:secret@${forbiddenHost}/neondb?sslmode=require`,
  });

  assert.deepEqual(result, {
    hostPolicySatisfied: false,
    requiredTlsPolicySatisfied: true,
  });
  assert.equal(JSON.stringify(result).includes(forbiddenHost), false);
});

test("endpoint readiness fails closed when either configured endpoint is absent or malformed", () => {
  assert.deepEqual(inspectApplicationDatabaseEndpointPolicy({ NODE_ENV: "production" }), {
    hostPolicySatisfied: false,
    requiredTlsPolicySatisfied: false,
  });
  assert.deepEqual(inspectApplicationDatabaseEndpointPolicy({
    NODE_ENV: "production",
    DATABASE_URL: "not a database URL",
    [APP_DATABASE_URL_ENV]: appUrl,
  }), {
    hostPolicySatisfied: false,
    requiredTlsPolicySatisfied: false,
  });
});

test("startup preflight reports only safe classes and booleans for matching Neon endpoints", () => {
  const host = "ep-preflight-fixture.us-east-1.aws.neon.tech";
  const platform = `postgresql://platform-user:platform-secret@${host}:5432/neondb?sslmode=require&application_name=platform`;
  const app = `postgresql://app-user:app-secret@${host}:5432/neondb?sslmode=require&application_name=platform`;
  const report = inspectApplicationDatabaseStartupPreflight({
    DATABASE_URL: platform,
    [APP_DATABASE_URL_ENV]: app,
  }, { checked: true, passed: true });

  assert.deepEqual(report, {
    platform: {
      configured: true,
      parseable: true,
      hostClassification: "approved_replit_managed_neon",
      hostPolicyPassed: true,
      tlsEnabled: true,
      tlsPolicyPassed: true,
    },
    application: {
      configured: true,
      parseable: true,
      hostClassification: "approved_replit_managed_neon",
      hostPolicyPassed: true,
      tlsEnabled: true,
      tlsPolicyPassed: true,
    },
    endpointDatabaseOptionsMatch: true,
    distinctLoginConfigured: true,
    rolePreflightChecked: true,
    rolePreflightPassed: true,
  });

  const serialized = JSON.stringify(report);
  for (const sensitive of [
    host, "platform-user", "platform-secret", "app-user", "app-secret",
    "application_name",
  ]) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test("startup preflight classifies internal, rejected, and unavailable endpoints safely", () => {
  const internal = "postgresql://platform:platform-secret@helium/heliumdb?sslmode=disable";
  const internalApp = "postgresql://app:app-secret@helium/heliumdb?sslmode=disable";
  const acceptedInternal = inspectApplicationDatabaseStartupPreflight({
    DATABASE_URL: internal,
    [APP_DATABASE_URL_ENV]: internalApp,
  });
  assert.equal(acceptedInternal.platform.hostClassification, "approved_internal_policy");
  assert.equal(acceptedInternal.application.hostClassification, "approved_internal_policy");
  assert.equal(acceptedInternal.endpointDatabaseOptionsMatch, true);
  assert.equal(acceptedInternal.distinctLoginConfigured, true);

  const rejectedHost = "public.invalid.example";
  const rejectedUrl = `postgresql://runtime:secret@${rejectedHost}/heliumdb?sslmode=require`;
  const rejected = inspectApplicationDatabaseStartupPreflight({
    DATABASE_URL: rejectedUrl,
    [APP_DATABASE_URL_ENV]: rejectedUrl,
  });
  assert.equal(rejected.platform.hostClassification, "rejected");
  assert.equal(rejected.platform.hostPolicyPassed, false);
  assert.equal(rejected.endpointDatabaseOptionsMatch, true);

  const missing = inspectApplicationDatabaseStartupPreflight({ NODE_ENV: "production" });
  assert.equal(missing.platform.hostClassification, "unavailable");
  assert.equal(missing.application.hostClassification, "unavailable");
  assert.equal(missing.endpointDatabaseOptionsMatch, false);
  assert.equal(missing.distinctLoginConfigured, false);
  assert.equal(missing.rolePreflightChecked, false);
  assert.equal(missing.rolePreflightPassed, false);

  for (const serialized of [JSON.stringify(rejected), JSON.stringify(missing)]) {
    for (const sensitive of [rejectedHost, "runtime", "secret", "postgresql://"]) {
      assert.equal(serialized.includes(sensitive), false);
    }
  }
});

test("startup preflight distinguishes endpoint, option, login, TLS, and role failures", () => {
  const neon = "ep-preflight-failure.us-east-1.aws.neon.tech";
  const validPlatform = `postgresql://platform:secret@${neon}:5432/neondb?sslmode=require`;
  const cases = [
    {
      name: "missing TLS",
      app: `postgresql://app:secret@${neon}:5432/neondb`,
      match: false,
      distinct: true,
      tls: false,
    },
    {
      name: "different database",
      app: `postgresql://app:secret@${neon}:5432/otherdb?sslmode=require`,
      match: false,
      distinct: true,
      tls: true,
    },
    {
      name: "different options",
      app: `postgresql://app:secret@${neon}:5432/neondb?sslmode=require&application_name=other`,
      match: false,
      distinct: true,
      tls: true,
    },
    {
      name: "same login",
      app: `postgresql://platform:another-secret@${neon}:5432/neondb?sslmode=require`,
      match: true,
      distinct: false,
      tls: true,
    },
  ];

  for (const scenario of cases) {
    const report = inspectApplicationDatabaseStartupPreflight({
      DATABASE_URL: validPlatform,
      [APP_DATABASE_URL_ENV]: scenario.app,
    });
    assert.equal(report.endpointDatabaseOptionsMatch, scenario.match, scenario.name);
    assert.equal(report.distinctLoginConfigured, scenario.distinct, scenario.name);
    assert.equal(report.application.tlsEnabled, scenario.tls, scenario.name);
    assert.equal(report.application.tlsPolicyPassed, scenario.tls, scenario.name);
  }

  const unparseable = inspectApplicationDatabaseStartupPreflight({
    DATABASE_URL: validPlatform,
    [APP_DATABASE_URL_ENV]: "not-a-database-url",
  });
  assert.equal(unparseable.application.parseable, false);
  assert.equal(unparseable.application.hostClassification, "unavailable");
  assert.equal(unparseable.endpointDatabaseOptionsMatch, false);
});

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
      /APP_DATABASE_NEON_SSLMODE_REQUIRED/,
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
      /APP_DATABASE_NEON_SSLMODE_REQUIRED/,
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
      /APP_DATABASE_HOST_POLICY_REJECTED/,
      `host ${host} must be rejected`,
    );
  }
  assert.throws(
    () => resolveApplicationRuntimeMode({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://platform_user:pass@db.replit.internal/heliumdb?sslmode=disable",
      [APP_DATABASE_URL_ENV]: "postgresql://runtime_user:pass@db.neon.tech/heliumdb?sslmode=disable",
    }),
    /APP_DATABASE_HOST_POLICY_REJECTED/,
  );
});

test("endpoint policy failures expose only a safe category code", () => {
  const endpoint = "ep-a1b2c3.us-east-1.aws.neon.tech";
  const platform = `postgresql://platform_user:platform_pass@${endpoint}/neondb?sslmode=require`;
  const cases = [
    {
      app: "postgresql://runtime_user:runtime_pass@public.example/neondb?sslmode=require",
      code: "APP_DATABASE_HOST_POLICY_REJECTED",
    },
    {
      app: `postgresql://runtime_user:runtime_pass@${endpoint}/neondb`,
      code: "APP_DATABASE_NEON_SSLMODE_REQUIRED",
    },
  ] as const;

  for (const { app, code } of cases) {
    let caught: unknown;
    try {
      resolveApplicationRuntimeMode({
        NODE_ENV: "production",
        DATABASE_URL: platform,
        [APP_DATABASE_URL_ENV]: app,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { code?: string }).code, code);
    assert.equal(caught.message, code);
    for (const sensitive of [
      "runtime_user",
      "runtime_pass",
      "public.example",
      endpoint,
      "neondb",
      "sslmode",
    ]) {
      assert.equal(caught.message.includes(sensitive), false);
    }
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
    /APP_DATABASE_HOST_POLICY_REJECTED/,
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
