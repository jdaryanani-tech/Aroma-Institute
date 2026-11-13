import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CRM_APP_ROLE_APPLY_FLAG,
  CRM_APP_ROLE_CONFIRM_ENV,
  CRM_APP_ROLE_CONFIRM_VALUE,
  CRM_APP_ROLE_STAGE_CODES,
  formatCrmAppRoleFailureDiagnostic,
  isStrongAlphanumericAppRolePassword,
  parseCrmAppRoleProvisionMode,
  planCrmAppRoleProvisioning,
  runCrmAppRoleProvisioning,
  summarizeCrmAppRolePasswordReadiness,
  summarizeCrmAppRolePreviewDiagnostics,
  selectCrmAppRoleFailure,
  sanitizedCrmAppRoleErrorCode,
  validateCrmAppRoleProvisioningState,
  type CrmAppRoleProvisioningState,
} from "./crm-app-role-provisioning";

const password = `AichmRole9${"k".repeat(24)}`;
const pinnedIdentity = {
  database_name: "heliumdb",
  database_oid: "16384",
  database_user: "postgres",
  system_identifier: "7609038573599248406",
  in_recovery: false,
  default_transaction_read_only: false,
};

function emptyState(): CrmAppRoleProvisioningState {
  return {
    runtimeGroup: null,
    appLogin: null,
    loginMemberships: [],
    runtimeGroupMembers: [],
    runtimeGroupParents: [],
    loginOwnsDatabase: false,
    loginIsOwnerMember: false,
    loginIsMigratorMember: false,
  };
}

function groupAttributes(overrides: Partial<NonNullable<CrmAppRoleProvisioningState["runtimeGroup"]>> = {}) {
  return {
    canLogin: false,
    superuser: false,
    canCreateDb: false,
    canCreateRole: false,
    inherit: false,
    bypassRls: false,
    replication: false,
    ...overrides,
  };
}

function loginAttributes(overrides: Partial<NonNullable<CrmAppRoleProvisioningState["appLogin"]>> = {}) {
  return {
    canLogin: true,
    superuser: false,
    canCreateDb: false,
    canCreateRole: false,
    inherit: true,
    bypassRls: false,
    replication: false,
    ...overrides,
  };
}

function existingValidState(): CrmAppRoleProvisioningState {
  const membership = {
    memberRole: "aichm_app_login",
    grantedRole: "aichm_app_runtime",
    adminOption: false,
  };
  return {
    runtimeGroup: groupAttributes(),
    appLogin: loginAttributes(),
    loginMemberships: [membership],
    runtimeGroupMembers: [membership],
    runtimeGroupParents: [],
    loginOwnsDatabase: false,
    loginIsOwnerMember: false,
    loginIsMigratorMember: false,
  };
}

