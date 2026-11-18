import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CRM_RUNTIME_TABLE_PRIVILEGES,
  assertCrmRuntimeAssignmentFunctionAbsent,
  assertCrmRuntimeRoleSeparationPostconditions,
} from "./crm-runtime-role-postconditions";

const assignmentResult =
  "TABLE(result_lead_id uuid, result_assignee_user_id integer, result_version integer, result_request_id uuid, result_changed_at timestamp with time zone, result_replayed boolean)";

function assignmentBody(sql: string) {
  const match = sql.match(/AS \$function\$([\s\S]*?)\$function\$\s*;/i);
  assert.ok(match?.[1]);
  return match[1].trim();
}

function mockClient(overrides: Record<string, unknown> = {}) {
  const migrationSql = overrides.migrationSql as string;
  const body = assignmentBody(migrationSql);
  const privilegeNames = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  const makePrivileges = (allowed: string[]) =>
    Object.fromEntries(privilegeNames.map(name => [name, allowed.includes(name)]));
  const runtimeTableOperations: Record<string, string[]> = {
    sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    inquiries: ["SELECT", "INSERT", "UPDATE"],
    admissions_leads: ["SELECT", "INSERT", "UPDATE"],
    admissions_crm_profiles: ["SELECT", "INSERT", "UPDATE"],
    admissions_crm_activities: ["SELECT", "INSERT"],
    lms_users: ["SELECT", "INSERT", "UPDATE"],
    lms_user_roles: ["SELECT", "INSERT"],
    lms_audit_logs: ["SELECT", "INSERT"],
    admissions_lead_assignments: ["SELECT"],
    admissions_lead_assignment_history: ["SELECT"],
  };
  return {
    async query(sql: string) {
      if (sql.includes("FROM pg_roles WHERE rolname=ANY")) return { rows: [
        { role_name: "aichm_crm_owner", can_login: false, superuser: false, createdb: false, createrole: false, inherit: false, bypass_rls: false },
        { role_name: "aichm_app_runtime", can_login: false, superuser: false, createdb: false, createrole: false, inherit: false, bypass_rls: false },
        { role_name: "aichm_crm_migrator", can_login: false, superuser: false, createdb: false, createrole: false, inherit: false, bypass_rls: false },
      ] };
      if (sql.includes("FROM pg_auth_members")) return { rows: overrides.memberships ?? [
        {
          granted_role: "aichm_crm_owner", member_role: "aichm_crm_migrator",
          member_login: false, member_superuser: false, member_createdb: false,
          member_createrole: false, member_inherit: false, member_bypass_rls: false,
          membership_admin_option: false,
          member_is_app_runtime: false,
          member_is_owner: true, member_is_migrator: true, member_has_other_groups: false,
        },
        {
          granted_role: "aichm_app_runtime", member_role: "aichm_runtime_login",
          member_login: true, member_superuser: false, member_createdb: false,
          member_createrole: false, member_inherit: true, member_bypass_rls: false,
          membership_admin_option: false,
          member_is_app_runtime: true,
          member_is_owner: false, member_is_migrator: false, member_has_other_groups: false,
        },
      ] };
      if (sql.includes("FROM pg_class c JOIN pg_namespace") &&
          sql.includes("admissions_conversation_dispatch_grants")) {
        return { rows: [{ public_privileges: 0 }] };
      }
      if (sql.includes("FROM pg_class c JOIN pg_namespace")) return { rows: [
        ...Object.entries(runtimeTableOperations).map(([table_name, operations]) => ({
          table_name,
          owner_name: table_name.startsWith("admissions_lead_assignment_") ||
            table_name === "admissions_lead_assignments" ? "aichm_crm_owner" : "postgres",
          privileges: makePrivileges(operations),
        })),
      ] };
      if (sql.includes("WHERE r.rolname IN ('anon','authenticated','service_role'")) {
        return { rows: [] };
      }
      if (sql.includes("FROM pg_class sequence")) return { rows: [
        { sequence_name: "lms_users_id_seq", owner_table: "lms_users", column_name: "id", usage: true, select: false, update: false },
        { sequence_name: "unowned_sequence", owner_table: null, column_name: null, usage: false, select: false, update: false },
      ] };
      if (sql.includes("FROM unnest($2::text[])")) return { rows: [
        { table_name: "admissions_leads", owner_select: true, owner_update: true },
        { table_name: "lms_users", owner_select: true, owner_update: true },
        { table_name: "lms_user_roles", owner_select: true, owner_update: true },
      ] };
      if (sql.includes("has_schema_privilege")) return { rows: [
        { app_usage: true, app_create: false, app_connect: true },
      ] };
      if (sql.includes("FROM pg_proc p JOIN pg_namespace")) return { rows: [
        {
          function_name: "aichm_assign_crm_lead",
          owner_name: "aichm_crm_owner",
          argument_types: "uuid, integer, integer, text, uuid, integer",
          language_name: "plpgsql",
          result_type: assignmentResult,
          security_definer: true,
          config: ["search_path=pg_catalog, public"],
          source: body,
          app_execute: true,
          public_execute: false,
        },
        ...[
          "aichm_validate_lead_assignment",
          "aichm_validate_lead_assignment_history",
          "aichm_reject_lead_assignment_history_mutation",
          "aichm_require_assignment_history_for_change",
          "aichm_reject_lead_assignment_mutation",
        ].map(function_name => ({
          function_name, owner_name: "aichm_crm_owner", app_execute: false, public_execute: false,
        })),
      ] };
      if (sql.includes("FROM pg_roles WHERE rolname=ANY")) return { rows: [] };
      throw new Error("unexpected mock query");
    },
    override: overrides,
  };
}

