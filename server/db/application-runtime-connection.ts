import type { Pool, PoolConfig } from "pg";
import { isIP } from "node:net";

export const APP_DATABASE_URL_ENV = "AICHM_APP_DATABASE_URL";
const PLATFORM_DATABASE_URL_ENV = "DATABASE_URL";

type Endpoint = {
  host: string;
  port: number;
  database: string;
  queryPolicy: string[];
  sslModeEntries: string[];
};

export type ApplicationRuntimeMode =
  | { kind: "legacy"; connectionString: string }
  | { kind: "least_privilege"; connectionString: string; expectedDatabase: string };

export const APPLICATION_PRE_MIGRATION_STAGE_CODES = Object.freeze({
  candidatePoolConnection: "APP_DATABASE_PREMIGRATION_STAGE_CANDIDATE_POOL_CONNECTION",
  identityReadinessSelect: "APP_DATABASE_PREMIGRATION_STAGE_IDENTITY_READINESS_SELECT",
  roleMetadataValidation: "APP_DATABASE_PREMIGRATION_STAGE_ROLE_METADATA_VALIDATION",
});

export const APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES = Object.freeze({
  invalidPassword: "INVALID_PASSWORD",
  authorizationFailed: "AUTHORIZATION_FAILED",
  insufficientPrivilege: "INSUFFICIENT_PRIVILEGE",
  invalidDatabase: "INVALID_DATABASE",
  connectionFailed: "CONNECTION_FAILED",
  databaseQueryFailed: "DATABASE_QUERY_FAILED",
  connectionOrQueryFailed: "CONNECTION_OR_QUERY_FAILED",
  identityValidationFailed: "IDENTITY_VALIDATION_FAILED",
  roleValidationFailed: "ROLE_VALIDATION_FAILED",
});

export type ApplicationPreMigrationStageCode =
  (typeof APPLICATION_PRE_MIGRATION_STAGE_CODES)[keyof typeof APPLICATION_PRE_MIGRATION_STAGE_CODES];
export type ApplicationPreMigrationFailureCategory =
  (typeof APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES)[keyof typeof APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES];
export type ApplicationPreMigrationFailureDiagnostic = {
  stageCode: ApplicationPreMigrationStageCode;
  categoryCode: ApplicationPreMigrationFailureCategory;
};

const PRE_MIGRATION_STAGE_CODE_SET = new Set<string>(
  Object.values(APPLICATION_PRE_MIGRATION_STAGE_CODES),
);
const PRE_MIGRATION_FAILURE_CATEGORY_SET = new Set<string>(
  Object.values(APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES),
);

export function classifyApplicationPreMigrationSqlError(
  error: unknown,
): ApplicationPreMigrationFailureCategory {
  if (!error || typeof error !== "object") {
    return APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionOrQueryFailed;
  }

  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionOrQueryFailed;
  }
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) {
    return APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionOrQueryFailed;
  }

  switch (code) {
    case "28P01":
      return APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.invalidPassword;
    case "28000":
      return APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.authorizationFailed;
    case "42501":
      return APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.insufficientPrivilege;
    case "3D000":
      return APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.invalidDatabase;
    default:
      return code.startsWith("08")
        ? APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.connectionFailed
        : APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.databaseQueryFailed;
  }
}

export function applicationPreMigrationFailureDiagnosticFromError(
  error: unknown,
): ApplicationPreMigrationFailureDiagnostic | null {
  if (!error || typeof error !== "object") return null;

  let raw: unknown;
  try {
    raw = (error as { applicationPreMigrationFailure?: unknown }).applicationPreMigrationFailure;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const diagnostic = raw as Record<string, unknown>;
  if (
    typeof diagnostic.stageCode !== "string" ||
    !PRE_MIGRATION_STAGE_CODE_SET.has(diagnostic.stageCode) ||
    typeof diagnostic.categoryCode !== "string" ||
    !PRE_MIGRATION_FAILURE_CATEGORY_SET.has(diagnostic.categoryCode)
  ) return null;

  return {
    stageCode: diagnostic.stageCode as ApplicationPreMigrationStageCode,
    categoryCode: diagnostic.categoryCode as ApplicationPreMigrationFailureCategory,
  };
}

const APPLICATION_RUNTIME_FAILURE_CODES = new Set([
  "APP_DATABASE_URL_REQUIRED",
  "APP_DATABASE_URL_INVALID",
  "APP_DATABASE_PLATFORM_REFERENCE_REQUIRED",
  "APP_DATABASE_PLATFORM_REFERENCE_INVALID",
  "APP_DATABASE_ENDPOINT_NOT_INTERNAL",
  "APP_DATABASE_HOST_POLICY_REJECTED",
  "APP_DATABASE_NEON_SSLMODE_REQUIRED",
  "APP_DATABASE_ENDPOINT_MISMATCH",
  "APP_DATABASE_LOGIN_NOT_DISTINCT",
  "APP_DATABASE_RUNTIME_IDENTITY_UNAVAILABLE",
  "APP_DATABASE_RUNTIME_IDENTITY_REJECTED",
  "APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY",
  "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE",
  "APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH",
  "APP_DATABASE_PREMIGRATION_LOGIN_REJECTED",
  "APP_DATABASE_PREMIGRATION_GROUP_REJECTED",
  "APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED",
]);

export function applicationRuntimeFailureCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && APPLICATION_RUNTIME_FAILURE_CODES.has(code) ? code : null;
}