function createMockClient(
  initialState: CrmAppRoleProvisioningState,
  identity: typeof pinnedIdentity = pinnedIdentity,
  failQuery?: (text: string) => unknown,
) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const state = structuredClone(initialState);
  return {
    calls,
    state,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const injectedFailure = failQuery?.(text);
      if (injectedFailure) throw injectedFailure;
      if (text.includes("SELECT current_database() AS database_name")) {
        return { rows: [identity] };
      }
      if (text.includes("FROM pg_roles") && text.includes("WHERE rolname=ANY")) {
        const rows = [];
        if (state.runtimeGroup) rows.push({
          rolname: "aichm_app_runtime",
          rolcanlogin: state.runtimeGroup.canLogin,
          rolsuper: state.runtimeGroup.superuser,
          rolcreatedb: state.runtimeGroup.canCreateDb,
          rolcreaterole: state.runtimeGroup.canCreateRole,
          rolinherit: state.runtimeGroup.inherit,
          rolbypassrls: state.runtimeGroup.bypassRls,
          rolreplication: state.runtimeGroup.replication,
        });
        if (state.appLogin) rows.push({
          rolname: "aichm_app_login",
          rolcanlogin: state.appLogin.canLogin,
          rolsuper: state.appLogin.superuser,
          rolcreatedb: state.appLogin.canCreateDb,
          rolcreaterole: state.appLogin.canCreateRole,
          rolinherit: state.appLogin.inherit,
          rolbypassrls: state.appLogin.bypassRls,
          rolreplication: state.appLogin.replication,
        });
        return { rows };
      }
      if (text.includes("FROM pg_auth_members membership")) {
        const rows = [
          ...state.loginMemberships,
          ...state.runtimeGroupMembers,
          ...state.runtimeGroupParents,
        ].filter((item, index, all) =>
          all.findIndex(other =>
            other.memberRole === item.memberRole && other.grantedRole === item.grantedRole,
          ) === index,
        ).map(item => ({
          member_role: item.memberRole,
          granted_role: item.grantedRole,
          admin_option: item.adminOption,
        }));
        return { rows };
      }
      if (text.includes("AS login_owns_database")) {
        return { rows: [{
          login_owns_database: state.loginOwnsDatabase,
          login_is_owner_member: state.loginIsOwnerMember,
          login_is_migrator_member: state.loginIsMigratorMember,
        }] };
      }
      if (text.startsWith("CREATE ROLE aichm_app_runtime")) {
        state.runtimeGroup = groupAttributes();
        return { rows: [] };
      }
      if (text.startsWith("CREATE ROLE aichm_app_login")) {
        state.appLogin = loginAttributes();
        return { rows: [] };
      }
      if (text.startsWith("GRANT aichm_app_runtime TO aichm_app_login")) {
        const membership = {
          memberRole: "aichm_app_login",
          grantedRole: "aichm_app_runtime",
          adminOption: false,
        };
        state.loginMemberships = [membership];
        state.runtimeGroupMembers = [membership];
        return { rows: [] };
      }
      if (text.includes("set_config('aichm.crm_app_role_password'")) {
        return { rows: [{ configured: Array.isArray(values) && values.length === 1 }] };
      }
      if (text.includes("DO $aichm_password$")) return { rows: [] };
      if (
        text.startsWith("SET LOCAL ") ||
        text === "BEGIN" ||
        text === "BEGIN READ ONLY" ||
        text === "COMMIT" ||
        text === "ROLLBACK" ||
        text.includes("pg_advisory_xact_lock")
      ) return { rows: [] };
      throw new Error("Unexpected mocked query");
    },
  };
}

test("preview is the default and apply requires its flag plus exact confirmation", () => {
  assert.equal(parseCrmAppRoleProvisionMode([], {}), "preview");
  assert.equal(parseCrmAppRoleProvisionMode(["--preview"], {}), "preview");
  assert.throws(
    () => parseCrmAppRoleProvisionMode([CRM_APP_ROLE_APPLY_FLAG], {}),
    /CRM_APP_ROLE_EXPLICIT_CONFIRMATION_REQUIRED/,
  );
  assert.equal(parseCrmAppRoleProvisionMode(
    [CRM_APP_ROLE_APPLY_FLAG],
    { [CRM_APP_ROLE_CONFIRM_ENV]: CRM_APP_ROLE_CONFIRM_VALUE },
  ), "apply");
  assert.throws(
    () => parseCrmAppRoleProvisionMode([CRM_APP_ROLE_APPLY_FLAG, password], {
      [CRM_APP_ROLE_CONFIRM_ENV]: CRM_APP_ROLE_CONFIRM_VALUE,
    }),
    /CRM_APP_ROLE_ARGUMENTS_REJECTED/,
  );
});

test("only strong alphanumeric password secret values are accepted", () => {
  assert.equal(isStrongAlphanumericAppRolePassword(password), true);
  assert.equal(isStrongAlphanumericAppRolePassword("shortA1"), false);
  assert.equal(isStrongAlphanumericAppRolePassword(`NoDigits${"a".repeat(30)}`), false);
  assert.equal(isStrongAlphanumericAppRolePassword(`noupper1${"a".repeat(28)}`), false);
  assert.equal(isStrongAlphanumericAppRolePassword(`NOLOWER1${"A".repeat(28)}`), false);
  assert.equal(isStrongAlphanumericAppRolePassword(`${password}!`), false);
});

