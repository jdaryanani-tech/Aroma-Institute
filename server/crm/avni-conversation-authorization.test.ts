import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import type { SupabaseConversationPreflight } from "../db/supabase-avni-readonly";
import {
  preflightAvniConversationOperation,
  type AvniAuthorizationClient,
  type AvniConversationPreflightReader,
} from "./avni-conversation-authorization";

const LEAD_ID = "10000000-0000-4000-8000-000000000001";
const THREAD_ID = "20000000-0000-4000-8000-000000000002";
const SUPABASE_ID = "30000000-0000-4000-8000-000000000003";

type FixtureOptions = {
  actorActive?: boolean;
  currentRoles?: string[];
  leadExists?: boolean;
  assigneeUserId?: number | null;
  consentStatus?: string | null;
  optedOutAt?: string | null;
  supabase?: SupabaseConversationPreflight;
  supabaseThrows?: boolean;
  connectThrows?: boolean;
};

function makeRequest(
  sessionUserId: number | null = 7,
  attachedUserId = 7,
  attachedRoles: string[] = ["admissions"],
) {
  return {
    session: sessionUserId === null ? {} : { lmsUserId: sessionUserId },
    lmsUser: {
      id: attachedUserId,
      phoneE164: "not-used",
      displayName: "not-used",
      roles: attachedRoles,
    },
    // Adversarial fields deliberately have no bearing on actor, target,
    // assignment, consent, crosswalk or conversation authority.
    body: {
      actorId: 99,
      roles: ["admin"],
      leadId: SUPABASE_ID,
      supabaseLeadId: SUPABASE_ID,
      threadId: THREAD_ID,
      assigned: true,
      whatsappConsentGranted: true,
    },
  } as unknown as Pick<Request, "session" | "lmsUser"> & { body: Record<string, unknown> };
}

function createFixture(options: FixtureOptions = {}) {
  const statements: string[] = [];
  const valuesSeen: unknown[][] = [];
  let released = false;
  const client: AvniAuthorizationClient = {
    async query<T>(sql: string, values: unknown[] = []) {
      statements.push(sql.trim());
      valuesSeen.push(values);
      const normalized = sql.replace(/\s+/g, " ").trim();
      let rows: unknown[] = [];
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        rows = [];
      } else if (normalized.includes("FROM lms_users")) {
        rows = options.actorActive === false ? [] : [{ id: 7, is_active: true }];
      } else if (normalized.includes("FROM lms_user_roles")) {
        rows = (options.currentRoles ?? ["admissions"]).map(role => ({ role }));
      } else if (normalized.includes("FROM admissions_leads")) {
        rows = options.leadExists === false ? [] : [{ id: LEAD_ID }];
      } else if (normalized.includes("FROM admissions_lead_assignments")) {
        rows = options.assigneeUserId === undefined
          ? [{ assignee_user_id: 7 }]
          : [{ assignee_user_id: options.assigneeUserId }];
      } else if (normalized.includes("FROM admissions_lead_contact_preferences")) {
        if (options.consentStatus !== null) {
          rows = options.consentStatus === undefined
            ? [{ consent_status: "granted", opted_out_at: null }]
            : [{
              consent_status: options.consentStatus,
              opted_out_at: options.optedOutAt ?? null,
            }];
        }
      } else {
        throw new Error("unexpected_query");
      }
      return { rows: rows as T[] };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      if (options.connectThrows) throw new Error("connection unavailable");
      return client;
    },
  };
  const supabase: AvniConversationPreflightReader | null = options.supabaseThrows
    ? {
      async preflightConversation() {
        throw new Error("read-only runtime unavailable");
      },
    }
    : options.supabase === undefined
      ? {
        async preflightConversation() {
          return {
            outcome: "preflight_ready",
            mode: "ai",
            lifecycle: "open",
            controlVersion: 4,
          };
        },
      }
      : {
        async preflightConversation() {
          return options.supabase!;
        },
      };
  return {
    pool,
    supabase,
    statements,
    valuesSeen,
    get released() { return released; },
  };
}

