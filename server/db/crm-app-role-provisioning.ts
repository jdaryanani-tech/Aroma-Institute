import type { PoolClient } from "pg";
import {
  assertCrmForwardDevelopmentIdentity,
  CRM_FORWARD_DEVELOPMENT_IDENTITY,
  CRM_FORWARD_GUARD_ERROR_CODES,
  type CrmForwardDatabaseIdentity,
} from "./crm-forward-migration-guard";

export const CRM_APP_ROLE_APPLY_FLAG = "--apply-development-app-role";
export const CRM_APP_ROLE_CONFIRM_ENV = "AICHM_CRM_APP_ROLE_PROVISION_CONFIRM";
export const CRM_APP_ROLE_CONFIRM_VALUE = "PROVISION_AICHM_APP_LOGIN_IN_PINNED_DEVELOPMENT";
export const CRM_APP_ROLE_PASSWORD_ENV = "AICHM_APP_ROLE_PASSWORD";
export const CRM_APP_ROLE_PASSWORD_MIN_LENGTH = 32;

export type CrmAppRoleProvisionMode = "preview" | "apply";

export type CrmAppRoleAttributes = {
  canLogin: boolean;
  superuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  inherit: boolean;
  bypassRls: boolean;
  replication: boolean;
};

export type CrmAppRoleMembership = {
  memberRole: string;
  grantedRole: string;
  adminOption: boolean;
};

export type CrmAppRoleProvisioningState = {
  runtimeGroup: CrmAppRoleAttributes | null;
  appLogin: CrmAppRoleAttributes | null;
  loginMemberships: CrmAppRoleMembership[];
  runtimeGroupMembers: CrmAppRoleMembership[];
  runtimeGroupParents: CrmAppRoleMembership[];
  loginOwnsDatabase: boolean;
  loginIsOwnerMember: boolean;
  loginIsMigratorMember: boolean;
};

export type CrmAppRoleProvisionPlan = {
  createRuntimeGroup: boolean;
  createAppLogin: boolean;
  grantRuntimeMembership: boolean;
  setLoginPassword: true;
};

export type CrmAppRoleProvisionQueryable = Pick<PoolClient, "query">;

export function parseCrmAppRoleProvisionMode(
  args: string[],
  environment: Record<string, string | undefined>,
): CrmAppRoleProvisionMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview")) return "preview";
  if (
    args.length === 1 &&
    args[0] === CRM_APP_ROLE_APPLY_FLAG &&
    environment[CRM_APP_ROLE_CONFIRM_ENV] === CRM_APP_ROLE_CONFIRM_VALUE
  ) return "apply";
  if (args.length === 1 && args[0] === CRM_APP_ROLE_APPLY_FLAG) {
    throw codedError("CRM_APP_ROLE_EXPLICIT_CONFIRMATION_REQUIRED");
  }
  throw codedError("CRM_APP_ROLE_ARGUMENTS_REJECTED");
}

export function isStrongAlphanumericAppRolePassword(value: string | undefined): value is string {
  return typeof value === "string" &&
    value.length >= CRM_APP_ROLE_PASSWORD_MIN_LENGTH &&
    value.length <= 128 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /^[A-Za-z0-9]+$/.test(value);
}

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  Object.defineProperty(error, "code", { value: code, enumerable: false });
  return error;
}

export function createCrmAppRoleProvisionError(code: string): Error & { code: string } {
  return codedError(code);
}

function provisionFail(code: string): never {
  throw codedError(code);
}

function hasSafeAttributes(
  role: CrmAppRoleAttributes,
  expected: CrmAppRoleAttributes,
): boolean {
  return role.canLogin === expected.canLogin &&
    role.superuser === expected.superuser &&
    role.canCreateDb === expected.canCreateDb &&
    role.canCreateRole === expected.canCreateRole &&
    role.inherit === expected.inherit &&
    role.bypassRls === expected.bypassRls &&
    role.replication === expected.replication;
}