test("password readiness reports safe booleans for format edge cases", () => {
  const emptyReadiness = {
    passwordSecretPresent: false,
    passwordIsString: false,
    lengthAccepted: false,
    hasWhitespace: false,
    asciiAlphanumericOnly: false,
    hasNonAscii: false,
    hasControlCharacter: false,
    hasLowercase: false,
    hasUppercase: false,
    hasDigit: false,
    overallFormatValid: false,
  };
  const cases: Array<{
    name: string;
    input: unknown;
    expected: ReturnType<typeof summarizeCrmAppRolePasswordReadiness>;
  }> = [
    { name: "missing value", input: undefined, expected: emptyReadiness },
    {
      name: "non-string value",
      input: 734921,
      expected: { ...emptyReadiness, passwordSecretPresent: true },
    },
    {
      name: "too short",
      input: "ShortSecretCanaryA1",
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        asciiAlphanumericOnly: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "too long",
      input: `Aa1${"longcanary".repeat(13)}`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        asciiAlphanumericOnly: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "punctuation",
      input: `Aa1!${"canary".repeat(5)}`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        asciiAlphanumericOnly: false,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "leading whitespace",
      input: ` ${password}`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        hasWhitespace: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "trailing whitespace",
      input: `${password} `,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        hasWhitespace: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "embedded whitespace",
      input: `${password.slice(0, 10)} ${password.slice(10)}`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        hasWhitespace: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "embedded newline",
      input: `${password.slice(0, 10)}\n${password.slice(10)}`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        hasWhitespace: true,
        asciiAlphanumericOnly: false,
        hasControlCharacter: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "trailing newline is rejected",
      input: `${password}\n`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        hasWhitespace: true,
        asciiAlphanumericOnly: false,
        hasControlCharacter: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "unicode letter",
      input: `${password}é`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        asciiAlphanumericOnly: false,
        hasNonAscii: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "unicode digit",
      input: `${password}１`,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        asciiAlphanumericOnly: false,
        hasNonAscii: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
      },
    },
    {
      name: "valid ASCII alphanumeric value",
      input: password,
      expected: {
        ...emptyReadiness,
        passwordSecretPresent: true,
        passwordIsString: true,
        lengthAccepted: true,
        asciiAlphanumericOnly: true,
        hasLowercase: true,
        hasUppercase: true,
        hasDigit: true,
        overallFormatValid: true,
      },
    },
  ];

  for (const { name, input, expected } of cases) {
    const readiness = summarizeCrmAppRolePasswordReadiness(input);
    assert.deepEqual(readiness, expected, name);
    if (typeof input === "string") {
      assert.equal(JSON.stringify(readiness).includes(input), false, `${name} output redaction`);
    } else if (input !== undefined) {
      assert.equal(JSON.stringify(readiness).includes(String(input)), false, `${name} output redaction`);
    }
  }
});

test("preview diagnostics compare app credentials with pg URL-decoding semantics and redact inputs", () => {
  const runtimeUrl = "postgresql://runtime-user:RuntimeFixture9@helium/heliumdb?sslmode=disable";
  const appUrlFor = (encodedPassword: string, username = "aichm_app_login") =>
    `postgresql://${encodeURIComponent(username)}:${encodedPassword}@helium/heliumdb?sslmode=disable`;
  const encodedAppUrl = appUrlFor(`%41${password.slice(1)}`);
  const diagnostics = summarizeCrmAppRolePreviewDiagnostics({
    rolePassword: password,
    appDatabaseUrl: encodedAppUrl,
    runtimeDatabaseUrl: runtimeUrl,
  });

  assert.deepEqual(diagnostics, {
    ...summarizeCrmAppRolePasswordReadiness(password),
    appUrlSecretPresent: true,
    appUrlParses: true,
    appUrlUsernameIsExpected: true,
    appUrlPasswordMatchesRoleSecret: true,
    appUrlEndpointMatchesRuntime: true,
    appUrlDatabaseIsExpected: true,
  });
  const serialized = JSON.stringify(diagnostics);
  for (const privateInput of [password, encodedAppUrl, runtimeUrl]) {
    assert.equal(serialized.includes(privateInput), false);
  }
});

