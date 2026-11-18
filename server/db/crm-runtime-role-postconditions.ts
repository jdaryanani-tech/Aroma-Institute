import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

const ROLE_NAMES = ["aichm_crm_owner", "aichm_app_runtime", "aichm_crm_migrator"];
const CRM_TABLES = ["admissions_lead_assignments", "admissions_lead_assignment_history"];
const REQUIRED_RUNTIME_TABLES = [
  "sessions",
  "inquiries",
  "admissions_leads",
  "admissions_crm_profiles",
  "admissions_crm_activities",
  "lms_users",
  "lms_user_roles",
  "lms_audit_logs",
];
export const CRM_RUNTIME_TABLE_PRIVILEGES: Record<string, readonly string[]> = {
  sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  inquiries: ["SELECT", "INSERT", "UPDATE"],
  counselling_delivery_attempts: ["SELECT", "INSERT", "UPDATE"],
  admissions_leads: ["SELECT", "INSERT", "UPDATE"],
  admissions_crm_profiles: ["SELECT", "INSERT", "UPDATE"],
  admissions_crm_activities: ["SELECT", "INSERT"],
  admissions_lead_assignments: ["SELECT"],
  admissions_lead_assignment_history: ["SELECT"],
  admissions_lead_contact_preferences: ["SELECT", "INSERT", "UPDATE"],
  admissions_conversation_dispatch_grants: ["SELECT", "INSERT", "UPDATE"],
  admissions_registration_outbox: ["SELECT", "INSERT", "UPDATE"],
  admissions_vsl_playbacks: ["SELECT", "INSERT", "UPDATE"],
  admissions_vsl_events: ["SELECT", "INSERT"],
  admissions_capture_limits: ["SELECT", "INSERT", "UPDATE"],
  admissions_marketing_consent_events: ["SELECT", "INSERT", "UPDATE"],
  admissions_lead_touchpoints: ["SELECT", "INSERT"],
  admissions_meta_lead_links: ["SELECT", "INSERT"],
  admissions_meta_event_outbox: ["SELECT", "INSERT", "UPDATE"],
  admissions_legacy_lead_links: ["SELECT"],
  lms_users: ["SELECT", "INSERT", "UPDATE"],
  lms_user_roles: ["SELECT", "INSERT"],
  lms_courses: ["SELECT", "INSERT", "UPDATE"],
  lms_enrollments: ["SELECT", "INSERT", "UPDATE"],
  lms_modules: ["SELECT", "INSERT", "UPDATE"],
  lms_chapters: ["SELECT", "INSERT", "UPDATE"],
  lms_lessons: ["SELECT", "INSERT", "UPDATE"],
  lms_resources: ["SELECT", "INSERT"],
  lms_invitation_codes: ["SELECT", "INSERT", "UPDATE"],
  lms_invitation_redemptions: ["INSERT"],
  lms_lesson_progress: ["SELECT", "INSERT", "UPDATE"],
  lms_trainer_assignments: ["SELECT", "INSERT", "DELETE"],
  lms_assessments: ["SELECT", "INSERT", "UPDATE"],
  lms_assessment_versions: ["SELECT", "INSERT"],
  lms_assessment_questions: ["SELECT", "INSERT"],
  lms_assessment_options: ["SELECT", "INSERT"],
  lms_assessment_attempts: ["SELECT", "INSERT"],
  lms_live_sessions: ["SELECT", "INSERT", "UPDATE"],
  lms_certificates: ["SELECT", "INSERT", "UPDATE"],
  lms_notifications: ["SELECT", "INSERT", "UPDATE"],
  lms_audit_logs: ["SELECT", "INSERT"],
  lms_password_setup_tokens: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  lms_auth_rate_limits: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  calendar_resources: ["SELECT", "INSERT"],
  calendar_batches: ["SELECT", "INSERT"],
  calendar_batch_students: ["SELECT", "INSERT"],
  calendar_events: ["SELECT", "INSERT", "UPDATE"],
  calendar_integration_requests: ["SELECT", "INSERT"],
  calendar_event_attendees: ["SELECT", "INSERT", "DELETE"],
  staff_availability: ["SELECT", "INSERT"],
  availability_exceptions: ["SELECT", "INSERT"],
  notification_preferences: ["SELECT", "INSERT", "UPDATE"],
  push_subscriptions: ["SELECT", "INSERT", "UPDATE"],
  calendar_reminder_jobs: ["SELECT", "INSERT", "UPDATE"],
  notification_delivery_logs: ["SELECT", "INSERT"],
  calendar_activity: ["INSERT"],
};
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const CRM_FUNCTIONS = [
  "aichm_assign_crm_lead",
  "aichm_validate_lead_assignment",
  "aichm_validate_lead_assignment_history",
  "aichm_reject_lead_assignment_history_mutation",
  "aichm_require_assignment_history_for_change",
  "aichm_reject_lead_assignment_mutation",
];
const ASSIGNMENT_SIGNATURE = "uuid, integer, integer, text, uuid, integer";