async function run(
  options: FixtureOptions = {},
  request = makeRequest(),
  expectedVersion = 4,
) {
  const fixture = createFixture(options);
  const result = await preflightAvniConversationOperation(
    request,
    LEAD_ID,
    expectedVersion,
    { pool: fixture.pool, supabase: fixture.supabase },
  );
  return { result, fixture };
}

test("session identity is required and inactive users fail closed", async () => {
  const noSession = await run({}, makeRequest(null));
  assert.equal(noSession.result.code, "authentication_required");
  assert.equal(noSession.fixture.statements.length, 0);

  const mismatchedSession = await run({}, makeRequest(8, 7));
  assert.equal(mismatchedSession.result.code, "authentication_required");

  const inactive = await run({ actorActive: false });
  assert.equal(inactive.result.code, "actor_inactive");
  assert.equal(inactive.result.sendAuthorized, false);
  assert.equal(inactive.fixture.released, true);
});

test("current database roles override stale middleware roles", async () => {
  const { result } = await run(
    { currentRoles: ["trainer"] },
    makeRequest(7, 7, ["admin"]),
  );
  assert.equal(result.code, "crm_role_required");
  assert.equal(result.sendAuthorized, false);
});

test("admins can preflight any canonical lead while admissions staff require assignment", async () => {
  const admin = await run(
    { currentRoles: ["admin"], assigneeUserId: null },
    makeRequest(7, 7, ["admin"]),
  );
  assert.equal(admin.result.status, "ready");
  assert.equal(admin.result.code, "preflight_complete");

  const assignedAdmissions = await run({ currentRoles: ["admissions"], assigneeUserId: 7 });
  assert.equal(assignedAdmissions.result.status, "ready");

  const unassignedAdmissions = await run({ currentRoles: ["admissions"], assigneeUserId: null });
  assert.equal(unassignedAdmissions.result.code, "lead_assignment_denied");

  const otherStaffAssignment = await run({ currentRoles: ["admissions"], assigneeUserId: 9 });
  assert.equal(otherStaffAssignment.result.code, "lead_assignment_denied");
});

test("missing canonical admissions identities are not resolved by alternate claims", async () => {
  const { result } = await run({ leadExists: false });
  assert.equal(result.code, "canonical_lead_unavailable");
});

test("client-like actor, lead, assignment and consent claims are ignored", async () => {
  const request = makeRequest(7, 7, ["admissions"]);
  const { result, fixture } = await run(
    { currentRoles: ["admissions"], assigneeUserId: 7, consentStatus: "not_provided" },
    request,
  );
  assert.equal(result.code, "whatsapp_consent_not_granted");
  assert.ok(fixture.valuesSeen.every(values => !values.includes(99) && !values.includes(SUPABASE_ID)));
});

test("missing, ungranted, revoked and opted-out WhatsApp consent deny preflight", async () => {
  assert.equal((await run({ consentStatus: null })).result.code, "whatsapp_consent_not_granted");
  assert.equal((await run({ consentStatus: "not_provided" })).result.code, "whatsapp_consent_not_granted");
  assert.equal((await run({ consentStatus: "revoked" })).result.code, "whatsapp_consent_not_granted");
  assert.equal(
    (await run({ consentStatus: "granted", optedOutAt: "2026-11-18T00:00:00.000Z" })).result.code,
    "whatsapp_opted_out",
  );
  assert.equal((await run({ consentStatus: "opted_out" })).result.code, "whatsapp_opted_out");
});