function reject(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

function isReplitManagedNeonHost(host: string): boolean {
  // Replit's legacy managed PostgreSQL endpoints use
  // <endpoint-id>.<region>.aws.neon.tech. Accept only that documented shape;
  // the Production URL must still match DATABASE_URL exactly and use TLS.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.aws\.neon\.tech$/.test(host);
}

function isAllowedDatabaseHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (normalized === "helium") return true;
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  if (isIP(normalized) !== 0) return false;
  return normalized.endsWith(".internal") || isReplitManagedNeonHost(normalized);
}

function hasRequiredManagedNeonTls(endpoint: Endpoint): boolean {
  return !isReplitManagedNeonHost(endpoint.host) ||
    (endpoint.sslModeEntries.length === 1 && endpoint.sslModeEntries[0] === "require");
}

function isAllowedDatabaseEndpoint(endpoint: Endpoint): boolean {
  return isAllowedDatabaseHost(endpoint.host) && hasRequiredManagedNeonTls(endpoint);
}

function assertAllowedDatabaseEndpoint(endpoint: Endpoint): void {
  if (!isAllowedDatabaseHost(endpoint.host)) {
    reject("APP_DATABASE_HOST_POLICY_REJECTED");
  }
  if (!hasRequiredManagedNeonTls(endpoint)) {
    reject("APP_DATABASE_NEON_SSLMODE_REQUIRED");
  }
}

function endpointFrom(raw: string | undefined, label: "app" | "platform"): Endpoint & {
  user: string;
  password: string;
} {
  if (!raw?.trim()) {
    reject(label === "app"
      ? "APP_DATABASE_URL_INVALID"
      : "APP_DATABASE_PLATFORM_REFERENCE_REQUIRED");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }
  if (!url.hostname || url.hash || url.pathname.length < 2 || url.pathname.slice(1).includes("/")) {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }
  if (!url.username) {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }

  const endpointOverrideKeys = new Set(["host", "port", "user", "username", "database", "db", "password"]);
  let hasEndpointOverride = false;
  url.searchParams.forEach((_value, key) => {
    if (endpointOverrideKeys.has(key.toLowerCase())) hasEndpointOverride = true;
  });
  if (hasEndpointOverride) {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }

  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }

  let database: string;
  let user: string;
  let password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }
  if (!database || !user) {
    reject(label === "app" ? "APP_DATABASE_URL_INVALID" : "APP_DATABASE_PLATFORM_REFERENCE_INVALID");
  }
  return {
    host: url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""),
    port,
    database,
    sslModeEntries: Array.from(url.searchParams.entries())
      .filter(([key]) => key.toLowerCase() === "sslmode")
      .map(([, value]) => value),
    queryPolicy: Array.from(url.searchParams.entries())
      .map(([key, value]) => `${key}=${value}`)
      .sort(),
    user,
    password,
  };
}

export type ApplicationDatabaseEndpointPolicyReadiness = {
  hostPolicySatisfied: boolean;
  requiredTlsPolicySatisfied: boolean;
};

function endpointForReadiness(
  raw: string | undefined,
  label: "app" | "platform",
): Endpoint | null {
  try {
    return endpointFrom(raw, label);
  } catch {
    return null;
  }
}

/**
 * Inspect configured endpoint policy without opening a database connection.
 * The result intentionally contains only booleans; never return parsed URL
 * components or the underlying parser/validation error.
 */