test("preview diagnostics identify password and endpoint mismatches without exposing inputs", () => {
  const otherPassword = `DifferentRole8${"m".repeat(22)}`;
  const runtimeUrl = "postgresql://runtime-user:RuntimeFixture9@helium/heliumdb?sslmode=disable";
  const appUrl = `postgresql://aichm_app_login:${otherPassword}@helium/heliumdb?sslmode=disable`;
  const mismatchedEndpointUrl =
    `postgresql://aichm_app_login:${otherPassword}@public.example/heliumdb?sslmode=disable`;
  const diagnostics = summarizeCrmAppRolePreviewDiagnostics({
    rolePassword: password,
    appDatabaseUrl: appUrl,
    runtimeDatabaseUrl: runtimeUrl,
  });
  const endpointMismatch = summarizeCrmAppRolePreviewDiagnostics({
    rolePassword: password,
    appDatabaseUrl: mismatchedEndpointUrl,
    runtimeDatabaseUrl: runtimeUrl,
  });

  assert.equal(diagnostics.appUrlParses, true);
  assert.equal(diagnostics.appUrlPasswordMatchesRoleSecret, false);
  assert.equal(diagnostics.appUrlEndpointMatchesRuntime, true);
  assert.equal(endpointMismatch.appUrlPasswordMatchesRoleSecret, false);
  assert.equal(endpointMismatch.appUrlEndpointMatchesRuntime, false);
  for (const result of [diagnostics, endpointMismatch]) {
    const serialized = JSON.stringify(result);
    for (const privateInput of [password, otherPassword, appUrl, mismatchedEndpointUrl, runtimeUrl]) {
      assert.equal(serialized.includes(privateInput), false);
    }
  }
});

test("role validation accepts only exact restrictive attributes and memberships", () => {
  assert.doesNotThrow(() => validateCrmAppRoleProvisioningState(existingValidState()));
  for (const state of [
    { ...emptyState(), runtimeGroup: groupAttributes({ canLogin: true }) },
    { ...emptyState(), runtimeGroup: groupAttributes({ superuser: true }) },
    { ...emptyState(), runtimeGroup: groupAttributes({ replication: true }) },
    { ...emptyState(), appLogin: loginAttributes({ superuser: true }) },
    { ...emptyState(), appLogin: loginAttributes({ canCreateRole: true }) },
    { ...existingValidState(), appLogin: loginAttributes({ inherit: false }) },
    { ...existingValidState(), appLogin: loginAttributes({ bypassRls: true }) },
    { ...existingValidState(), appLogin: loginAttributes({ replication: true }) },
  ]) {
    assert.throws(() => validateCrmAppRoleProvisioningState(state as CrmAppRoleProvisioningState));
  }
});

test("unsafe memberships, ownership, and membership-admin options are rejected", () => {
  for (const changes of [
    { loginMemberships: [{ memberRole: "aichm_app_login", grantedRole: "aichm_crm_owner", adminOption: false }] },
    { loginMemberships: [{ memberRole: "aichm_app_login", grantedRole: "aichm_app_runtime", adminOption: true }] },
    { runtimeGroupMembers: [{ memberRole: "another_login", grantedRole: "aichm_app_runtime", adminOption: false }] },
    { runtimeGroupParents: [{ memberRole: "aichm_app_runtime", grantedRole: "some_group", adminOption: false }] },
    { loginOwnsDatabase: true },
    { loginIsOwnerMember: true },
    { loginIsMigratorMember: true },
  ]) {
    assert.throws(() => validateCrmAppRoleProvisioningState({
      ...existingValidState(),
      ...changes,
    } as CrmAppRoleProvisioningState));
  }
});

