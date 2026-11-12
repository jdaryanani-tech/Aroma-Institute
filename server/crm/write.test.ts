import test from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { CrmError } from "./evidence";
import { updateCrm } from "./write";

const leadId = "lead:9e95bfc0-a426-43fa-8e64-07c46d79691a";
const admissionsPrincipal = { id: 4, roles: ["admissions"] as const };

type FakeState = {
  protectedLead: { stage: string; ownerId: number | null; assigneeUserId: number | null; assignmentVersion: number };
  profileNote: string | null;
  activities: Array<{ type: string; body: string | null }>;
  denials: Array<{ actorId: number; metadata: Record<string, unknown> }>;
};

function fakeUpdatePool(scope: "assigned" | "unassigned" | "other") {
  const state: FakeState = {
    protectedLead: { stage: "contacted", ownerId: 29, assigneeUserId: 4, assignmentVersion: 1 },
    profileNote: "unchanged note",
    activities: [],
    denials: [],
  };
  const calls: string[] = [];
  let transactionState: FakeState | undefined;
  let transactionOpen = false;
  let clientReleased = false;
  let auditWasWrittenAfterRelease = false;

  const clone = (value: FakeState): FakeState => structuredClone(value);
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push(normalized);
      if (normalized === "BEGIN") {
        transactionOpen = true;
        clientReleased = false;
        transactionState = clone(state);
        return { rows: [], rowCount: 0 };
      }
      if (normalized === "ROLLBACK") {
        transactionOpen = false;
        transactionState = undefined;
        return { rows: [], rowCount: 0 };
      }
      if (normalized === "COMMIT") {
        assert.ok(transactionState);
        Object.assign(state, transactionState);
        transactionOpen = false;
        transactionState = undefined;
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes("to_regclass('admissions_leads')")) {
        return {
          rows: [{
            identity: false, video: false, crm: true, assignments: true,
            attempts: false, marketing: false, calendar: false,
          }],
        };
      }
      if (normalized.includes("SELECT * FROM model WHERE")) {
        return {
          rows: scope === "assigned" ? [{
            id: leadId, lead_id: leadId.slice("lead:".length), display_name: "Assigned Prospect",
            phone: "919000000004", email: "", programs: ["Professional Barista Executive Program"],
            sources: [], stage: "contacted", stage_source: "admin", stage_evidence: null,
            identity_status: "linked", inquiry_count: 1, registered_at: null,
            questionnaire_completed_at: null, last_activity_at: null, last_video_milestone: null,
            video_completed: false, video_started: false, has_verified_form: false,
            has_verified_calendar_booking: false, booking_reference: null,
            assignee_user_id: 4, assignee_name: "Admissions User",
            assignee_needs_reassignment: false, assignment_version: 1, follow_up_at: null,
            version: 1, inquiry_ids: [101], profile_anchor: 101,
          }] : [],
        };
      }
      if (normalized.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.startsWith("INSERT INTO admissions_crm_profiles")) {
        assert.ok(transactionState);
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO admissions_crm_activities")) {
        assert.ok(transactionState);
        transactionState.activities.push({ type: String(values[1]), body: values[3] as string | null });
        return { rows: [], rowCount: 1 };
      }
      if (normalized.includes("to_regclass('admissions_lead_touchpoints')")) {
        return { rows: [{ touchpoints: false, consent: false, leadLinks: false, outbox: false }] };
      }
      if (normalized.startsWith("SELECT to_jsonb(i) data FROM inquiries")) {
        return { rows: [{ data: {
          id: 101, name: "Assigned Prospect", email: "", phone: "919000000004",
          program_interest: "Professional Barista Executive Program", message: null,
          counselling_answers: null, counselling_submitted_at: null,
          counselling_delivery_status: "not_applicable", counselling_delivery_attempts: 0,
          counselling_delivery_last_attempt_at: null, counselling_delivery_last_result: null,
          counselling_delivery_last_verified_at: null,
        } }] };
      }
      if (normalized.startsWith("SELECT a.*,coalesce(u.display_name")) return { rows: [] };
      throw new Error(`Unexpected SQL in CRM update unit test: ${normalized}`);
    },
    release() {
      clientReleased = true;
    },
  };
  const pool = {
    connect: async () => client,
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push(`POOL ${normalized}`);
      if (normalized.startsWith("INSERT INTO lms_audit_logs")) {
        assert.equal(transactionOpen, false, "denial audit must not share the rolled-back transaction");
        assert.equal(clientReleased, true, "release the transaction client before writing the denial audit");
        auditWasWrittenAfterRelease = true;
        state.denials.push({
          actorId: Number(values[0]),
          metadata: JSON.parse(String(values[1])) as Record<string, unknown>,
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected pool SQL in CRM update unit test: ${normalized}`);
    },
  };

  return {
    pool: pool as unknown as Pick<Pool, "connect" | "query">,
    state,
    calls,
    get auditWasWrittenAfterRelease() { return auditWasWrittenAfterRelease; },
  };
}

for (const scope of ["unassigned", "other"] as const) {
  test(`admissions update denial for ${scope} lead is audited after rollback without changing lead data`, async () => {
    const fake = fakeUpdatePool(scope);
    const before = structuredClone(fake.state);

    await assert.rejects(
      updateCrm(fake.pool, leadId, { expectedVersion: 1, note: "attempted note" }, admissionsPrincipal),
      (error: unknown) => error instanceof CrmError && error.status === 404 && error.message === "Lead not found.",
    );

    assert.ok(fake.calls.includes("ROLLBACK"));
    assert.ok(!fake.calls.some(sql => sql.startsWith("INSERT INTO admissions_crm_profiles")));
    assert.ok(!fake.calls.some(sql => sql.startsWith("INSERT INTO admissions_crm_activities")));
    assert.deepEqual(fake.state.protectedLead, before.protectedLead);
    assert.equal(fake.state.profileNote, before.profileNote);
    assert.deepEqual(fake.state.activities, before.activities);
    assert.equal(fake.state.denials.length, 1);
    assert.equal(fake.state.denials[0].actorId, admissionsPrincipal.id);
    assert.deepEqual(fake.state.denials[0].metadata, {
      action: "lead_update",
      roles: ["admissions"],
      outcome: "denied",
    });
    assert.equal(fake.auditWasWrittenAfterRelease, true);
  });
}

test("an admissions user can update a lead assigned to them without a denial audit", async () => {
  const fake = fakeUpdatePool("assigned");
  const before = structuredClone(fake.state);

  await updateCrm(
    fake.pool,
    leadId,
    { expectedVersion: 1, note: "follow-up completed" },
    admissionsPrincipal,
  );

  assert.equal(fake.state.profileNote, before.profileNote);
  assert.deepEqual(fake.state.protectedLead, before.protectedLead);
  assert.deepEqual(fake.state.denials, []);
  assert.equal(fake.state.activities.at(-1)?.type, "note");
  assert.equal(fake.state.activities.at(-1)?.body, "follow-up completed");
});

test("forbidden admissions stage updates are audited after their rollback", async () => {
  const fake = fakeUpdatePool("assigned");
  const before = structuredClone(fake.state);

  await assert.rejects(
    updateCrm(fake.pool, leadId, {
      expectedVersion: 1,
      stage: "enrolled",
      reason: "Attempted manual enrollment",
    }, admissionsPrincipal),
    (error: unknown) => error instanceof CrmError && error.status === 403,
  );

  assert.ok(fake.calls.includes("ROLLBACK"));
  assert.deepEqual(fake.state.protectedLead, before.protectedLead);
  assert.equal(fake.state.profileNote, before.profileNote);
  assert.deepEqual(fake.state.activities, before.activities);
  assert.equal(fake.state.denials.length, 1);
  assert.equal(fake.state.denials[0].metadata.action, "stage_stage_not_permitted");
  assert.equal(fake.auditWasWrittenAfterRelease, true);
});