export function inspectApplicationDatabaseEndpointPolicy(
  environment: Record<string, string | undefined>,
): ApplicationDatabaseEndpointPolicyReadiness {
  const app = endpointForReadiness(environment[APP_DATABASE_URL_ENV], "app");
  const platform = endpointForReadiness(environment[PLATFORM_DATABASE_URL_ENV], "platform");

  return {
    hostPolicySatisfied: Boolean(
      app &&
      platform &&
      isAllowedDatabaseHost(app.host) &&
      isAllowedDatabaseHost(platform.host)
    ),
    requiredTlsPolicySatisfied: Boolean(
      app &&
      platform &&
      hasRequiredManagedNeonTls(app) &&
      hasRequiredManagedNeonTls(platform)
    ),
  };
}

export function resolveApplicationRuntimeMode(
  environment: Record<string, string | undefined>,
  runtimeEnvironment = environment.NODE_ENV,
): ApplicationRuntimeMode {
  // Production must never fall back to the platform/migration connection.
  // Require an explicit application login and prove it targets the same
  // internal database endpoint before constructing the runtime pool.
  if (runtimeEnvironment === "production") {
    const explicit = environment[APP_DATABASE_URL_ENV];
    if (!explicit?.trim()) reject("APP_DATABASE_URL_REQUIRED");
    const app = endpointFrom(explicit, "app");
    const platform = endpointFrom(environment[PLATFORM_DATABASE_URL_ENV], "platform");
    assertAllowedDatabaseEndpoint(app);
    assertAllowedDatabaseEndpoint(platform);
    if (
      app.host !== platform.host ||
      app.port !== platform.port ||
      app.database !== platform.database ||
      JSON.stringify(app.queryPolicy) !== JSON.stringify(platform.queryPolicy)
    ) reject("APP_DATABASE_ENDPOINT_MISMATCH");
    if (app.user === platform.user) reject("APP_DATABASE_LOGIN_NOT_DISTINCT");
    return {
      kind: "least_privilege",
      connectionString: explicit,
      expectedDatabase: app.database,
    };
  }

  const explicit = environment[APP_DATABASE_URL_ENV];
  if (explicit === undefined) {
    const legacy = environment[PLATFORM_DATABASE_URL_ENV];
    if (!legacy?.trim()) reject("DATABASE_URL_REQUIRED");
    return { kind: "legacy", connectionString: legacy };
  }

  const app = endpointFrom(explicit, "app");
  const platform = endpointFrom(environment[PLATFORM_DATABASE_URL_ENV], "platform");
  assertAllowedDatabaseEndpoint(app);
  assertAllowedDatabaseEndpoint(platform);
  if (
    app.host !== platform.host ||
    app.port !== platform.port ||
    app.database !== platform.database ||
    JSON.stringify(app.queryPolicy) !== JSON.stringify(platform.queryPolicy)
  ) reject("APP_DATABASE_ENDPOINT_MISMATCH");

  return {
    kind: "least_privilege",
    connectionString: explicit,
    expectedDatabase: app.database,
  };
}

/**
 * Compare only endpoint and transport policy. The application login is
 * deliberately different from the platform/migration login.
 */
export function applicationDatabaseEndpointsMatch(
  applicationUrl: string,
  referenceUrl: string,
): boolean {
  try {
    const application = endpointFrom(applicationUrl, "app");
    const reference = endpointFrom(referenceUrl, "platform");
    return isAllowedDatabaseEndpoint(application) &&
      isAllowedDatabaseEndpoint(reference) &&
      application.host === reference.host &&
      application.port === reference.port &&
      application.database === reference.database &&
      JSON.stringify(application.queryPolicy) === JSON.stringify(reference.queryPolicy);
  } catch {
    return false;
  }
}

export function buildApplicationPoolConfig(
  mode: ApplicationRuntimeMode,
): PoolConfig {
  if (mode.kind === "legacy") {
    // Preserve the existing connection behavior until a separate secret is
    // explicitly configured and verified.
    return { connectionString: mode.connectionString };
  }

  const endpoint = endpointFrom(mode.connectionString, "app");
  // Supplying all endpoint/auth fields prevents pg from consulting PGHOST,
  // PGPORT, PGUSER or similar ambient connection variables. `connectionString`
  // remains the source of the URL's TLS/query policy.
  return {
    connectionString: mode.connectionString,
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    password: endpoint.password,
    database: endpoint.database,
  };
}

export type ApplicationRuntimeCheck = {
  status: "least_privilege_verified" | "least_privilege_not_enabled";
};

export type ExpectedApplicationDatabaseIdentity = {
  databaseName: string;
  databaseOid: string;
};