const EXPECTED_RUNTIME_GROUP: CrmAppRoleAttributes = {
  canLogin: false,
  superuser: false,
  canCreateDb: false,
  canCreateRole: false,
  inherit: false,
  bypassRls: false,
  replication: false,
};

const EXPECTED_APP_LOGIN: CrmAppRoleAttributes = {
  canLogin: true,
  superuser: false,
  canCreateDb: false,
  canCreateRole: false,
  inherit: true,
  bypassRls: false,
  replication: false,
};

export function validateCrmAppRoleProvisioningState(
  state: CrmAppRoleProvisioningState,
): void {
  if (state.runtimeGroup && !hasSafeAttributes(state.runtimeGroup, EXPECTED_RUNTIME_GROUP)) {
    provisionFail("CRM_APP_ROLE_RUNTIME_GROUP_ATTRIBUTES_REJECTED");
  }
  if (state.appLogin && !hasSafeAttributes(state.appLogin, EXPECTED_APP_LOGIN)) {
    provisionFail("CRM_APP_ROLE_LOGIN_ATTRIBUTES_REJECTED");
  }
  if (
    state.loginOwnsDatabase ||
    state.loginIsOwnerMember ||
    state.loginIsMigratorMember
  ) {
    provisionFail("CRM_APP_ROLE_LOGIN_PRIVILEGE_REJECTED");
  }
  if (
    state.loginMemberships.some(membership =>
      membership.grantedRole !== "aichm_app_runtime" || membership.adminOption,
    )
  ) {
    provisionFail("CRM_APP_ROLE_LOGIN_MEMBERSHIPS_REJECTED");
  }
  if (
    state.runtimeGroupMembers.some(membership =>
      membership.memberRole !== "aichm_app_login" || membership.adminOption,
    ) ||
    state.runtimeGroupMembers.length > 1
  ) {
    provisionFail("CRM_APP_ROLE_GROUP_MEMBERS_REJECTED");
  }
  if (state.runtimeGroupParents.length > 0) {
    provisionFail("CRM_APP_ROLE_GROUP_MEMBERSHIP_REJECTED");
  }
  if (
    state.loginMemberships.length > 1 ||
    state.runtimeGroupMembers.length > 1 ||
    (state.loginMemberships.length === 1 && state.runtimeGroupMembers.length !== 1) ||
    (state.runtimeGroupMembers.length === 1 && state.loginMemberships.length !== 1) ||
    (state.loginMemberships.length === 1 &&
      state.runtimeGroupMembers.length === 1 &&
      state.loginMemberships[0].memberRole !== state.runtimeGroupMembers[0].memberRole)
  ) {
    provisionFail("CRM_APP_ROLE_MEMBERSHIP_STATE_INCONSISTENT");
  }
}

export function planCrmAppRoleProvisioning(
  state: CrmAppRoleProvisioningState,
): CrmAppRoleProvisionPlan {
  validateCrmAppRoleProvisioningState(state);
  return {
    createRuntimeGroup: state.runtimeGroup === null,
    createAppLogin: state.appLogin === null,
    grantRuntimeMembership: state.loginMemberships.length === 0,
    setLoginPassword: true,
  };
}

function codeFromError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^CRM_APP_ROLE_[A-Z_]+$/.test(code)) return code;
    if (
      code === "CRM_FORWARD_PRODUCTION_IDENTITY_REJECTED" ||
      code === "CRM_FORWARD_DEVELOPMENT_IDENTITY_MISMATCH" ||
      (typeof code === "string" &&
        (Object.values(CRM_FORWARD_GUARD_ERROR_CODES) as string[]).includes(code))
    ) return String(code);
  }
  return "CRM_APP_ROLE_PROVISION_FAILED";
}

