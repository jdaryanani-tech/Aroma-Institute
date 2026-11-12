import type { Pool, PoolConfig } from "pg";
import { isIP } from "node:net";

export const APP_DATABASE_URL_ENV = "AICHM_APP_DATABASE_URL";
const PLATFORM_DATABASE_URL_ENV = "DATABASE_URL";

type Endpoint = {
  host: string;
  port: number;
  database: string;
  queryPolicy: string[];
};

export type ApplicationRuntimeMode =
  | { kind: "legacy"; connectionString: string }
  | { kind: "least_privilege"; connectionString: string; expectedDatabase: string };

const APPLICATION_RUNTIME_FAILURE_CODES = new Set([
  "APP_DATABASE_URL_INVALID",
  "APP_DATABASE_PLATFORM_REFERENCE_REQUIRED",
  "APP_DATABASE_PLATFORM_REFERENCE_INVALID",
  "APP_DATABASE_ENDPOINT_NOT_INTERNAL",
  "APP_DATABASE_ENDPOINT_MISMATCH",
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

function isPrivateDatabaseHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (normalized === "helium") return true;
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  if (isIP(normalized) !== 0) return false;
  return normalized.endsWith(".internal");
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
    queryPolicy: Array.from(url.searchParams.entries())
      .map(([key, value]) => `${key}=${value}`)
      .sort(),
    user,
    password,
  };
}

export function resolveApplicationRuntimeMode(
  environment: Record<string, string | undefined>,
): ApplicationRuntimeMode {
  const explicit = environment[APP_DATABASE_URL_ENV];
  if (explicit === undefined) {
    const legacy = environment[PLATFORM_DATABASE_URL_ENV];
    if (!legacy?.trim()) reject("DATABASE_URL_REQUIRED");
    return { kind: "legacy", connectionString: legacy };
  }

  const app = endpointFrom(explicit, "app");
  const platform = endpointFrom(environment[PLATFORM_DATABASE_URL_ENV], "platform");
  if (!isPrivateDatabaseHost(app.host) || !isPrivateDatabaseHost(platform.host)) {
    reject("APP_DATABASE_ENDPOINT_NOT_INTERNAL");
  }
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
    return isPrivateDatabaseHost(application.host) &&
      isPrivateDatabaseHost(reference.host) &&
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

/**
 * Pre-migration probe: deliberately checks only the pinned database and
 * pre-provisioned role boundary. It does not require CRM assignment objects.
 */
export async function verifyApplicationPreMigrationPool(
  pool: Pick<Pool, "query">,
  expectedIdentity: ExpectedPreMigrationApplicationIdentity,
): Promise<void> {
  type IdentityRow = {
    database_name: string;
    database_oid: string;
    login_role: string;
    in_recovery: boolean;
    transaction_read_only: boolean;
    login_can_login: boolean;
    login_is_superuser: boolean;
    login_can_createdb: boolean;
    login_can_createrole: boolean;
    login_inherits: boolean;
    login_bypasses_rls: boolean;
    database_owner_member: boolean;
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
    app_group_admin_option: boolean;
    owner_group_member: boolean;
    migrator_group_member: boolean;
    direct_memberships: string[];
  };

  let identity: IdentityRow | undefined;
  try {
    ({ rows: [identity] } = await pool.query<IdentityRow>(`
      SELECT current_database() AS database_name,
        d.oid::text AS database_oid,
        current_user AS login_role,
        pg_is_in_recovery() AS in_recovery,
        current_setting('transaction_read_only')::boolean AS transaction_read_only,
        login.rolcanlogin AS login_can_login,
        login.rolsuper AS login_is_superuser,
        login.rolcreatedb AS login_can_createdb,
        login.rolcreaterole AS login_can_createrole,
        login.rolinherit AS login_inherits,
        login.rolbypassrls AS login_bypasses_rls,
        (login.oid=d.datdba OR pg_has_role(login.oid,d.datdba,'MEMBER')) AS database_owner_member,
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
        COALESCE((
          SELECT membership.admin_option
          FROM pg_auth_members membership
          WHERE membership.member=login.oid AND membership.roleid=app_group.oid
        ),false) AS app_group_admin_option,
        COALESCE(pg_has_role(login.oid,owner_group.oid,'MEMBER'),false) AS owner_group_member,
        COALESCE(pg_has_role(login.oid,migrator_group.oid,'MEMBER'),false) AS migrator_group_member,
        COALESCE((
          SELECT array_agg(granted.rolname::text ORDER BY granted.rolname)
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid=membership.roleid
          WHERE membership.member=login.oid
        ), ARRAY[]::text[]) AS direct_memberships
      FROM pg_database d
      JOIN pg_roles login ON login.rolname=current_user
      LEFT JOIN pg_roles app_group ON app_group.rolname='aichm_app_runtime'
      LEFT JOIN pg_roles owner_group ON owner_group.rolname='aichm_crm_owner'
      LEFT JOIN pg_roles migrator_group ON migrator_group.rolname='aichm_crm_migrator'
      WHERE d.datname=current_database()
    `));
  } catch {
    reject("APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE");
  }

  if (
    !identity ||
    typeof identity.database_name !== "string" ||
    typeof identity.database_oid !== "string" ||
    typeof identity.in_recovery !== "boolean" ||
    typeof identity.transaction_read_only !== "boolean" ||
    identity.database_name !== expectedIdentity.databaseName ||
    identity.database_oid !== expectedIdentity.databaseOid ||
    identity.in_recovery ||
    identity.transaction_read_only
  ) reject("APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH");

  if (
    identity.login_role === "postgres" ||
    typeof identity.login_role !== "string" ||
    identity.login_can_login !== true ||
    identity.login_is_superuser !== false ||
    identity.login_can_createdb !== false ||
    identity.login_can_createrole !== false ||
    identity.login_inherits !== true ||
    identity.login_bypasses_rls !== false ||
    identity.database_owner_member !== false
  ) reject("APP_DATABASE_PREMIGRATION_LOGIN_REJECTED");

  if (
    identity.app_group_exists !== true ||
    identity.app_group_can_login !== false ||
    identity.app_group_is_superuser !== false ||
    identity.app_group_can_createdb !== false ||
    identity.app_group_can_createrole !== false ||
    identity.app_group_inherits !== false ||
    identity.app_group_bypasses_rls !== false ||
    identity.app_group_has_memberships !== false ||
    identity.app_group_member_count !== 1
  ) reject("APP_DATABASE_PREMIGRATION_GROUP_REJECTED");

  if (
    identity.app_group_is_member !== true ||
    identity.app_group_admin_option !== false ||
    identity.owner_group_member !== false ||
    identity.migrator_group_member !== false ||
    !Array.isArray(identity.direct_memberships) ||
    identity.direct_memberships.length !== 1 ||
    identity.direct_memberships[0] !== "aichm_app_runtime"
  ) reject("APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED");
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
    other_group_member: boolean;
    database_owner_member: boolean;
    app_group_member: boolean;
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
    identity.other_group_member ||
    identity.database_owner_member ||
    !identity.app_group_member ||
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
