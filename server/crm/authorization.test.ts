import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ADMISSIONS_MANUAL_CRM_STAGES } from "@shared/crm";
import { updateCrmSchema } from "./evidence";
import {
  canReadCanonicalLead,
  crmAccessLevel,
  recordCrmDeniedAttempt,
  validateAdmissionsUpdate,
  type CrmPrincipal,
} from "./authorization";
import { crmModelSql } from "./model";

test("CRM role matrix grants full CRM only to admins and scoped access to admissions", () => {
  const admin: CrmPrincipal = { id: 10, roles: ["admin"] };
  const firstOwner: CrmPrincipal = { id: 11, roles: ["admin", "student"] };
  const admissions: CrmPrincipal = { id: 12, roles: ["admissions"] };
  assert.equal(crmAccessLevel(admin), "admin");
  assert.equal(crmAccessLevel(firstOwner), "admin");
  assert.equal(crmAccessLevel(admissions), "admissions");
  for (const role of ["trainer", "student", "academic_coordinator", "operations"]) {
    assert.equal(crmAccessLevel({ id: 20, roles: [role] }), "denied");
  }
  assert.equal(crmAccessLevel(undefined), "denied");
});

test("admissions row scope requires a canonical lead assigned to the authenticated user", () => {
  const admissions = { id: 12, roles: ["admissions"] };
  assert.equal(canReadCanonicalLead(admissions, "a canonical UUID", 12), true);
  assert.equal(canReadCanonicalLead(admissions, "a canonical UUID", 13), false);
  assert.equal(canReadCanonicalLead(admissions, "a canonical UUID", null), false);
  assert.equal(canReadCanonicalLead(admissions, null, 12), false);
  assert.equal(canReadCanonicalLead({ id: 10, roles: ["admin"] }, null, null), true);
});

test("admissions SQL scopes keyed inquiries before grouped search and aggregate fields", () => {
  const capabilities = {
    identityTracking: true,
    videoTracking: true,
    crmPersistence: true,
    calendarBookingVerification: true,
    chatHistory: false,
    canonicalAssignments: true,
    deliveryAttempts: true,
    metaAttribution: true,
  };
  const sql = crmModelSql(capabilities, 1);
  assert.ok(sql.indexOf("scoped_keyed AS") < sql.indexOf("grouped AS"));
  assert.match(sql, /authorized_assignment\.assignee_user_id=\$1::integer/);
  assert.match(sql, /FROM scoped_keyed GROUP BY person_key/);
});

test("admissions stage allowlist excludes system/evidence-controlled milestones", () => {
  assert.deepEqual([...ADMISSIONS_MANUAL_CRM_STAGES], [
    "contacted", "qualified", "vsl_shared", "counselling_pending", "counselling_attended", "nurture", "lost",
  ]);
  assert.equal(validateAdmissionsUpdate({ expectedVersion: 0, stage: "qualified" }), null);
  assert.equal(validateAdmissionsUpdate({ expectedVersion: 0, stage: "counselling_attended" }), null);
  assert.equal(validateAdmissionsUpdate({ expectedVersion: 0, stage: "enrolled" }), "stage_not_permitted");
  assert.equal(validateAdmissionsUpdate({ expectedVersion: 0, stage: "counselling_booked" }), "stage_not_permitted");
});

test("general CRM update payload cannot set inquiry owner or assignee", () => {
  assert.equal(updateCrmSchema.safeParse({ expectedVersion: 0, note: "Internal note" }).success, true);
  assert.equal(updateCrmSchema.safeParse({ expectedVersion: 0, ownerId: 99 }).success, false);
  assert.equal(updateCrmSchema.safeParse({ expectedVersion: 0, assigneeUserId: 99 }).success, false);
});

test("denied-access audit metadata contains only bounded action and role codes", async () => {
  let captured: unknown[] = [];
  const fakeDb = { query: async (_sql: string, values: unknown[] = []) => { captured = values; return { rows: [] }; } };
  await recordCrmDeniedAttempt(fakeDb, { id: 12, roles: ["admissions", "student"] }, "assignment_write");
  const metadata = JSON.parse(String(captured[1]));
  assert.deepEqual(metadata, {
    action: "assignment_write",
    roles: ["admissions", "student"],
    outcome: "denied",
  });
  assert.equal(String(captured[0]), "12");
  assert.doesNotMatch(JSON.stringify(captured), /phone|email|name|message|request body/i);
});

test("assignment migration adds only canonical assignment structures and protects history", async () => {
  const sql = await readFile("migrations/0014_crm_canonical_assignments.sql", "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS admissions_lead_assignments/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS admissions_lead_assignment_history/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.match(sql, /aichm_validate_lead_assignment_history/);
  assert.match(sql, /aichm_reject_lead_assignment_history_mutation/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /BEFORE TRUNCATE/);
  assert.match(sql, /active admissions user/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS (?:admissions_conversation_messages|course_knowledge|ai_interaction_logs)/i);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|SCHEMA)\b/i);
});