async function readIdentity(
  client: CrmAppRoleProvisionQueryable,
): Promise<CrmForwardDatabaseIdentity> {
  const { rows: [row] } = await client.query<{
    database_name: string;
    database_oid: string;
    database_user: string;
    system_identifier: string;
    in_recovery: boolean;
    default_transaction_read_only: boolean;
  }>(`
    SELECT current_database() AS database_name,
      d.oid::text AS database_oid,
      current_user AS database_user,
      (pg_control_system()).system_identifier::text AS system_identifier,
      pg_is_in_recovery() AS in_recovery,
      current_setting('default_transaction_read_only')::boolean AS default_transaction_read_only
    FROM pg_database d
    WHERE d.datname=current_database()
  `);
  if (!row) provisionFail("CRM_APP_ROLE_IDENTITY_UNAVAILABLE");
  return {
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    databaseUser: row.database_user,
    systemIdentifier: row.system_identifier,
    inRecovery: row.in_recovery,
    defaultTransactionReadOnly: row.default_transaction_read_only,
  };
}

async function assertPinnedIdentity(client: CrmAppRoleProvisionQueryable): Promise<CrmForwardDatabaseIdentity> {
  const identity = await readIdentity(client);
  try {
    assertCrmForwardDevelopmentIdentity(identity);
  } catch (error) {
    throw error;
  }
  return identity;
}

export async function readCrmAppRoleProvisioningState(
  client: CrmAppRoleProvisionQueryable,
): Promise<CrmAppRoleProvisioningState> {
  const { rows: roleRows } = await client.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
  }>(`
    SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
      rolinherit,rolbypassrls,rolreplication
    FROM pg_roles
    WHERE rolname=ANY($1::text[])
  `, [["aichm_app_runtime", "aichm_app_login"]]);

  const { rows: membershipRows } = await client.query<{
    member_role: string;
    granted_role: string;
    admin_option: boolean;
  }>(`
    SELECT member.rolname AS member_role,
      granted.rolname AS granted_role,
      membership.admin_option
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles granted ON granted.oid=membership.roleid
    WHERE member.rolname IN ('aichm_app_login','aichm_app_runtime')
       OR granted.rolname='aichm_app_runtime'
  `);

  const { rows: [ownership] } = await client.query<{
    login_owns_database: boolean;
    login_is_owner_member: boolean;
    login_is_migrator_member: boolean;
  }>(`
    SELECT COALESCE((
        SELECT login.oid=d.datdba OR pg_has_role(login.oid,d.datdba,'MEMBER')
        FROM pg_roles login
        JOIN pg_database d ON d.datname=current_database()
        WHERE login.rolname='aichm_app_login'
      ),false) AS login_owns_database,
      COALESCE((
        SELECT CASE
          WHEN owner_role.oid IS NULL THEN false
          ELSE pg_has_role(login.oid,owner_role.oid,'MEMBER')
        END
        FROM pg_roles login
        LEFT JOIN pg_roles owner_role ON owner_role.rolname='aichm_crm_owner'
        WHERE login.rolname='aichm_app_login'
      ),false) AS login_is_owner_member,
      COALESCE((
        SELECT CASE
          WHEN migrator_role.oid IS NULL THEN false
          ELSE pg_has_role(login.oid,migrator_role.oid,'MEMBER')
        END
        FROM pg_roles login
        LEFT JOIN pg_roles migrator_role ON migrator_role.rolname='aichm_crm_migrator'
        WHERE login.rolname='aichm_app_login'
      ),false) AS login_is_migrator_member
  `);

  const roleByName = new Map(roleRows.map(row => [row.rolname, row]));
  const toAttributes = (name: string): CrmAppRoleAttributes | null => {
    const role = roleByName.get(name);
    return role ? {
      canLogin: role.rolcanlogin,
      superuser: role.rolsuper,
      canCreateDb: role.rolcreatedb,
      canCreateRole: role.rolcreaterole,
      inherit: role.rolinherit,
      bypassRls: role.rolbypassrls,
      replication: role.rolreplication,
    } : null;
  };
  const memberships: CrmAppRoleMembership[] = membershipRows.map(row => ({
    memberRole: row.member_role,
    grantedRole: row.granted_role,
    adminOption: row.admin_option,
  }));

  return {
    runtimeGroup: toAttributes("aichm_app_runtime"),
    appLogin: toAttributes("aichm_app_login"),
    loginMemberships: memberships.filter(row => row.memberRole === "aichm_app_login"),
    runtimeGroupMembers: memberships.filter(row => row.grantedRole === "aichm_app_runtime"),
    runtimeGroupParents: memberships.filter(row => row.memberRole === "aichm_app_runtime"),
    loginOwnsDatabase: ownership?.login_owns_database ?? false,
    loginIsOwnerMember: ownership?.login_is_owner_member ?? false,
    loginIsMigratorMember: ownership?.login_is_migrator_member ?? false,
  };
}

