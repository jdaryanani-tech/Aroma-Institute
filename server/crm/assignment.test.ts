import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  assignCrmLead,
  crmAssignmentUpdateSchema,
  type CrmAssignmentUpdate,
} from "./assignment";
import type { CrmPrincipal } from "./authorization";
import { validateCrmPersistenceTestTargetConfiguration } from "./persistence-test-target";

type FakeOptions = {
  result?: Partial<{
    result_lead_id: string;
    result_assignee_user_id: number | null;
    result_version: number;
    result_request_id: string;
    result_changed_at: Date | string;
    result_replayed: boolean;
  }>;
  errorCode?: string;
};

function fakePool(options: FakeOptions = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, values });
    if (normalized.startsWith("SELECT * FROM public.aichm_assign_crm_lead")) {
      if (options.errorCode) {
        throw Object.assign(new Error("simulated database result"), { code: options.errorCode });
      }
      return {
        rows: [{
          result_lead_id: leadId,
          result_assignee_user_id: values[2] as number | null,
          result_version: Number(values[5]) + 1,
          result_request_id: values[4] as string,
          result_changed_at: new Date("2026-01-01T00:00:00Z"),
          result_replayed: false,
          ...options.result,
        }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith("INSERT INTO lms_audit_logs")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected SQL in assignment test: ${normalized}`);
  };
  const pool = {
    query,
  };
  return { pool: pool as unknown as Pick<Pool, "query">, calls };
}

const admin: CrmPrincipal = { id: 1, roles: ["admin"] };
const leadId = "9e95bfc0-a426-43fa-8e64-07c46d79691a";

function input(expectedVersion: number, assigneeUserId: number | null): CrmAssignmentUpdate {
  return {
    expectedVersion,
    assigneeUserId,
    reason: "Reviewed assignment change",
    requestId: "7e5be93c-54c0-4c9e-8700-0409d8bfe6c9",
  };
}

test("assignment mutation is one atomic owner-controlled function call", async () => {
  const { pool, calls } = fakePool();
  const result = await assignCrmLead(pool, leadId, input(0, 4), admin);
  assert.equal(result.version, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /public\.aichm_assign_crm_lead/);
  assert.deepEqual(calls[0].values, [leadId, admin.id, 4, "Reviewed assignment change", input(0, 4).requestId, 0]);
});

test("reassignment, unassignment, and replay use the function's single atomic result", async () => {
  const reassigned = fakePool({ result: { result_version: 2, result_assignee_user_id: 6 } });
  const reassignResult = await assignCrmLead(reassigned.pool, leadId, input(1, 6), admin);
  assert.equal(reassignResult.version, 2);
  assert.equal(reassigned.calls[0].values[2], 6);
  assert.equal(reassigned.calls.length, 1);

  const unassigned = fakePool({ result: { result_version: 3, result_assignee_user_id: null } });
  const unassignResult = await assignCrmLead(unassigned.pool, leadId, input(2, null), admin);
  assert.equal(unassignResult.assigneeUserId, null);
  assert.equal(unassignResult.version, 3);
  assert.equal(unassigned.calls[0].values[2], null);

  const replayed = fakePool({ result: { result_replayed: true, result_version: 1 } });
  assert.equal((await assignCrmLead(replayed.pool, leadId, input(0, 4), admin)).replayed, true);
  assert.equal(replayed.calls.length, 1);
});

test("database version and request-id conflicts fail without direct assignment DML", async () => {
  const stale = fakePool({ errorCode: "P0003" });
  await assert.rejects(assignCrmLead(stale.pool, leadId, input(1, 6), admin), /assignment changed or this request ID/);
  assert.equal(stale.calls.length, 1);
  assert.doesNotMatch(stale.calls[0].sql, /INSERT INTO admissions_lead_assignments|UPDATE admissions_lead_assignments/);
});

test("invalid actor or assignee fails and records a denial after the function statement aborts", async () => {
  const denied = fakePool({ errorCode: "42501" });
  await assert.rejects(assignCrmLead(denied.pool, leadId, input(0, 2), admin), /assignment request is not authorized/);
  assert.equal(denied.calls.length, 2);
  assert.match(denied.calls[0].sql, /aichm_assign_crm_lead/);
  assert.match(denied.calls[1].sql, /INSERT INTO lms_audit_logs/);
});

test("unchanged assignment state remains a validation error", async () => {
  const unchanged = fakePool({ errorCode: "P0004" });
  await assert.rejects(assignCrmLead(unchanged.pool, leadId, input(0, null), admin), /Choose a different assignee/);
});

test("an idempotent replay does not mutate assignment or history", async () => {
  const { pool, calls } = fakePool({ result: { result_replayed: true } });
  const result = await assignCrmLead(pool, leadId, input(0, 4), admin);
  assert.equal(result.replayed, true);
  assert.equal(calls.length, 1);
});

test("the CRM assignment SQL contains deferred pair enforcement and destructive guards", async () => {
  const { readFile } = await import("node:fs/promises");
  const invariants = await readFile("migrations/0015_crm_assignment_audit_invariants.sql", "utf8");
  const roles = await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8");
  assert.match(invariants, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(invariants, /version must increase by exactly one/);
  assert.match(invariants, /matching history event in the same transaction/);
  assert.match(invariants, /BEFORE DELETE ON public\.admissions_lead_assignments/);
  assert.match(invariants, /BEFORE TRUNCATE ON public\.admissions_lead_assignments/);
  assert.match(roles, /SECURITY DEFINER/);
  assert.match(roles, /SET search_path = pg_catalog, public/);
  assert.match(roles, /aichm_app_runtime/);
  assert.match(roles, /REVOKE ALL ON TABLE public\.admissions_lead_assignments/);
  assert.match(roles, /pg_advisory_xact_lock/);
  assert.match(roles, /p_actor_user_id/);
  assert.match(roles, /p_expected_version/);
});

test("CRM persistence test target requires explicit opt-in and a verified ephemeral loopback database", () => {
  const dedicatedName = "aichm_test_0123456789abcdef0123456789abcdef";
  const validEnvironment = {
    NODE_ENV: "test",
    CRM_TEST_DB_WRITE_APPROVED: "ISOLATED_EPHEMERAL_POSTGRES_ONLY",
    CRM_TEST_DATABASE_NAME: dedicatedName,
    AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
    AICHM_DEVELOPMENT_DATABASE_URL: `postgresql://postgres@127.0.0.1:55432/${dedicatedName}`,
    CRM_TEST_EPHEMERAL_ROOT: "/dev/shm/aichm-crm-test-example",
    CRM_TEST_EPHEMERAL_PROOF: "/dev/shm/aichm-crm-test-example/identity.json",
    DATABASE_URL: "postgresql://ignored:ignored@production.invalid/app",
  };

  assert.equal(validateCrmPersistenceTestTargetConfiguration(validEnvironment).database, dedicatedName);
  assert.throws(() => validateCrmPersistenceTestTargetConfiguration({
    ...validEnvironment,
    CRM_TEST_DB_WRITE_APPROVED: undefined,
  }), /explicit disposable-database approval/);
  assert.throws(() => validateCrmPersistenceTestTargetConfiguration({
    ...validEnvironment,
    CRM_TEST_DATABASE_NAME: "aichm_test_other0123456789",
  }), /verified ephemeral loopback PostgreSQL instance/);
  assert.throws(() => validateCrmPersistenceTestTargetConfiguration({
    ...validEnvironment,
    AICHM_DEVELOPMENT_DATABASE_URL: "postgresql://postgres@remote.invalid/aichm_test_0123456789abcdef0123456789abcdef",
  }), /NON_LOOPBACK|loopback|target/i);
  assert.throws(() => validateCrmPersistenceTestTargetConfiguration({
    NODE_ENV: "test",
    CRM_TEST_DB_WRITE_APPROVED: "ISOLATED_EPHEMERAL_POSTGRES_ONLY",
    DATABASE_URL: validEnvironment.DATABASE_URL,
  }), /intent|database URL|development database URL/i);
  assert.throws(() => validateCrmPersistenceTestTargetConfiguration({
    ...validEnvironment,
    CRM_TEST_EPHEMERAL_PROOF: undefined,
  }), /verified ephemeral loopback PostgreSQL instance/);
});

test("assignment endpoint payload cannot supply its actor identity", async () => {
  assert.throws(
    () => crmAssignmentUpdateSchema.parse({ ...input(0, 4), actorUserId: 999 }),
    /Unrecognized key/,
  );
  const routeSource = await (await import("node:fs/promises")).readFile("server/crm/routes.ts", "utf8");
  assert.match(routeSource, /assignCrmLead\([\s\S]*?req\.lmsUser as CrmPrincipal/);
});
