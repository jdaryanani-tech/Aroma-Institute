import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { assignCrmLead, type CrmAssignmentUpdate } from "./assignment";
import type { CrmPrincipal } from "./authorization";
import { validateCrmPersistenceTestTarget } from "./persistence-test-target";

type FakeOptions = {
  current?: { lead_id: string; assignee_user_id: number | null; assigned_by: number; version: number };
  priorRequest?: Record<string, unknown>;
  actorValid?: boolean;
  targetValid?: boolean;
  failHistory?: boolean;
};

function fakePool(options: FakeOptions = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT * FROM admissions_lead_assignment_history WHERE request_id")) {
        return { rows: options.priorRequest ? [options.priorRequest] : [], rowCount: options.priorRequest ? 1 : 0 };
      }
      if (normalized.includes("WHERE u.id=$1 AND u.is_active AND r.role::text='admin'")) {
        return { rows: options.actorValid === false ? [] : [{}], rowCount: options.actorValid === false ? 0 : 1 };
      }
      if (normalized.startsWith("SELECT id FROM admissions_leads")) return { rows: [{ id: values[0] }], rowCount: 1 };
      if (normalized.startsWith("SELECT * FROM admissions_lead_assignments")) {
        return { rows: options.current ? [options.current] : [], rowCount: options.current ? 1 : 0 };
      }
      if (normalized.includes("r.role::text='admissions'")) {
        return { rows: options.targetValid === false ? [] : [{}], rowCount: options.targetValid === false ? 0 : 1 };
      }
      if (normalized.startsWith("INSERT INTO admissions_lead_assignments") ||
          normalized.startsWith("UPDATE admissions_lead_assignments")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO admissions_lead_assignment_history")) {
        if (options.failHistory) throw new Error("simulated history insert failure");
        return {
          rows: [{
            request_id: values[5],
            changed_at: new Date("2026-01-01T00:00:00Z"),
            assignment_version: values[6],
            new_assignee_user_id: values[2],
          }],
          rowCount: 1,
        };
      }
      if (normalized.startsWith("INSERT INTO lms_audit_logs")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in assignment test: ${normalized}`);
    },
    release() {
      calls.push({ sql: "RELEASE", values: [] });
    },
  };
  const pool = {
    connect: async () => client,
    query: client.query,
  };
  return { pool: pool as unknown as Pick<Pool, "connect" | "query">, calls };
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

test("assignment insert and matching history share one transaction", async () => {
  const { pool, calls } = fakePool();
  const result = await assignCrmLead(pool, leadId, input(0, 4), admin);
  const sql = calls.map(call => call.sql);
  assert.equal(result.version, 1);
  assert.ok(sql.indexOf("BEGIN") < sql.findIndex(statement => statement.startsWith("INSERT INTO admissions_lead_assignments")));
  assert.ok(sql.findIndex(statement => statement.startsWith("INSERT INTO admissions_lead_assignments")) <
    sql.findIndex(statement => statement.startsWith("INSERT INTO admissions_lead_assignment_history")));
  assert.ok(sql.indexOf("COMMIT") > sql.findIndex(statement => statement.startsWith("INSERT INTO admissions_lead_assignment_history")));
});

test("reassignment and unassignment increment exactly one version", async () => {
  const first = fakePool({
    current: { lead_id: leadId, assignee_user_id: 4, assigned_by: 1, version: 1 },
  });
  const reassigned = await assignCrmLead(first.pool, leadId, input(1, 6), admin);
  assert.equal(reassigned.version, 2);
  assert.ok(first.calls.some(call => call.sql.startsWith("UPDATE admissions_lead_assignments") &&
    call.sql.includes("version=version+1") && call.values[3] === 1));
  assert.ok(first.calls.some(call => call.sql.startsWith("INSERT INTO admissions_lead_assignment_history") &&
    call.values[1] === 4 && call.values[2] === 6 && call.values[6] === 2));

  const second = fakePool({
    current: { lead_id: leadId, assignee_user_id: 6, assigned_by: 1, version: 2 },
  });
  const unassigned = await assignCrmLead(second.pool, leadId, input(2, null), admin);
  assert.equal(unassigned.assigneeUserId, null);
  assert.equal(unassigned.version, 3);
  assert.ok(second.calls.some(call => call.sql.startsWith("INSERT INTO admissions_lead_assignment_history") &&
    call.values[1] === 6 && call.values[2] === null && call.values[6] === 3));
});

test("stale versions and invalid active admissions targets roll back", async () => {
  const stale = fakePool({
    current: { lead_id: leadId, assignee_user_id: 4, assigned_by: 1, version: 2 },
  });
  await assert.rejects(assignCrmLead(stale.pool, leadId, input(1, 6), admin), /assignment changed/);
  assert.ok(stale.calls.some(call => call.sql === "ROLLBACK"));
  assert.ok(!stale.calls.some(call => call.sql.startsWith("UPDATE admissions_lead_assignments")));

  const invalidTarget = fakePool({ targetValid: false });
  await assert.rejects(assignCrmLead(invalidTarget.pool, leadId, input(0, 2), admin), /active admissions user/);
  assert.ok(invalidTarget.calls.some(call => call.sql === "ROLLBACK"));
});

test("a principal whose database admin role was revoked cannot assign", async () => {
  const revokedAdmin = fakePool({ actorValid: false });
  await assert.rejects(assignCrmLead(revokedAdmin.pool, leadId, input(0, 4), admin), /Administrator access is required/);
  assert.ok(revokedAdmin.calls.some(call => call.sql === "ROLLBACK"));
  assert.ok(!revokedAdmin.calls.some(call => call.sql.startsWith("INSERT INTO admissions_lead_assignments")));
});

test("history insertion failure rolls back the assignment mutation", async () => {
  const { pool, calls } = fakePool({ failHistory: true });
  await assert.rejects(assignCrmLead(pool, leadId, input(0, 4), admin), /simulated history insert failure/);
  assert.ok(calls.some(call => call.sql.startsWith("INSERT INTO admissions_lead_assignments")));
  assert.ok(calls.some(call => call.sql === "ROLLBACK"));
  assert.ok(!calls.some(call => call.sql === "COMMIT"));
});

test("an idempotent replay does not mutate assignment or history", async () => {
  const event = {
    lead_id: leadId,
    actor_user_id: 1,
    new_assignee_user_id: 4,
    reason: "Reviewed assignment change",
    assignment_version: 1,
    request_id: input(0, 4).requestId,
    changed_at: new Date("2026-01-01T00:00:00Z"),
  };
  const { pool, calls } = fakePool({ priorRequest: event });
  const result = await assignCrmLead(pool, leadId, input(0, 4), admin);
  assert.equal(result.replayed, true);
  assert.ok(calls.some(call => call.sql === "COMMIT"));
  assert.ok(!calls.some(call => call.sql.startsWith("INSERT INTO admissions_lead_assignments")));
  assert.ok(!calls.some(call => call.sql.startsWith("INSERT INTO admissions_lead_assignment_history")));
});

test("the CRM assignment SQL contains deferred pair enforcement and destructive guards", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile("migrations/0015_crm_assignment_audit_invariants.sql", "utf8");
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /version must increase by exactly one/);
  assert.match(sql, /matching history event in the same transaction/);
  assert.match(sql, /BEFORE DELETE ON public\.admissions_lead_assignments/);
  assert.match(sql, /BEFORE TRUNCATE ON public\.admissions_lead_assignments/);
  assert.match(sql, /r\.role::text = 'admissions'/);
  assert.match(sql, /admin_role\.role::text = 'admin'/);
});

test("CRM persistence test target requires explicit opt-in and a dedicated loopback database", () => {
  const dedicatedName = "aichm_test_0123456789abcdef";
  const validEnvironment = {
    NODE_ENV: "test",
    CRM_TEST_DB_WRITE_APPROVED: "TEMPORARY_DEVELOPMENT_SCHEMA_ONLY",
    CRM_TEST_DATABASE_NAME: dedicatedName,
    AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
    AICHM_DEVELOPMENT_DATABASE_URL: `postgresql://test_user:local_only@127.0.0.1:55432/${dedicatedName}`,
    DATABASE_URL: "postgresql://ignored:ignored@production.invalid/app",
  };

  assert.equal(validateCrmPersistenceTestTarget(validEnvironment).database, dedicatedName);
  assert.throws(() => validateCrmPersistenceTestTarget({
    ...validEnvironment,
    CRM_TEST_DB_WRITE_APPROVED: undefined,
  }), /explicit disposable-database approval/);
  assert.throws(() => validateCrmPersistenceTestTarget({
    ...validEnvironment,
    CRM_TEST_DATABASE_NAME: "aichm_test_other0123456789",
  }), /named, dedicated loopback test database/);
  assert.throws(() => validateCrmPersistenceTestTarget({
    ...validEnvironment,
    AICHM_DEVELOPMENT_DATABASE_URL: "postgresql://test_user:secret@remote.invalid/aichm_test_0123456789abcdef",
  }), /NON_LOOPBACK|loopback|target/i);
  assert.throws(() => validateCrmPersistenceTestTarget({
    NODE_ENV: "test",
    CRM_TEST_DB_WRITE_APPROVED: "TEMPORARY_DEVELOPMENT_SCHEMA_ONLY",
    DATABASE_URL: validEnvironment.DATABASE_URL,
  }), /intent|database URL|development database URL/i);
});