test("runtime role postconditions accept the exact separated CRM ACL", async () => {
  const migrationSql = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  const client = mockClient({ migrationSql });
  await assertCrmRuntimeRoleSeparationPostconditions(client as never, "public", migrationSql);
});

test("role migration can prepare ACLs before the app login is provisioned", async () => {
  const migrationSql = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  const client = mockClient({
    migrationSql,
    memberships: [{
      granted_role: "aichm_crm_owner", member_role: "aichm_crm_migrator",
      member_login: false, member_superuser: false, member_createdb: false,
      member_createrole: false, member_inherit: false, member_bypass_rls: false,
      membership_admin_option: false,
      member_is_app_runtime: false, member_is_owner: false, member_is_migrator: true,
      member_has_other_groups: false,
    }],
  });
  await assertCrmRuntimeRoleSeparationPostconditions(client as never, "public", migrationSql);
});

test("a dedicated migrator login may reach the owner only through migrator membership", async () => {
  const migrationSql = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  const memberships = [
    {
      granted_role: "aichm_crm_owner", member_role: "aichm_crm_migrator",
      member_login: false, member_superuser: false, member_createdb: false,
      member_createrole: false, member_inherit: false, member_bypass_rls: false,
      member_is_app_runtime: false, member_is_owner: true, member_is_migrator: true,
      member_has_other_groups: false,
    },
    {
      granted_role: "aichm_app_runtime", member_role: "aichm_runtime_login",
      member_login: true, member_superuser: false, member_createdb: false,
      member_createrole: false, member_inherit: true, member_bypass_rls: false,
      membership_admin_option: false,
      member_is_app_runtime: true, member_is_owner: false, member_is_migrator: false,
      member_has_other_groups: false,
    },
    {
      granted_role: "aichm_crm_migrator", member_role: "aichm_migrator_login",
      member_login: true, member_superuser: false, member_createdb: false,
      member_createrole: false, member_inherit: true, member_bypass_rls: false,
      membership_admin_option: false,
      member_is_app_runtime: false, member_is_owner: true, member_is_migrator: true,
      member_has_other_groups: false,
    },
  ];
  const client = mockClient({ migrationSql, memberships });
  await assertCrmRuntimeRoleSeparationPostconditions(client as never, "public", migrationSql);
});