async function provisionWrites(
  client: CrmAppRoleProvisionQueryable,
  plan: CrmAppRoleProvisionPlan,
  password: string,
): Promise<void> {
  if (plan.createRuntimeGroup) {
    await client.query(
      "CREATE ROLE aichm_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION",
    );
  }
  if (plan.createAppLogin) {
    await client.query(
      "CREATE ROLE aichm_app_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION",
    );
  }
  if (plan.grantRuntimeMembership) {
    await client.query("GRANT aichm_app_runtime TO aichm_app_login");
  }

  // The operator is pinned to the privileged Development identity. Suppress
  // statement/parameter logging only for this transaction so a platform with
  // verbose SQL logging cannot record the credential-setting operation. These
  // are transaction-local settings and reset automatically on commit/rollback.
  await client.query("SET LOCAL log_statement = 'none'");
  await client.query("SET LOCAL log_min_duration_statement = -1");
  await client.query("SET LOCAL log_min_duration_sample = -1");
  await client.query("SET LOCAL log_parameter_max_length = 0");
  await client.query("SET LOCAL log_parameter_max_length_on_error = 0");

  // PostgreSQL utility statements do not accept bind parameters. Keep the
  // password out of client SQL text: bind it to a transaction-local setting,
  // then quote it with PostgreSQL format(%L) inside the server-side block.
  const { rows: [setting] } = await client.query<{ configured: boolean }>(
    "SELECT pg_catalog.set_config('aichm.crm_app_role_password',$1,true) IS NOT NULL AS configured",
    [password],
  );
  if (setting?.configured !== true) provisionFail("CRM_APP_ROLE_PASSWORD_SET_FAILED");
  await client.query(`
    DO $aichm_password$
    BEGIN
      EXECUTE pg_catalog.format(
        'ALTER ROLE aichm_app_login PASSWORD %L',
        pg_catalog.current_setting('aichm.crm_app_role_password')
      );
    END
    $aichm_password$;
  `);
}

function safeResult(
  status: "preview" | "provisioned",
  identity: CrmForwardDatabaseIdentity,
  plan: CrmAppRoleProvisionPlan,
  passwordReady: boolean,
) {
  return {
    status,
    targetIdentity: {
      verified: {
        databaseName: identity.databaseName,
        databaseOid: identity.databaseOid,
        databaseUser: identity.databaseUser,
        systemIdentifier: identity.systemIdentifier,
        inRecovery: identity.inRecovery,
        defaultTransactionReadOnly: identity.defaultTransactionReadOnly,
      },
      expected: CRM_FORWARD_DEVELOPMENT_IDENTITY,
    },
    roles: {
      runtimeGroup: "aichm_app_runtime",
      appLogin: "aichm_app_login",
    },
    passwordSecretReady: passwordReady,
    plan,
  };
}