export type ExpectedPreMigrationApplicationIdentity = {
  databaseName: string;
  databaseOid: string;
};

export type ApplicationPreMigrationRoleChecks = {
  candidateDatabaseIdentityMatches: boolean;
  loginRoleExists: boolean;
  login: boolean;
  noSuperuser: boolean;
  noCreatedb: boolean;
  noCreaterole: boolean;
  inherit: boolean;
  noBypassRls: boolean;
  notOperatorUser: boolean;
  notDatabaseOwner: boolean;
  memberInAichmAppRuntime: boolean;
  appRuntimeMembershipNoAdminOption: boolean;
  noMembershipsOutsideAichmAppRuntime: boolean;
  noAichmCrmOwnerOrMigratorMembership: boolean;
  appRuntimeGroupExists: boolean;
  appRuntimeGroupNoLogin: boolean;
  appRuntimeGroupNoSuperuser: boolean;
  appRuntimeGroupNoCreatedb: boolean;
  appRuntimeGroupNoCreaterole: boolean;
  appRuntimeGroupNoInherit: boolean;
  appRuntimeGroupNoBypassRls: boolean;
  appRuntimeGroupHasNoParentMembership: boolean;
  appRuntimeGroupHasOnlyCandidateLogin: boolean;
  roleMetadataRead: boolean;
};

export type ApplicationPreMigrationDiagnostics = ApplicationPreMigrationRoleChecks & {
  endpointMatches: boolean;
  pinnedDevelopmentIdentityMatches: boolean;
};

export type ApplicationPreMigrationObserver = {
  setStage?: (stage: ApplicationPreMigrationStageCode) => void;
};

const PRE_MIGRATION_ROLE_CHECK_KEYS: Array<keyof ApplicationPreMigrationRoleChecks> = [
  "candidateDatabaseIdentityMatches",
  "loginRoleExists",
  "login",
  "noSuperuser",
  "noCreatedb",
  "noCreaterole",
  "inherit",
  "noBypassRls",
  "notOperatorUser",
  "notDatabaseOwner",
  "memberInAichmAppRuntime",
  "appRuntimeMembershipNoAdminOption",
  "noMembershipsOutsideAichmAppRuntime",
  "noAichmCrmOwnerOrMigratorMembership",
  "appRuntimeGroupExists",
  "appRuntimeGroupNoLogin",
  "appRuntimeGroupNoSuperuser",
  "appRuntimeGroupNoCreatedb",
  "appRuntimeGroupNoCreaterole",
  "appRuntimeGroupNoInherit",
  "appRuntimeGroupNoBypassRls",
  "appRuntimeGroupHasNoParentMembership",
  "appRuntimeGroupHasOnlyCandidateLogin",
  "roleMetadataRead",
];

export function emptyApplicationPreMigrationRoleChecks(): ApplicationPreMigrationRoleChecks {
  return Object.fromEntries(PRE_MIGRATION_ROLE_CHECK_KEYS.map(key => [key, false])) as
    ApplicationPreMigrationRoleChecks;
}

export function applicationPreMigrationRoleChecksFromError(
  error: unknown,
): ApplicationPreMigrationRoleChecks | null {
  if (!error || typeof error !== "object" || !("preMigrationRoleChecks" in error)) return null;
  const raw = (error as { preMigrationRoleChecks?: unknown }).preMigrationRoleChecks;
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (PRE_MIGRATION_ROLE_CHECK_KEYS.some(key => typeof source[key] !== "boolean")) return null;
  return Object.fromEntries(
    PRE_MIGRATION_ROLE_CHECK_KEYS.map(key => [key, source[key]]),
  ) as ApplicationPreMigrationRoleChecks;
}

function rejectWithPreMigrationRoleChecks(
  code: string,
  checks: ApplicationPreMigrationRoleChecks,
  categoryCode: ApplicationPreMigrationFailureCategory =
    APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.roleValidationFailed,
): never {
  const error = new Error(code) as Error & {
    code: string;
    preMigrationRoleChecks: ApplicationPreMigrationRoleChecks;
    applicationPreMigrationFailure: ApplicationPreMigrationFailureDiagnostic;
  };
  error.code = code;
  error.preMigrationRoleChecks = checks;
  error.applicationPreMigrationFailure = {
    stageCode: APPLICATION_PRE_MIGRATION_STAGE_CODES.roleMetadataValidation,
    categoryCode,
  };
  throw error;
}

/**
 * Pre-migration probe: deliberately checks only the pinned database and
 * pre-provisioned role boundary. It does not require CRM assignment objects.
 */