test("identity mismatch blocks before any role metadata or provisioning write", async () => {
  const client = createMockClient(emptyState(), { ...pinnedIdentity, system_identifier: "wrong" });
  await assert.rejects(
    runCrmAppRoleProvisioning(client as never, "apply", password, CRM_APP_ROLE_CONFIRM_VALUE),
    /CRM_FORWARD_DEVELOPMENT_IDENTITY_MISMATCH/,
  );
  assert.equal(client.calls.some(call => /CREATE ROLE|GRANT |set_config|DO \$aichm_password/.test(call.text)), false);
  assert.equal(client.calls.some(call => call.text.includes("FROM pg_roles") && call.text.includes("WHERE rolname=ANY")), false);
});

test("unsafe existing role attributes or memberships block before provisioning writes", async () => {
  const unsafeStates = [
    {
      ...existingValidState(),
      appLogin: loginAttributes({ superuser: true }),
    },
    {
      ...existingValidState(),
      loginMemberships: [
        ...existingValidState().loginMemberships,
        { memberRole: "aichm_app_login", grantedRole: "aichm_crm_migrator", adminOption: false },
      ],
    },
  ];
  for (const state of unsafeStates) {
    const client = createMockClient(state);
    await assert.rejects(runCrmAppRoleProvisioning(client as never, "apply", password, CRM_APP_ROLE_CONFIRM_VALUE));
    assert.equal(client.calls.some(call => /CREATE ROLE|GRANT |set_config|DO \$aichm_password/.test(call.text)), false);
  }
});

test("preview reads the pinned identity and roles but performs no provisioning writes", async () => {
  const client = createMockClient(emptyState());
  const stages: string[] = [];
  const result = await runCrmAppRoleProvisioning(client as never, "preview", password, undefined, {
    setStage: stage => stages.push(stage),
  });
  assert.deepEqual(result, {
    passwordSecretPresent: true,
    passwordIsString: true,
    lengthAccepted: true,
    hasWhitespace: false,
    asciiAlphanumericOnly: true,
    hasNonAscii: false,
    hasControlCharacter: false,
    hasLowercase: true,
    hasUppercase: true,
    hasDigit: true,
    overallFormatValid: true,
  });
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.deepEqual(stages, [
    CRM_APP_ROLE_STAGE_CODES.readOnlyTransactionBegin,
    CRM_APP_ROLE_STAGE_CODES.pinnedIdentity,
    CRM_APP_ROLE_STAGE_CODES.roleMetadata,
    CRM_APP_ROLE_STAGE_CODES.passwordReadiness,
    CRM_APP_ROLE_STAGE_CODES.readOnlyTransactionCompletion,
  ]);
  assert.equal(client.calls.some(call => /CREATE ROLE|GRANT |set_config|DO \$aichm_password/.test(call.text)), false);
});