export async function runCrmAppRoleProvisioning(
  client: CrmAppRoleProvisionQueryable,
  mode: CrmAppRoleProvisionMode,
  password: string | undefined,
  confirmation?: string,
): Promise<ReturnType<typeof safeResult>> {
  if (mode === "apply" && confirmation !== CRM_APP_ROLE_CONFIRM_VALUE) {
    provisionFail("CRM_APP_ROLE_EXPLICIT_CONFIRMATION_REQUIRED");
  }
  if (mode === "apply" && !isStrongAlphanumericAppRolePassword(password)) {
    provisionFail(password ? "CRM_APP_ROLE_PASSWORD_FORMAT_REJECTED" : "CRM_APP_ROLE_PASSWORD_SECRET_REQUIRED");
  }

  if (mode === "preview") {
    await client.query("BEGIN READ ONLY");
    try {
      const identity = await assertPinnedIdentity(client);
      const state = await readCrmAppRoleProvisioningState(client);
      const plan = planCrmAppRoleProvisioning(state);
      await client.query("COMMIT");
      return safeResult("preview", identity, plan, isStrongAlphanumericAppRolePassword(password));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  await client.query("BEGIN");
  try {
    await assertPinnedIdentity(client);
    await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [1095326536, 1128813875]);
    const identity = await assertPinnedIdentity(client);
    const initialState = await readCrmAppRoleProvisioningState(client);
    const plan = planCrmAppRoleProvisioning(initialState);

    // Identity and role state are rechecked immediately before the first
    // provisioning DDL/GRANT. Any drift aborts the whole transaction.
    const writeIdentity = await assertPinnedIdentity(client);
    if (
      writeIdentity.databaseName !== identity.databaseName ||
      writeIdentity.databaseOid !== identity.databaseOid ||
      writeIdentity.databaseUser !== identity.databaseUser ||
      writeIdentity.systemIdentifier !== identity.systemIdentifier ||
      writeIdentity.inRecovery ||
      writeIdentity.defaultTransactionReadOnly
    ) provisionFail("CRM_APP_ROLE_DEVELOPMENT_IDENTITY_REJECTED");
    const stateAtWrite = await readCrmAppRoleProvisioningState(client);
    const writePlan = planCrmAppRoleProvisioning(stateAtWrite);
    const beforeWriteIdentity = await assertPinnedIdentity(client);
    if (
      beforeWriteIdentity.databaseName !== identity.databaseName ||
      beforeWriteIdentity.databaseOid !== identity.databaseOid ||
      beforeWriteIdentity.databaseUser !== identity.databaseUser ||
      beforeWriteIdentity.systemIdentifier !== identity.systemIdentifier ||
      beforeWriteIdentity.inRecovery ||
      beforeWriteIdentity.defaultTransactionReadOnly
    ) provisionFail("CRM_APP_ROLE_DEVELOPMENT_IDENTITY_REJECTED");
    await provisionWrites(client, writePlan, password!);

    const finalState = await readCrmAppRoleProvisioningState(client);
    validateCrmAppRoleProvisioningState(finalState);
    if (
      !finalState.runtimeGroup ||
      !finalState.appLogin ||
      finalState.loginMemberships.length !== 1 ||
      finalState.loginMemberships[0].grantedRole !== "aichm_app_runtime" ||
      finalState.runtimeGroupMembers.length !== 1 ||
      finalState.runtimeGroupMembers[0].memberRole !== "aichm_app_login"
    ) provisionFail("CRM_APP_ROLE_POSTCONDITION_FAILED");
    const finalIdentity = await assertPinnedIdentity(client);
    if (
      finalIdentity.databaseName !== identity.databaseName ||
      finalIdentity.databaseOid !== identity.databaseOid ||
      finalIdentity.databaseUser !== identity.databaseUser ||
      finalIdentity.systemIdentifier !== identity.systemIdentifier
    ) provisionFail("CRM_APP_ROLE_DEVELOPMENT_IDENTITY_REJECTED");
    await client.query("COMMIT");
    return safeResult("provisioned", finalIdentity, writePlan, true);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export function sanitizedCrmAppRoleErrorCode(error: unknown): string {
  return codeFromError(error);
}
