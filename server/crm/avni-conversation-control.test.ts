import assert from "node:assert/strict";
import test from "node:test";
import {
  transitionAvniConversationControl,
  type AvniControlClient,
  type AvniControlPool,
  type AvniConversationControlWriter,
} from "./avni-conversation-control";

const leadId = "10000000-0000-4000-8000-000000000001";

type Fixture = {
  actor: { id: number; is_active: boolean }[];
  roles: { role: string }[];
  leads: { id: string }[];
  assignments: { assignee_user_id: number | null; version: number }[];
  preferences: { consent_status: string; opted_out_at: Date | string | null }[];
};

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    actor: [{ id: 7, is_active: true }],
    roles: [{ role: "admin" }],
    leads: [{ id: leadId }],
    assignments: [],
    preferences: [{ consent_status: "granted", opted_out_at: null }],
    ...overrides,
  };
}

function makePool(state: Fixture, statements: string[]): AvniControlPool {
  return {
    async connect() {
      const client: AvniControlClient = {
        async query<T>(query: string): Promise<{ rows: T[] }> {
          statements.push(query.trim().replace(/\s+/g, " "));
          const sql = query.toLowerCase();
          if (sql.includes("from lms_users")) return { rows: state.actor as T[] };
          if (sql.includes("from lms_user_roles")) return { rows: state.roles as T[] };
          if (sql.includes("from admissions_leads")) return { rows: state.leads as T[] };
          if (sql.includes("from admissions_lead_assignments")) return { rows: state.assignments as T[] };
          if (sql.includes("from admissions_lead_contact_preferences")) return { rows: state.preferences as T[] };
          return { rows: [] };
        },
        release() {},
      };
      return client;
    },
  };
}

function request(userId: number | null = 7) {
  return {
    session: userId === null ? {} : { lmsUserId: userId },
    lmsUser: userId === null ? undefined : { id: userId },
  } as never;
}

function writer(
  capture: Array<Record<string, unknown>>,
  outcome: "changed" | "duplicate" | "version_conflict" = "changed",
): AvniConversationControlWriter {
  return {
    async transitionForCanonicalLead(input) {
      capture.push(input);
      return { outcome, controlVersion: outcome === "changed" ? 5 : 4 };
    },
  };
}

test("control preflight rejects unauthenticated, inactive, and roleless actors", async () => {
  for (const state of [
    fixture({ actor: [] }),
    fixture({ actor: [{ id: 7, is_active: false }] }),
    fixture({ roles: [{ role: "trainer" }] }),
  ]) {
    const calls: string[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const result = await transitionAvniConversationControl(request(), {
      canonicalLeadId: leadId, expectedControlVersion: 4, action: "takeover",
    }, { pool: makePool(state, calls), writer: writer(writes) });
    assert.equal(result.status, "denied");
    assert.notEqual(result.code, "control_changed");
    assert.equal(writes.length, 0);
    assert.ok(calls.includes("ROLLBACK"));
  }

  const calls: string[] = [];
  const denied = await transitionAvniConversationControl(request(null), {
    canonicalLeadId: leadId, expectedControlVersion: 4, action: "takeover",
  }, { pool: makePool(fixture(), calls), writer: writer([]) });
  assert.equal(denied.code, "authentication_required");
});

test("admissions staff need current canonical assignment while admins retain global access", async () => {
  const staff = fixture({
    roles: [{ role: "admissions" }],
    assignments: [{ assignee_user_id: 8, version: 3 }],
  });
  const deniedCalls: string[] = [];
  const deniedWrites: Array<Record<string, unknown>> = [];
  const denied = await transitionAvniConversationControl(request(), {
    canonicalLeadId: leadId, expectedControlVersion: 4, action: "takeover",
  }, { pool: makePool(staff, deniedCalls), writer: writer(deniedWrites) });
  assert.equal(denied.code, "lead_assignment_denied");
  assert.equal(deniedWrites.length, 0);

  staff.assignments[0]!.assignee_user_id = 7;
  const writes: Array<Record<string, unknown>> = [];
  const result = await transitionAvniConversationControl(request(), {
    canonicalLeadId: leadId, expectedControlVersion: 4, action: "takeover",
  }, { pool: makePool(staff, []), writer: writer(writes) });
  assert.equal(result.status, "changed");
  assert.equal(writes[0]?.actorRef, "replit_lms_user:7");
  assert.equal(writes[0]?.replitLeadId, leadId);

  const admin = fixture({ assignments: [{ assignee_user_id: 99, version: 12 }] });
  const adminWrites: Array<Record<string, unknown>> = [];
  const adminResult = await transitionAvniConversationControl(request(), {
    canonicalLeadId: leadId, expectedControlVersion: 4, action: "takeover",
  }, { pool: makePool(admin, []), writer: writer(adminWrites) });
  assert.equal(adminResult.status, "changed");
  assert.equal(adminWrites.length, 1);
});

test("resume rechecks consent and opt-out under a row lock; takeover does not require consent", async () => {
  for (const preference of [
    { consent_status: "not_provided", opted_out_at: null },
    { consent_status: "granted", opted_out_at: new Date() },
    { consent_status: "opted_out", opted_out_at: null },
  ]) {
    const calls: string[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const result = await transitionAvniConversationControl(request(), {
      canonicalLeadId: leadId, expectedControlVersion: 4, action: "resume",
    }, {
      pool: makePool(fixture({ preferences: [preference] }), calls),
      writer: writer(writes),
    });
    assert.equal(result.status, "denied");
    assert.ok(["whatsapp_opted_out", "whatsapp_consent_not_granted"].includes(result.code));
    assert.equal(writes.length, 0);
    assert.ok(calls.some(sql => sql.includes("FOR UPDATE")));
  }

  const calls: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const result = await transitionAvniConversationControl(request(), {
    canonicalLeadId: leadId, expectedControlVersion: 4, action: "takeover",
  }, {
    pool: makePool(fixture({ preferences: [{ consent_status: "opted_out", opted_out_at: new Date() }] }), calls),
    writer: writer(writes),
  });
  assert.equal(result.status, "changed");
  assert.equal(writes.length, 1);
  assert.equal("consentGranted" in writes[0]!, false);
  assert.equal("optedOut" in writes[0]!, false);
});

test("server control writer receives only session-derived actor and versioned intent", async () => {
  const calls: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const result = await transitionAvniConversationControl(request(), {
    canonicalLeadId: leadId, expectedControlVersion: 4, action: "resume", reason: "Resume by request",
  }, { pool: makePool(fixture(), calls), writer: writer(writes) });
  assert.equal(result.code, "control_changed");
  assert.equal(result.sendAuthorized, false);
  assert.deepEqual(Object.keys(writes[0]!).sort(), [
    "action", "actorRef", "expectedControlVersion", "reason", "replitLeadId", "requestId",
  ]);
  assert.match(String(writes[0]?.requestId), /^[0-9a-f-]{36}$/);
  assert.ok(calls.includes("COMMIT"));

  const stale = await transitionAvniConversationControl(request(), {
    canonicalLeadId: leadId, expectedControlVersion: 3, action: "takeover",
  }, {
    pool: makePool(fixture(), []),
    writer: writer([], "version_conflict"),
  });
  assert.equal(stale.code, "stale_control_version");

  const unavailable = await transitionAvniConversationControl(request(), {
    canonicalLeadId: leadId, expectedControlVersion: 4, action: "takeover",
  }, { pool: makePool(fixture(), []), writer: null });
  assert.equal(unavailable.status, "unavailable");
});