export async function verifyApplicationPreMigrationPool(
  pool: Pick<Pool, "query">,
  expectedIdentity: ExpectedPreMigrationApplicationIdentity,
  observer: ApplicationPreMigrationObserver = {},
): Promise<ApplicationPreMigrationRoleChecks> {
  type IdentityRow = {
    database_name: string;
    database_oid: string;
    in_recovery: boolean;
    transaction_read_only: boolean;
    login_role_exists: boolean;
    is_operator_user: boolean;
    login_can_login: boolean;
    login_is_superuser: boolean;
    login_can_createdb: boolean;
    login_can_createrole: boolean;
    login_inherits: boolean;
    login_bypasses_rls: boolean;
    not_database_owner: boolean;
    app_group_exists: boolean;
    app_group_can_login: boolean | null;
    app_group_is_superuser: boolean | null;
    app_group_can_createdb: boolean | null;
    app_group_can_createrole: boolean | null;
    app_group_inherits: boolean | null;
    app_group_bypasses_rls: boolean | null;
    app_group_is_member: boolean;
    app_group_has_memberships: boolean;
    app_group_member_count: number;
    app_group_no_admin_option: boolean;
    no_memberships_outside_app_group: boolean;
    no_owner_or_migrator_membership: boolean;
  };

  let identity: IdentityRow | undefined;
  observer.setStage?.(APPLICATION_PRE_MIGRATION_STAGE_CODES.identityReadinessSelect);
  try {
    ({ rows: [identity] } = await pool.query<IdentityRow>(`
      SELECT current_database() AS database_name,
        d.oid::text AS database_oid,
        pg_is_in_recovery() AS in_recovery,
        current_setting('transaction_read_only')::boolean AS transaction_read_only,
        login.oid IS NOT NULL AS login_role_exists,
        current_user = 'postgres' AS is_operator_user,
        login.rolcanlogin AS login_can_login,
        login.rolsuper AS login_is_superuser,
        login.rolcreatedb AS login_can_createdb,
        login.rolcreaterole AS login_can_createrole,
        login.rolinherit AS login_inherits,
        login.rolbypassrls AS login_bypasses_rls,
        COALESCE(
          login.oid IS NOT NULL AND login.oid<>d.datdba
            AND NOT pg_has_role(login.oid,d.datdba,'MEMBER'),
          false
        ) AS not_database_owner,
        app_group.oid IS NOT NULL AS app_group_exists,
        app_group.rolcanlogin AS app_group_can_login,
        app_group.rolsuper AS app_group_is_superuser,
        app_group.rolcreatedb AS app_group_can_createdb,
        app_group.rolcreaterole AS app_group_can_createrole,
        app_group.rolinherit AS app_group_inherits,
        app_group.rolbypassrls AS app_group_bypasses_rls,
        COALESCE(pg_has_role(login.oid,app_group.oid,'MEMBER'),false) AS app_group_is_member,
        EXISTS (
          SELECT 1 FROM pg_auth_members group_membership
          WHERE group_membership.member=app_group.oid
        ) AS app_group_has_memberships,
        (SELECT count(*)::integer FROM pg_auth_members group_member
          WHERE group_member.roleid=app_group.oid) AS app_group_member_count,
        COALESCE(
          app_group.oid IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_auth_members membership
            WHERE membership.member=login.oid
              AND membership.roleid=app_group.oid
              AND membership.admin_option
          ),
          false
        ) AS app_group_no_admin_option,
        COALESCE(
          app_group.oid IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_auth_members membership
            WHERE membership.member=login.oid
              AND membership.roleid<>app_group.oid
          ),
          false
        ) AS no_memberships_outside_app_group,
        (
          NOT COALESCE(pg_has_role(login.oid,owner_group.oid,'MEMBER'),false)
          AND NOT COALESCE(pg_has_role(login.oid,migrator_group.oid,'MEMBER'),false)
        ) AS no_owner_or_migrator_membership
      FROM pg_database d
      LEFT JOIN pg_roles login ON login.rolname=current_user
      LEFT JOIN pg_roles app_group ON app_group.rolname='aichm_app_runtime'
      LEFT JOIN pg_roles owner_group ON owner_group.rolname='aichm_crm_owner'
      LEFT JOIN pg_roles migrator_group ON migrator_group.rolname='aichm_crm_migrator'
      WHERE d.datname=current_database()
    `));
  } catch (error) {
    const failure = new Error("APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE") as Error & {
      code: string;
      preMigrationRoleChecks: ApplicationPreMigrationRoleChecks;
      applicationPreMigrationFailure: ApplicationPreMigrationFailureDiagnostic;
    };
    failure.code = "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE";
    failure.preMigrationRoleChecks = emptyApplicationPreMigrationRoleChecks();
    failure.applicationPreMigrationFailure = {
      stageCode: APPLICATION_PRE_MIGRATION_STAGE_CODES.identityReadinessSelect,
      categoryCode: classifyApplicationPreMigrationSqlError(error),
    };
    throw failure;
  }

  const checks = emptyApplicationPreMigrationRoleChecks();
  checks.roleMetadataRead = true;
  observer.setStage?.(APPLICATION_PRE_MIGRATION_STAGE_CODES.roleMetadataValidation);
  if (identity) {
    checks.candidateDatabaseIdentityMatches =
      typeof identity.database_name === "string" &&
      typeof identity.database_oid === "string" &&
      typeof identity.in_recovery === "boolean" &&
      typeof identity.transaction_read_only === "boolean" &&
      identity.database_name === expectedIdentity.databaseName &&
      identity.database_oid === expectedIdentity.databaseOid &&
      identity.in_recovery === false &&
      identity.transaction_read_only === false;
    checks.loginRoleExists = identity.login_role_exists === true;
    checks.login = identity.login_can_login === true;
    checks.noSuperuser = identity.login_is_superuser === false;
    checks.noCreatedb = identity.login_can_createdb === false;
    checks.noCreaterole = identity.login_can_createrole === false;
    checks.inherit = identity.login_inherits === true;
    checks.noBypassRls = identity.login_bypasses_rls === false;
    checks.notOperatorUser = identity.is_operator_user === false;
    checks.notDatabaseOwner = identity.not_database_owner === true;
    checks.memberInAichmAppRuntime = identity.app_group_is_member === true;
    checks.appRuntimeMembershipNoAdminOption = identity.app_group_no_admin_option === true;
    checks.noMembershipsOutsideAichmAppRuntime =
      identity.no_memberships_outside_app_group === true;
    checks.noAichmCrmOwnerOrMigratorMembership =
      identity.no_owner_or_migrator_membership === true;
    checks.appRuntimeGroupExists = identity.app_group_exists === true;
    checks.appRuntimeGroupNoLogin = identity.app_group_can_login === false;
    checks.appRuntimeGroupNoSuperuser = identity.app_group_is_superuser === false;
    checks.appRuntimeGroupNoCreatedb = identity.app_group_can_createdb === false;
    checks.appRuntimeGroupNoCreaterole = identity.app_group_can_createrole === false;
    checks.appRuntimeGroupNoInherit = identity.app_group_inherits === false;
    checks.appRuntimeGroupNoBypassRls = identity.app_group_bypasses_rls === false;
    checks.appRuntimeGroupHasNoParentMembership = identity.app_group_has_memberships === false;
    checks.appRuntimeGroupHasOnlyCandidateLogin = identity.app_group_member_count === 1;
  }

  if (!checks.candidateDatabaseIdentityMatches) {
    rejectWithPreMigrationRoleChecks(
      "APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH",
      checks,
      APPLICATION_PRE_MIGRATION_FAILURE_CATEGORIES.identityValidationFailed,
    );
  }

  if (
    !checks.loginRoleExists ||
    !checks.login ||
    !checks.noSuperuser ||
    !checks.noCreatedb ||
    !checks.noCreaterole ||
    !checks.inherit ||
    !checks.noBypassRls ||
    !checks.notOperatorUser ||
    !checks.notDatabaseOwner
  ) {
    rejectWithPreMigrationRoleChecks("APP_DATABASE_PREMIGRATION_LOGIN_REJECTED", checks);
  }

  if (
    !checks.appRuntimeGroupExists ||
    !checks.appRuntimeGroupNoLogin ||
    !checks.appRuntimeGroupNoSuperuser ||
    !checks.appRuntimeGroupNoCreatedb ||
    !checks.appRuntimeGroupNoCreaterole ||
    !checks.appRuntimeGroupNoInherit ||
    !checks.appRuntimeGroupNoBypassRls ||
    !checks.appRuntimeGroupHasNoParentMembership ||
    !checks.appRuntimeGroupHasOnlyCandidateLogin
  ) {
    rejectWithPreMigrationRoleChecks("APP_DATABASE_PREMIGRATION_GROUP_REJECTED", checks);
  }

  if (
    !checks.memberInAichmAppRuntime ||
    !checks.appRuntimeMembershipNoAdminOption ||
    !checks.noMembershipsOutsideAichmAppRuntime ||
    !checks.noAichmCrmOwnerOrMigratorMembership
  ) {
    rejectWithPreMigrationRoleChecks("APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED", checks);
  }

  return checks;
}