test("runtime role postconditions reject role-membership admin option", async () => {
  const migrationSql = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  const client = mockClient({
    migrationSql,
    memberships: [
      {
        granted_role: "aichm_crm_owner", member_role: "aichm_crm_migrator",
        member_login: false, member_superuser: false, member_createdb: false,
        member_createrole: false, member_inherit: false, member_bypass_rls: false,
        member_is_app_runtime: false, member_is_owner: true, member_is_migrator: true,
        member_has_other_groups: false, membership_admin_option: false,
      },
      {
        granted_role: "aichm_app_runtime", member_role: "aichm_runtime_login",
        member_login: true, member_superuser: false, member_createdb: false,
        member_createrole: false, member_inherit: true, member_bypass_rls: false,
        member_is_app_runtime: true, member_is_owner: false, member_is_migrator: false,
        member_has_other_groups: false, membership_admin_option: true,
      },
    ],
  });
  await assert.rejects(
    assertCrmRuntimeRoleSeparationPostconditions(client as never, "public", migrationSql),
    /CRM_RUNTIME_ROLE_MEMBERSHIP_DRIFTED/,
  );
});

test("forward migration table grants match the reviewed runtime privilege matrix", async () => {
  const migrationSql = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  const block = migrationSql.match(/SELECT \* FROM \(VALUES([\s\S]*?)\) AS grants\(table_name, privileges\)/);
  assert.ok(block);
  const actual = Array.from(block[1]!.matchAll(/\('([^']+)','([^']+)'\)/g))
    .map(([, table, privilegeText]) => [table, privilegeText!.split(/,\s*/) as string[]])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  const expected = Object.entries(CRM_RUNTIME_TABLE_PRIVILEGES)
    .filter(([table]) => table !== "admissions_conversation_dispatch_grants")
    .map(([table, privileges]) => [table, [...privileges]] as [string, string[]])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, expected);
  const dispatchMigration = await readFile("migrations/0019_avni_dispatch_grants.sql", "utf8");
  assert.match(dispatchMigration,/REVOKE ALL ON TABLE admissions_conversation_dispatch_grants FROM PUBLIC/);
  assert.doesNotMatch(dispatchMigration,/GRANT\s+SELECT.*admissions_conversation_dispatch_grants/i);
  const dispatchAclMigration = await readFile("migrations/0020_avni_dispatch_authorization_fence.sql", "utf8");
  assert.match(
    dispatchAclMigration,
    /GRANT SELECT,\s*INSERT,\s*UPDATE\s+ON TABLE public\.admissions_conversation_dispatch_grants TO aichm_app_runtime/,
  );
});

test("runtime role postconditions fail closed if the app can mutate assignment history", async () => {
  const migrationSql = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  const client = mockClient({ migrationSql });
  const original = client.query.bind(client);
  client.query = async (sql: string) => {
    const result = await original(sql);
    if (sql.includes("FROM pg_class c JOIN pg_namespace")) {
      const history = (result.rows as Array<Record<string, unknown>>)
        .find(row => row.table_name === "admissions_lead_assignment_history")!;
      (history.privileges as Record<string, boolean>).UPDATE = true;
    }
    return result;
  };
  await assert.rejects(
    assertCrmRuntimeRoleSeparationPostconditions(client as never, "public", migrationSql),
    /CRM_RUNTIME_ASSIGNMENT_TABLE_GRANTS_DRIFTED/,
  );
});

test("runtime role postconditions fail closed when a runtime sequence grant is broader than USAGE", async () => {
  const migrationSql = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  const client = mockClient({ migrationSql });
  const original = client.query.bind(client);
  client.query = async (sql: string) => {
    const result = await original(sql);
    if (sql.includes("FROM pg_class sequence")) {
      (result.rows as Array<Record<string, unknown>>)[0]!.select = true;
    }
    return result;
  };
  await assert.rejects(
    assertCrmRuntimeRoleSeparationPostconditions(client as never, "public", migrationSql),
    /CRM_RUNTIME_SEQUENCE_PRIVILEGES_DRIFTED/,
  );
});

test("untracked role or function state blocks the forward migration", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("FROM pg_proc")) return { rows: [{ proname: "aichm_assign_crm_lead" }] };
      throw new Error("unexpected mock query");
    },
  };
  await assert.rejects(assertCrmRuntimeAssignmentFunctionAbsent(client as never), /CRM_RUNTIME_ROLE_UNTRACKED_STATE/);
});
