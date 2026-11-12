import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CRM_APP_ROLE_APPLY_FLAG,
  CRM_APP_ROLE_CONFIRM_ENV,
  CRM_APP_ROLE_CONFIRM_VALUE,
  isStrongAlphanumericAppRolePassword,
  parseCrmAppRoleProvisionMode,
  planCrmAppRoleProvisioning,
  runCrmAppRoleProvisioning,
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
) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const state = structuredClone(initialState);
  return {
    calls,
    state,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
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
  const result = await runCrmAppRoleProvisioning(client as never, "preview", password);
  assert.equal(result.status, "preview");
  assert.deepEqual(result.plan, {
    createRuntimeGroup: true,
    createAppLogin: true,
    grantRuntimeMembership: true,
    setLoginPassword: true,
  });
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
});