export async function verifyApplicationRuntimePool(
  pool: Pick<Pool, "query">,
  mode: ApplicationRuntimeMode,
  expectedIdentity?: ExpectedApplicationDatabaseIdentity,
): Promise<ApplicationRuntimeCheck> {
  if (mode.kind === "legacy") {
    return { status: "least_privilege_not_enabled" };
  }

  let rows: Array<{
    database_name: string;
    database_oid: string;
    is_superuser: boolean;
    can_login: boolean;
    can_createdb: boolean;
    can_createrole: boolean;
    inherits: boolean;
    bypass_rls: boolean;
    in_recovery: boolean;
    transaction_read_only: boolean;
    other_group_member: boolean;
    database_owner_member: boolean;
    app_group_member: boolean;
    app_group_exists: boolean;
    app_group_can_login: boolean | null;
    app_group_is_superuser: boolean | null;
    app_group_can_createdb: boolean | null;
    app_group_can_createrole: boolean | null;
    app_group_inherits: boolean | null;
    app_group_bypasses_rls: boolean | null;
    app_group_has_parent_membership: boolean;
    app_group_member_count: number;
    app_group_membership_admin_option: boolean;
    owner_group_member: boolean;
    migrator_group_member: boolean;
    core_privileges_ok: boolean;
    crm_assignment_read_only_ok: boolean;
    assignment_function_execute: boolean;
    schema_create: boolean;
  }>;
  try {
    ({ rows } = await pool.query(`
      SELECT current_database() AS database_name,d.oid::text AS database_oid,
        r.rolsuper AS is_superuser,
        r.rolcanlogin AS can_login,
        r.rolcreatedb AS can_createdb,
        r.rolcreaterole AS can_createrole,
        r.rolinherit AS inherits,
        r.rolbypassrls AS bypass_rls,
        pg_is_in_recovery() AS in_recovery,
        current_setting('transaction_read_only')::boolean AS transaction_read_only,
        EXISTS (
          SELECT 1 FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid=membership.roleid
          JOIN pg_roles member ON member.oid=membership.member
          WHERE member.rolname=current_user AND granted.rolname<>'aichm_app_runtime'
        ) AS other_group_member,
        pg_has_role(current_user,d.datdba,'MEMBER') AS database_owner_member,
        COALESCE((
          SELECT pg_has_role(current_user, candidate.oid, 'MEMBER')
          FROM pg_roles candidate WHERE candidate.rolname='aichm_app_runtime'
        ), false) AS app_group_member,
        app_group.oid IS NOT NULL AS app_group_exists,
        app_group.rolcanlogin AS app_group_can_login,
        app_group.rolsuper AS app_group_is_superuser,
        app_group.rolcreatedb AS app_group_can_createdb,
        app_group.rolcreaterole AS app_group_can_createrole,
        app_group.rolinherit AS app_group_inherits,
        app_group.rolbypassrls AS app_group_bypasses_rls,
        EXISTS (
          SELECT 1 FROM pg_auth_members parent_membership
          WHERE parent_membership.member=app_group.oid
        ) AS app_group_has_parent_membership,
        (SELECT count(*)::integer FROM pg_auth_members group_member
          WHERE group_member.roleid=app_group.oid) AS app_group_member_count,
        COALESCE(EXISTS (
          SELECT 1 FROM pg_auth_members membership
          WHERE membership.member=r.oid
            AND membership.roleid=app_group.oid
            AND membership.admin_option
        ), false) AS app_group_membership_admin_option,
        COALESCE((
          SELECT pg_has_role(current_user, candidate.oid, 'MEMBER')
          FROM pg_roles candidate WHERE candidate.rolname='aichm_crm_owner'
        ), false) AS owner_group_member,
        COALESCE((
          SELECT pg_has_role(current_user, candidate.oid, 'MEMBER')
          FROM pg_roles candidate WHERE candidate.rolname='aichm_crm_migrator'
        ), false) AS migrator_group_member,
        (
          to_regclass('public.sessions') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.sessions'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.sessions'),'INSERT') AND
          has_table_privilege(current_user,to_regclass('public.sessions'),'UPDATE') AND
          has_table_privilege(current_user,to_regclass('public.sessions'),'DELETE') AND
          to_regclass('public.inquiries') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.inquiries'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.inquiries'),'INSERT') AND
          has_table_privilege(current_user,to_regclass('public.inquiries'),'UPDATE') AND
          to_regclass('public.admissions_leads') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.admissions_leads'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.admissions_leads'),'INSERT') AND
          has_table_privilege(current_user,to_regclass('public.admissions_leads'),'UPDATE') AND
          to_regclass('public.lms_users') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.lms_users'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.lms_users'),'INSERT') AND
          has_table_privilege(current_user,to_regclass('public.lms_users'),'UPDATE') AND
          to_regclass('public.lms_user_roles') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.lms_user_roles'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.lms_user_roles'),'INSERT') AND
          NOT has_table_privilege(current_user,to_regclass('public.lms_user_roles'),'UPDATE') AND
          NOT has_table_privilege(current_user,to_regclass('public.lms_user_roles'),'DELETE') AND
          NOT has_table_privilege(current_user,to_regclass('public.lms_user_roles'),'TRUNCATE') AND
          to_regclass('public.lms_audit_logs') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.lms_audit_logs'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.lms_audit_logs'),'INSERT') AND
          to_regclass('public.admissions_crm_profiles') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.admissions_crm_profiles'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.admissions_crm_profiles'),'INSERT') AND
          has_table_privilege(current_user,to_regclass('public.admissions_crm_profiles'),'UPDATE') AND
          to_regclass('public.admissions_crm_activities') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.admissions_crm_activities'),'SELECT') AND
          has_table_privilege(current_user,to_regclass('public.admissions_crm_activities'),'INSERT')
        ) AS core_privileges_ok,
        (
          to_regclass('public.admissions_lead_assignments') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.admissions_lead_assignments'),'SELECT') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignments'),'INSERT') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignments'),'UPDATE') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignments'),'DELETE') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignments'),'TRUNCATE') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignments'),'REFERENCES') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignments'),'TRIGGER') AND
          to_regclass('public.admissions_lead_assignment_history') IS NOT NULL AND
          has_table_privilege(current_user,to_regclass('public.admissions_lead_assignment_history'),'SELECT') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignment_history'),'INSERT') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignment_history'),'UPDATE') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignment_history'),'DELETE') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignment_history'),'TRUNCATE') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignment_history'),'REFERENCES') AND
          NOT has_table_privilege(current_user,to_regclass('public.admissions_lead_assignment_history'),'TRIGGER')
        ) AS crm_assignment_read_only_ok,
        COALESCE(has_function_privilege(
          current_user,
          to_regprocedure('public.aichm_assign_crm_lead(uuid,integer,integer,text,uuid,integer)'),
          'EXECUTE'
        ), false) AS assignment_function_execute,
        has_schema_privilege(current_user,'public','CREATE') AS schema_create
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
      LEFT JOIN pg_roles app_group ON app_group.rolname='aichm_app_runtime'
      WHERE d.datname=current_database()
    `));
  } catch {
    reject("APP_DATABASE_RUNTIME_IDENTITY_UNAVAILABLE");
  }

  const identity = rows[0];
  if (
    !identity ||
    identity.database_name !== mode.expectedDatabase ||
    (expectedIdentity !== undefined &&
      (identity.database_name !== expectedIdentity.databaseName ||
       identity.database_oid !== expectedIdentity.databaseOid)) ||
    identity.is_superuser ||
    !identity.can_login ||
    identity.can_createdb ||
    identity.can_createrole ||
    !identity.inherits ||
    identity.bypass_rls ||
    identity.in_recovery ||
    identity.transaction_read_only ||
    identity.other_group_member ||
    identity.database_owner_member ||
    !identity.app_group_member ||
    !identity.app_group_exists ||
    identity.app_group_can_login !== false ||
    identity.app_group_is_superuser !== false ||
    identity.app_group_can_createdb !== false ||
    identity.app_group_can_createrole !== false ||
    identity.app_group_inherits !== false ||
    identity.app_group_bypasses_rls !== false ||
    identity.app_group_has_parent_membership ||
    identity.app_group_member_count !== 1 ||
    identity.app_group_membership_admin_option ||
    identity.owner_group_member ||
    identity.migrator_group_member
  ) reject("APP_DATABASE_RUNTIME_IDENTITY_REJECTED");
  if (
    !identity.core_privileges_ok ||
    !identity.crm_assignment_read_only_ok ||
    !identity.assignment_function_execute ||
    identity.schema_create
  ) reject("APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY");

  return { status: "least_privilege_verified" };
}