function fail(code: string): never {
  throw new Error(code);
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function extractAssignmentFunctionBody(sql: string): string {
  const match = sql.match(
    /CREATE OR REPLACE FUNCTION\s+[\w.]*aichm_assign_crm_lead\s*\([\s\S]*?\)\s*RETURNS TABLE[\s\S]*?AS\s+\$function\$([\s\S]*?)\$function\$\s*;/i,
  );
  if (!match?.[1]) fail("CRM_RUNTIME_FUNCTION_SOURCE_MISSING");
  return normalizeBody(match[1]);
}

export async function assertCrmRuntimeRoleSeparationPostconditions(
  client: Queryable,
  schema: string,
  migration0016Sql: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail("CRM_RUNTIME_ROLE_SCHEMA_REJECTED");

  const { rows: roleRows } = await client.query<{
    role_name: string;
    can_login: boolean;
    superuser: boolean;
    createdb: boolean;
    createrole: boolean;
    inherit: boolean;
    bypass_rls: boolean;
  }>(`
    SELECT rolname AS role_name,rolcanlogin AS can_login,rolsuper AS superuser,
      rolcreatedb AS createdb,rolcreaterole AS createrole,rolinherit AS inherit,
      rolbypassrls AS bypass_rls
    FROM pg_roles WHERE rolname=ANY($1::text[])
  `, [ROLE_NAMES]);
  if (roleRows.length !== ROLE_NAMES.length || roleRows.some(role =>
    !ROLE_NAMES.includes(role.role_name) || role.can_login || role.superuser ||
    role.createdb || role.createrole || role.inherit || role.bypass_rls
  )) fail("CRM_RUNTIME_ROLES_DRIFTED");

  const { rows: memberships } = await client.query<{
    granted_role: string;
    member_role: string;
    member_login: boolean;
    member_superuser: boolean;
    member_createdb: boolean;
    member_createrole: boolean;
    member_inherit: boolean;
    member_bypass_rls: boolean;
    member_is_app_runtime: boolean;
    member_is_owner: boolean;
    member_is_migrator: boolean;
    member_has_other_groups: boolean;
    membership_admin_option: boolean;
  }>(`
    SELECT granted.rolname AS granted_role,member.rolname AS member_role,
      m.admin_option AS membership_admin_option,
      member.rolcanlogin AS member_login,member.rolsuper AS member_superuser,
      member.rolcreatedb AS member_createdb,member.rolcreaterole AS member_createrole,
      member.rolinherit AS member_inherit,member.rolbypassrls AS member_bypass_rls,
      COALESCE(pg_has_role(member.oid,app_role.oid,'MEMBER'),false) AS member_is_app_runtime,
      COALESCE(pg_has_role(member.oid,owner_role.oid,'MEMBER'),false) AS member_is_owner,
      COALESCE(pg_has_role(member.oid,migrator_role.oid,'MEMBER'),false) AS member_is_migrator,
      EXISTS (
        SELECT 1 FROM pg_auth_members nested
        JOIN pg_roles nested_granted ON nested_granted.oid=nested.roleid
        WHERE nested.member=member.oid
          AND nested_granted.rolname NOT IN ('aichm_app_runtime','aichm_crm_migrator')
      ) AS member_has_other_groups
    FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid=m.roleid
    JOIN pg_roles member ON member.oid=m.member
    LEFT JOIN pg_roles app_role ON app_role.rolname='aichm_app_runtime'
    LEFT JOIN pg_roles owner_role ON owner_role.rolname='aichm_crm_owner'
    LEFT JOIN pg_roles migrator_role ON migrator_role.rolname='aichm_crm_migrator'
    WHERE granted.rolname=ANY($1::text[]) OR member.rolname=ANY($1::text[])
  `, [ROLE_NAMES]);
  const ownerGrantCount = memberships.filter(row =>
    row.granted_role === "aichm_crm_owner" && row.member_role === "aichm_crm_migrator",
  ).length;
  const appMemberCount = memberships.filter(row => row.granted_role === "aichm_app_runtime").length;
  const migratorLoginCount = memberships.filter(row =>
    row.granted_role === "aichm_crm_migrator" && row.member_login,
  ).length;
  const invalidMembership = memberships.some(row =>
    row.membership_admin_option ||
    row.member_role === "aichm_app_runtime" ||
    (row.member_role === "aichm_crm_owner") ||
    (row.member_role === "aichm_crm_migrator" && row.granted_role !== "aichm_crm_owner") ||
    (row.granted_role === "aichm_crm_owner" && row.member_role !== "aichm_crm_migrator") ||
    (row.granted_role === "aichm_app_runtime" &&
      (!row.member_login || row.member_superuser || row.member_createdb || row.member_createrole ||
       !row.member_inherit || row.member_bypass_rls || row.member_is_owner || row.member_is_migrator ||
       !row.member_is_app_runtime || row.member_has_other_groups)) ||
    (row.granted_role === "aichm_crm_migrator" &&
      (!row.member_login || row.member_superuser || row.member_createdb || row.member_createrole ||
        row.member_bypass_rls || row.member_is_app_runtime || !row.member_is_owner ||
        !row.member_is_migrator || row.member_has_other_groups))
  );
  if (ownerGrantCount !== 1 || appMemberCount > 1 || migratorLoginCount > 1 || invalidMembership) {
    fail("CRM_RUNTIME_ROLE_MEMBERSHIP_DRIFTED");
  }

  const { rows: tableRows } = await client.query<{
    table_name: string;
    owner_name: string;
    privileges: Record<string, boolean>;
  }>(`
    SELECT c.relname AS table_name,owner.rolname AS owner_name,
      jsonb_build_object(
        'SELECT',has_table_privilege('aichm_app_runtime',c.oid,'SELECT'),
        'INSERT',has_table_privilege('aichm_app_runtime',c.oid,'INSERT'),
        'UPDATE',has_table_privilege('aichm_app_runtime',c.oid,'UPDATE'),
        'DELETE',has_table_privilege('aichm_app_runtime',c.oid,'DELETE'),
        'TRUNCATE',has_table_privilege('aichm_app_runtime',c.oid,'TRUNCATE'),
        'REFERENCES',has_table_privilege('aichm_app_runtime',c.oid,'REFERENCES'),
        'TRIGGER',has_table_privilege('aichm_app_runtime',c.oid,'TRIGGER')
      ) AS privileges
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles owner ON owner.oid=c.relowner
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f')
    ORDER BY c.relname
  `, [schema]);
  const presentTables = new Set(tableRows.map(row => row.table_name));
  const unexpectedPrivilege = tableRows.some(row => {
    const expected = CRM_RUNTIME_TABLE_PRIVILEGES[row.table_name] ?? [];
    return TABLE_PRIVILEGES.some(privilege =>
      row.privileges[privilege] !== expected.includes(privilege),
    );
  });
  if (
    REQUIRED_RUNTIME_TABLES.some(table => !presentTables.has(table)) ||
    CRM_TABLES.some(table => !presentTables.has(table)) ||
    tableRows.some(row =>
      CRM_TABLES.includes(row.table_name) && row.owner_name !== "aichm_crm_owner"
    ) ||
    unexpectedPrivilege
  ) fail("CRM_RUNTIME_ASSIGNMENT_TABLE_GRANTS_DRIFTED");

  const { rows: sequenceRows } = await client.query<{
    sequence_name: string;
    owner_table: string | null;
    column_name: string | null;
    usage: boolean;
    select: boolean;
    update: boolean;
  }>(`
    SELECT sequence.relname AS sequence_name,table_rel.relname AS owner_table,
      attribute.attname AS column_name,
      has_sequence_privilege('aichm_app_runtime',sequence.oid,'USAGE') AS usage,
      has_sequence_privilege('aichm_app_runtime',sequence.oid,'SELECT') AS select,
      has_sequence_privilege('aichm_app_runtime',sequence.oid,'UPDATE') AS update
    FROM pg_class sequence
    JOIN pg_namespace namespace ON namespace.oid=sequence.relnamespace
    LEFT JOIN pg_depend dependency ON dependency.objid=sequence.oid
      AND dependency.classid='pg_class'::regclass
      AND dependency.refclassid='pg_class'::regclass
      AND dependency.deptype IN ('a','i')
    LEFT JOIN pg_class table_rel ON table_rel.oid=dependency.refobjid
    LEFT JOIN pg_attribute attribute ON attribute.attrelid=table_rel.oid
      AND attribute.attnum=dependency.refobjsubid
    WHERE namespace.nspname=$1 AND sequence.relkind='S'
    ORDER BY table_rel.relname,sequence.relname
  `, [schema]);
  const sequenceDrift = sequenceRows.some(row => {
    const expectedUsage = row.owner_table !== null && row.column_name === "id" &&
      (CRM_RUNTIME_TABLE_PRIVILEGES[row.owner_table] ?? []).includes("INSERT");
    return row.usage !== expectedUsage || row.select || row.update;
  });
  if (sequenceDrift) fail("CRM_RUNTIME_SEQUENCE_PRIVILEGES_DRIFTED");

  const { rows: baseGrantRows } = await client.query<{
    table_name: string;
    owner_select: boolean;
    owner_update: boolean;
  }>(`
    SELECT expected.table_name,
      has_table_privilege('aichm_crm_owner',format('%I.%I',$1::text,expected.table_name),'SELECT') AS owner_select,
      has_table_privilege('aichm_crm_owner',format('%I.%I',$1::text,expected.table_name),'UPDATE') AS owner_update
    FROM unnest($2::text[]) AS expected(table_name)
  `, [schema, ["admissions_leads", "lms_users", "lms_user_roles"]]);
  if (baseGrantRows.length !== 3 || baseGrantRows.some(row => !row.owner_select || !row.owner_update)) {
    fail("CRM_RUNTIME_OWNER_BASE_TABLE_PRIVILEGES_DRIFTED");
  }

  const { rows: schemaRows } = await client.query<{
    app_usage: boolean;
    app_create: boolean;
    app_connect: boolean;
  }>(`
    SELECT has_schema_privilege('aichm_app_runtime',$1::text,'USAGE') AS app_usage,
      has_schema_privilege('aichm_app_runtime',$1::text,'CREATE') AS app_create,
      has_database_privilege('aichm_app_runtime',current_database(),'CONNECT') AS app_connect
  `, [schema]);
  if (!schemaRows[0]?.app_usage || schemaRows[0]?.app_create || !schemaRows[0]?.app_connect) {
    fail("CRM_RUNTIME_SCHEMA_PRIVILEGES_DRIFTED");
  }

  const { rows: functionRows } = await client.query<{
    function_name: string;
    owner_name: string;
    argument_types: string;
    language_name: string;
    result_type: string;
    security_definer: boolean;
    config: string[] | null;
    source: string;
    app_execute: boolean;
    public_execute: boolean;
  }>(`
    SELECT p.proname AS function_name,owner.rolname AS owner_name,
      oidvectortypes(p.proargtypes) AS argument_types,l.lanname AS language_name,
      pg_get_function_result(p.oid) AS result_type,p.prosecdef AS security_definer,
      p.proconfig AS config,p.prosrc AS source,
      has_function_privilege('aichm_app_runtime',p.oid,'EXECUTE') AS app_execute,
      EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles owner ON owner.oid=p.proowner
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[])
    ORDER BY p.proname
  `, [schema, CRM_FUNCTIONS]);
  if (functionRows.length !== CRM_FUNCTIONS.length) fail("CRM_RUNTIME_FUNCTIONS_DRIFTED");

  const assignmentBody = extractAssignmentFunctionBody(migration0016Sql);
  const expectedConfig = `search_path=pg_catalog, ${schema}`;
  const assignment = functionRows.find(row => row.function_name === "aichm_assign_crm_lead");
  if (!assignment || assignment.owner_name !== "aichm_crm_owner" ||
      assignment.argument_types !== ASSIGNMENT_SIGNATURE ||
      assignment.language_name !== "plpgsql" ||
      assignment.result_type !== "TABLE(result_lead_id uuid, result_assignee_user_id integer, result_version integer, result_request_id uuid, result_changed_at timestamp with time zone, result_replayed boolean)" ||
      !assignment.security_definer || !assignment.app_execute || assignment.public_execute ||
      assignment.config?.length !== 1 ||
      assignment.config[0]?.replaceAll('"', "").replace(/\s+/g, " ").trim() !== expectedConfig ||
      normalizeBody(assignment.source) !== assignmentBody
  ) fail("CRM_RUNTIME_ASSIGNMENT_FUNCTION_DRIFTED");

  const triggerFunctions = functionRows.filter(row => row.function_name !== "aichm_assign_crm_lead");
  if (triggerFunctions.some(row =>
    row.owner_name !== "aichm_crm_owner" || row.public_execute || row.app_execute
  )) {
    fail("CRM_RUNTIME_TRIGGER_FUNCTION_OWNERSHIP_DRIFTED");
  }
}

export async function assertCrmRuntimeAssignmentFunctionAbsent(client: Queryable): Promise<void> {
  const { rows: functions } = await client.query<{ proname: string }>(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='aichm_assign_crm_lead'
  `);
  if (functions.length) fail("CRM_RUNTIME_ROLE_UNTRACKED_STATE");
}
