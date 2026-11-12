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

function reject(code: string): never {
  throw new Error(code);
}

function isPrivateDatabaseHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
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