test("apply creates missing roles safely and passes the password only as a bound parameter", async () => {
  const client = createMockClient(emptyState());
  const result = await runCrmAppRoleProvisioning(client as never, "apply", password, CRM_APP_ROLE_CONFIRM_VALUE);
  assert.equal(result.status, "provisioned");
  assert.equal(client.calls.some(call => call.text.startsWith("CREATE ROLE aichm_app_runtime")), true);
  assert.equal(client.calls.some(call => call.text.startsWith("CREATE ROLE aichm_app_login")), true);
  assert.equal(client.calls.some(call => call.text.startsWith("GRANT aichm_app_runtime TO aichm_app_login")), true);
  const passwordCall = client.calls.find(call => call.text.includes("set_config('aichm.crm_app_role_password'"));
  assert.deepEqual(passwordCall?.values, [password]);
  assert.equal(client.calls.some(call => call.text.includes(password)), false);
  assert.equal(JSON.stringify(result).includes(password), false);
  const passwordDdl = client.calls.find(call => call.text.includes("DO $aichm_password$"));
  assert.match(passwordDdl?.text ?? "", /format\([\s\S]*%L[\s\S]*current_setting/);
});

test("repeating provisioning is idempotent for existing roles and membership", async () => {
  const client = createMockClient(existingValidState());
  const first = await runCrmAppRoleProvisioning(client as never, "apply", password, CRM_APP_ROLE_CONFIRM_VALUE);
  const second = await runCrmAppRoleProvisioning(client as never, "apply", password, CRM_APP_ROLE_CONFIRM_VALUE);
  assert.equal(first.status, "provisioned");
  assert.equal(second.status, "provisioned");
  assert.equal(client.calls.filter(call => call.text.startsWith("CREATE ROLE")).length, 0);
  assert.equal(client.calls.filter(call => call.text.startsWith("GRANT ")).length, 0);
  assert.equal(client.calls.filter(call => call.text.includes("set_config('aichm.crm_app_role_password'")).length, 2);
});

test("apply rejects a missing or malformed password before making any database call", async () => {
  const missing = createMockClient(emptyState());
  await assert.rejects(runCrmAppRoleProvisioning(missing as never, "apply", undefined, CRM_APP_ROLE_CONFIRM_VALUE));
  assert.equal(missing.calls.length, 0);
  const malformed = createMockClient(emptyState());
  await assert.rejects(runCrmAppRoleProvisioning(malformed as never, "apply", "unsafe", CRM_APP_ROLE_CONFIRM_VALUE));
  assert.equal(malformed.calls.length, 0);
  const unconfirmed = createMockClient(emptyState());
  await assert.rejects(runCrmAppRoleProvisioning(unconfirmed as never, "apply", password));
  assert.equal(unconfirmed.calls.length, 0);
});

test("provisioner sanitizes errors and does not print password-related environment values", async () => {
  const error = Object.assign(new Error(password), { code: "CRM_APP_ROLE_PASSWORD_SET_FAILED" });
  assert.equal(sanitizedCrmAppRoleErrorCode(error), "CRM_APP_ROLE_PASSWORD_SET_FAILED");
  assert.equal(sanitizedCrmAppRoleErrorCode(new Error(password)), "CRM_APP_ROLE_PROVISION_FAILED");
  const script = await readFile("script/provision-crm-app-role.ts", "utf8");
  assert.match(script, /process\.env\[CRM_APP_ROLE_PASSWORD_ENV\]/);
  assert.doesNotMatch(script, /process\.argv[^;\n]*PASSWORD|console\.(?:log|error)\([^;\n]*password/i);
  assert.match(script, /requireCrmForwardConnectionUrl\(process\.env\)/);
  assert.match(script, /new Pool\(operatorPoolConfig\(dedicatedUrl, effectivePort\)\)/);
  assert.doesNotMatch(script, /new Pool\(\s*process\.env\.DATABASE_URL/);
  for (const stage of ["urlParsing", "poolCreation", "poolConnection", "cleanup"]) {
    assert.match(script, new RegExp(`setStage\\(CRM_APP_ROLE_STAGE_CODES\\.${stage}\\)`));
  }
});

test("role-inspection failures retain their stage and only an allowlisted code", async () => {
  const privateText = "postgres://sensitive-user:secret@private-host/aichm";
  const networkError = Object.assign(new Error(privateText), { code: "ECONNREFUSED" });
  const client = createMockClient(emptyState(), pinnedIdentity, text =>
    text.includes("FROM pg_auth_members membership") ? networkError : undefined,
  );
  let stage: string | undefined;
  await assert.rejects(
    runCrmAppRoleProvisioning(client as never, "preview", password, undefined, {
      setStage: value => { stage = value; },
    }),
  );
  const diagnostic = formatCrmAppRoleFailureDiagnostic({
    correlationId: "11111111-1111-4111-8111-111111111111",
    stageCode: stage as never,
    error: networkError,
  });
  assert.equal(stage, CRM_APP_ROLE_STAGE_CODES.roleMetadata);
  assert.equal(diagnostic.errorCode, "ECONNREFUSED");
  assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
});

test("cleanup failure is reported separately without replacing the primary failure", async () => {
  const primary = Object.assign(new Error("private URL and password must not appear"), {
    code: "08006",
  });
  const rollback = Object.assign(new Error("private cleanup details"), {
    code: "CRM_APP_ROLE_POOL_CLEANUP_FAILED",
  });
  const client = createMockClient(emptyState(), pinnedIdentity, text => {
    if (text === "COMMIT") return primary;
    if (text === "ROLLBACK") return rollback;
    return undefined;
  });
  const cleanupErrors: unknown[] = [];
  let stage: string | undefined;
  await assert.rejects(
    runCrmAppRoleProvisioning(client as never, "preview", password, undefined, {
      setStage: value => { stage = value; },
      onCleanupFailure: error => cleanupErrors.push(error),
    }),
  );
  const diagnostic = formatCrmAppRoleFailureDiagnostic({
    correlationId: "22222222-2222-4222-8222-222222222222",
    stageCode: stage as never,
    error: primary,
    cleanupError: cleanupErrors[0],
  });
  assert.equal(stage, CRM_APP_ROLE_STAGE_CODES.readOnlyTransactionCompletion);
  const selected = selectCrmAppRoleFailure({
    hasPrimaryFailure: true,
    primaryError: primary,
    primaryStageCode: stage as never,
    hasCleanupFailure: true,
    cleanupError: cleanupErrors[0],
  });
  assert.equal(selected?.error, primary);
  assert.equal(selected?.cleanupError, rollback);
  assert.equal(diagnostic.errorCode, "08006");
  assert.equal(diagnostic.cleanupStageCode, CRM_APP_ROLE_STAGE_CODES.cleanup);
  assert.equal(diagnostic.cleanupErrorCode, "CRM_APP_ROLE_POOL_CLEANUP_FAILED");
  assert.equal(JSON.stringify(diagnostic).includes("private"), false);
});

test("cleanup-only failure is reported as the primary cleanup stage", () => {
  const cleanup = Object.assign(new Error("secret cleanup text"), {
    code: "CRM_APP_ROLE_POOL_CLEANUP_FAILED",
  });
  const selected = selectCrmAppRoleFailure({
    hasPrimaryFailure: false,
    primaryError: undefined,
    hasCleanupFailure: true,
    cleanupError: cleanup,
  });
  assert.equal(selected?.error, cleanup);
  assert.equal(selected?.stageCode, CRM_APP_ROLE_STAGE_CODES.cleanup);
  const diagnostic = formatCrmAppRoleFailureDiagnostic({
    correlationId: "44444444-4444-4444-8444-444444444444",
    stageCode: selected!.stageCode,
    error: selected!.error,
  });
  assert.equal(diagnostic.errorCode, "CRM_APP_ROLE_POOL_CLEANUP_FAILED");
});

test("diagnostic formatting rejects unallowlisted codes and exposes no raw message", () => {
  const error = Object.assign(new Error("sensitive endpoint and token"), {
    code: "PRIVATE_PASSWORD_VALUE",
    cause: Object.assign(new Error("nested endpoint"), { code: "ETIMEDOUT" }),
  });
  const diagnostic = formatCrmAppRoleFailureDiagnostic({
    correlationId: "33333333-3333-4333-8333-333333333333",
    stageCode: CRM_APP_ROLE_STAGE_CODES.poolConnection,
    error,
  });
  assert.deepEqual(diagnostic, {
    correlationId: "33333333-3333-4333-8333-333333333333",
    stageCode: CRM_APP_ROLE_STAGE_CODES.poolConnection,
    errorCode: "ETIMEDOUT",
  });
  assert.equal(JSON.stringify(diagnostic).includes("sensitive"), false);
  assert.equal(JSON.stringify(diagnostic).includes("endpoint"), false);
});