test("crosswalk and conversation ambiguity, absence, closure and stale versions fail closed", async () => {
  for (const [outcome, expected] of [
    ["crosswalk_missing", "crosswalk_missing"],
    ["crosswalk_ambiguous", "crosswalk_ambiguous"],
    ["conversation_missing", "conversation_missing"],
    ["conversation_ambiguous", "conversation_ambiguous"],
    ["conversation_closed", "conversation_closed"],
    ["stale_control_version", "stale_control_version"],
  ] as const) {
    const snapshot: SupabaseConversationPreflight = {
      outcome,
      mode: null,
      lifecycle: null,
      controlVersion: null,
    };
    const { result } = await run({ supabase: snapshot });
    assert.equal(result.code, expected);
    assert.equal(result.sendAuthorized, false);
  }
});

test("unavailable runtime configuration and database failures return safe unavailable status", async () => {
  const noReader = createFixture();
  const resultWithoutReader = await preflightAvniConversationOperation(
    makeRequest(),
    LEAD_ID,
    4,
    { pool: noReader.pool, supabase: null },
  );
  assert.equal(resultWithoutReader.status, "unavailable");
  assert.equal(resultWithoutReader.code, "runtime_unavailable");

  assert.equal((await run({ supabaseThrows: true })).result.code, "runtime_unavailable");
  assert.equal((await run({ connectThrows: true })).result.code, "runtime_unavailable");
});

test("successful preflight returns no identifiers and never authorizes a send", async () => {
  const { result, fixture } = await run();
  assert.deepEqual(result, {
    status: "ready",
    code: "preflight_complete",
    conversationMode: "ai",
    controlVersion: 4,
    sendAuthorized: false,
  });
  const serialized = JSON.stringify(result);
  for (const identifier of [LEAD_ID, THREAD_ID, SUPABASE_ID]) {
    assert.equal(serialized.includes(identifier), false);
  }
  assert.ok(fixture.statements.every(statement =>
    /^(BEGIN|COMMIT|ROLLBACK|SELECT)\b/i.test(statement),
  ));
  assert.equal(fixture.statements.some(statement => /\b(INSERT|UPDATE|DELETE|CALL)\b/i.test(statement)), false);
  assert.equal(fixture.released, true);
});

test("a fresh final-dispatch preflight denies after consent is revoked", async () => {
  const options: FixtureOptions = {
    currentRoles: ["admissions"],
    assigneeUserId: 7,
    consentStatus: "granted",
  };
  const fixture = createFixture(options);
  const request = makeRequest();
  const beforeQueue = await preflightAvniConversationOperation(
    request,
    LEAD_ID,
    4,
    { pool: fixture.pool, supabase: fixture.supabase },
  );
  assert.equal(beforeQueue.status, "ready");
  assert.equal(beforeQueue.sendAuthorized, false);

  // Simulate a Replit opt-out between the first check and a would-be final
  // dispatch check. The adapter performs fresh SQL on every invocation.
  options.consentStatus = "opted_out";
  options.optedOutAt = "2026-11-18T12:00:00.000Z";
  const beforeDispatch = await preflightAvniConversationOperation(
    request,
    LEAD_ID,
    4,
    { pool: fixture.pool, supabase: fixture.supabase },
  );
  assert.equal(beforeDispatch.code, "whatsapp_opted_out");
  assert.equal(beforeDispatch.sendAuthorized, false);
});

test("a fresh final-dispatch preflight denies after assignment changes", async () => {
  const options: FixtureOptions = {
    currentRoles: ["admissions"],
    assigneeUserId: 7,
    consentStatus: "granted",
  };
  const fixture = createFixture(options);
  const request = makeRequest();
  const beforeQueue = await preflightAvniConversationOperation(
    request,
    LEAD_ID,
    4,
    { pool: fixture.pool, supabase: fixture.supabase },
  );
  assert.equal(beforeQueue.status, "ready");

  options.assigneeUserId = 9;
  const beforeDispatch = await preflightAvniConversationOperation(
    request,
    LEAD_ID,
    4,
    { pool: fixture.pool, supabase: fixture.supabase },
  );
  assert.equal(beforeDispatch.code, "lead_assignment_denied");
  assert.equal(beforeDispatch.sendAuthorized, false);
});
