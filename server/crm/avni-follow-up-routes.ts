import { createHash } from "node:crypto";
import type { Express, RequestHandler } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  auditAvniFollowUpCandidateRead,
  AVNI_FOLLOWUP_READ_PRINCIPAL,
  AVNI_FOLLOWUP_READ_SCOPE,
} from "./avni-follow-up-read-auth";
import { lookupAvniAutomationActor } from "./avni-automation-actor";
import { CrmError } from "./evidence";
import { inspectCrmSchema } from "./model";
import { updateCrmAutomated } from "./write";

const eventIdSchema = z.string().trim().min(8).max(200);
const leadIdSchema = z.string().uuid();

const dueRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.object({
    followUpAt: z.string().datetime({ offset: true }),
    candidateRef: leadIdSchema,
  }).strict().optional(),
}).strict();

const pauseRequestSchema = z.object({
  automationAccountPhone: z.string().trim().min(1).max(32),
  leadId: leadIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  eventId: eventIdSchema,
  reason: z.string().trim().min(3).max(1000),
}).strict();

const deliveryRequestSchema = z.object({
  automationAccountPhone: z.string().trim().min(1).max(32),
  leadId: leadIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  expectedFollowUpAt: z.string().datetime({ offset: true }),
  eventId: eventIdSchema,
  deliveryStatus: z.literal("confirmed_delivered"),
  followUpKind: z.enum(["pause_checkin", "routine"]),
}).strict();

function eventHash(action: string, eventId: string): string {
  return createHash("sha256").update(`avni-crm-follow-up:${action}:${eventId}`).digest("hex");
}

class CandidateReadFailure extends Error {
  constructor(readonly outcome: "schema_unavailable" | "query_failed") {
    super("CRM follow-up candidate read is unavailable.");
  }
}

async function resolveAutomationActor(
  pool: Pick<Pool, "query">,
  suppliedPhone: string,
): Promise<{ id: number; roles: readonly string[] }> {
  const { principal } = await lookupAvniAutomationActor(pool, suppliedPhone);
  if (!principal) {
    throw new CrmError(403, "The CRM automation actor is unavailable or unauthorized.");
  }
  return principal;
}

function nextIstSlot(after: Date): Date {
  const offsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(after.getTime() + offsetMs);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const targetHour = minutes < 9 * 60 ? 9 : minutes < 21 * 60 ? 21 : 9;
  const targetDay = targetHour === 9 && minutes >= 21 * 60 ? day + 1 : day;
  return new Date(Date.UTC(year, month, targetDay, targetHour) - offsetMs);
}

async function listDueFollowUps(
  pool: Pick<Pool, "query">,
  input: z.infer<typeof dueRequestSchema>,
) {
  let capabilities;
  try {
    capabilities = await inspectCrmSchema(pool);
  } catch {
    throw new CandidateReadFailure("schema_unavailable");
  }
  if (!capabilities.crmPersistence || !capabilities.identityTracking || !capabilities.canonicalAssignments) {
    throw new CandidateReadFailure("schema_unavailable");
  }

  let consentSchema;
  try {
    const result = await pool.query(
      "SELECT to_regclass('admissions_lead_contact_preferences') IS NOT NULL AS ready",
    );
    consentSchema = result.rows[0];
  } catch {
    throw new CandidateReadFailure("schema_unavailable");
  }
  if (consentSchema?.ready !== true) throw new CandidateReadFailure("schema_unavailable");

  const values: unknown[] = [];
  const cursorCondition = input.cursor
    ? (() => {
      const timestampParam = values.push(input.cursor!.followUpAt);
      const leadParam = values.push(input.cursor!.candidateRef);
      return `AND (latest.follow_up_at,l.id) > ($${timestampParam}::timestamptz,$${leadParam}::uuid)`;
    })()
    : "";
  const limitParam = values.push(input.limit + 1);
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await pool.query(
      `SELECT l.id AS candidate_ref,
        latest.follow_up_at,
        (SELECT coalesce(sum(profile.version),0)::integer
         FROM inquiries versioned_inquiry
         JOIN admissions_crm_profiles profile ON profile.inquiry_id=versioned_inquiry.id
         WHERE versioned_inquiry.lead_id=l.id) AS version,
        CASE WHEN latest.stage='nurture' AND pause.event_hash IS NOT NULL
          AND NOT pause.checkin_delivered AND NOT pause.reengaged
         THEN 'pause_checkin' ELSE 'routine' END AS follow_up_kind
      FROM admissions_leads l
      JOIN LATERAL(
        SELECT profile.stage,profile.follow_up_at
        FROM inquiries inquiry
        JOIN admissions_crm_profiles profile ON profile.inquiry_id=inquiry.id
        WHERE inquiry.lead_id=l.id
        ORDER BY profile.updated_at DESC,profile.inquiry_id
        LIMIT 1
      ) latest ON true
      JOIN admissions_lead_assignments assignment ON assignment.lead_id=l.id
      JOIN lms_users assignee ON assignee.id=assignment.assignee_user_id AND assignee.is_active=true
      JOIN admissions_lead_contact_preferences consent ON consent.lead_id=l.id
     LEFT JOIN LATERAL(
        SELECT activity.data->>'automationEventHash' AS event_hash,activity.occurred_at,
          EXISTS(SELECT 1 FROM admissions_crm_activities delivered
            WHERE delivered.inquiry_id IN (
              SELECT related.id FROM inquiries related WHERE related.lead_id=l.id
            )
              AND delivered.data->>'automationAction'='delivery'
              AND delivered.data->>'automationFollowUpKind'='pause_checkin'
              AND delivered.data->>'pauseEventHash'=activity.data->>'automationEventHash'
          ) AS checkin_delivered,
          EXISTS(SELECT 1 FROM admissions_crm_activities reengaged
            WHERE reengaged.inquiry_id IN (
              SELECT related.id FROM inquiries related WHERE related.lead_id=l.id
            )
              AND reengaged.occurred_at>activity.occurred_at
              AND reengaged.data->>'automationAction' IS NULL
              AND (reengaged.type='followup'
                OR (reengaged.type='stage' AND reengaged.data->>'to'<>'nurture'))
          ) AS reengaged
       FROM admissions_crm_activities activity
        WHERE activity.inquiry_id IN (
          SELECT related.id FROM inquiries related WHERE related.lead_id=l.id
        )
         AND activity.data->>'automationAction'='pause'
       ORDER BY activity.occurred_at DESC,activity.id DESC LIMIT 1
     ) pause ON true
      WHERE latest.follow_up_at IS NOT NULL AND latest.follow_up_at<=now()
        AND latest.stage NOT IN ('lost','enrolled')
        AND l.canonical_phone IS NOT NULL
        AND EXISTS(
          SELECT 1 FROM lms_user_roles assigned_role
          WHERE assigned_role.user_id=assignee.id AND assigned_role.role::text='admissions'
        )
       AND consent.consent_status='granted' AND consent.opted_out_at IS NULL
        AND NOT (
          latest.stage='nurture' AND pause.event_hash IS NOT NULL
          AND pause.checkin_delivered AND NOT pause.reengaged
        )
       ${cursorCondition}
      ORDER BY latest.follow_up_at,l.id
     LIMIT $${limitParam}`,
      values,
    ));
  } catch {
    throw new CandidateReadFailure("query_failed");
  }
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const items = page.map(row => ({
    candidateRef: row.candidate_ref,
    followUpAt: new Date(row.follow_up_at as string).toISOString(),
    expectedVersion: Number(row.version),
    followUpKind: row.follow_up_kind as "pause_checkin" | "routine",
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? {
      followUpAt: new Date(last.follow_up_at as string).toISOString(),
      candidateRef: last.candidate_ref,
    } : null,
  };
}

function errorResponse(error: unknown, res: Parameters<RequestHandler>[1]) {
  if (error instanceof CrmError) {
    return res.status(error.status).json({ code: error.status === 403
      ? "automation_actor_unavailable"
      : error.status === 409 ? "crm_version_or_workflow_conflict"
      : "crm_follow_up_unavailable" });
  }
  return res.status(503).json({ code: "crm_follow_up_unavailable" });
}

export function registerAvniCrmFollowUpRoutes(
  app: Express,
  authenticateWrite: RequestHandler,
  authenticateCandidateRead: RequestHandler,
  pool: Pick<Pool, "query" | "connect">,
) {
  app.post("/api/integrations/n8n/crm/follow-ups/due", authenticateCandidateRead, async (req, res) => {
    const parsed = dueRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      auditAvniFollowUpCandidateRead(res, "invalid_request");
      return void res.status(400).json({ code: "invalid_follow_up_request" });
    }
    const serviceIdentity = res.locals.avniFollowUpReadIdentity as {
      servicePrincipal?: string;
      scope?: string;
    } | undefined;
    if (serviceIdentity?.servicePrincipal !== AVNI_FOLLOWUP_READ_PRINCIPAL
      || serviceIdentity.scope !== AVNI_FOLLOWUP_READ_SCOPE) {
      auditAvniFollowUpCandidateRead(res, "authentication_denied");
      return void res.status(403).json({ code: "follow_up_read_scope_denied" });
    }
    try {
      const result = await listDueFollowUps(pool, parsed.data);
      auditAvniFollowUpCandidateRead(res, "success", result.items.length);
      return void res.json(result);
    } catch (error) {
      const outcome = error instanceof CandidateReadFailure ? error.outcome : "query_failed";
      auditAvniFollowUpCandidateRead(res, outcome);
      return void res.status(503).json({ code: "follow_up_read_unavailable" });
    }
  });

  app.post("/api/integrations/n8n/crm/follow-ups/pause", authenticateWrite, async (req, res) => {
    const parsed = pauseRequestSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: "invalid_follow_up_request" });
    try {
      const actor = await resolveAutomationActor(pool, parsed.data.automationAccountPhone);
      const result = await updateCrmAutomated(
        pool,
        `lead:${parsed.data.leadId}`,
        {
          expectedVersion: parsed.data.expectedVersion,
          stage: "nurture",
          followUpAt: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(),
          reason: parsed.data.reason,
        },
        actor,
        { eventHash: eventHash("pause", parsed.data.eventId), action: "pause" },
      );
      return void res.json({
        status: result.replayed ? "already_processed" : "scheduled",
        followUpAt: result.detail.lead.followUpAt,
        version: result.detail.lead.version,
      });
    } catch (error) {
      return void errorResponse(error, res);
    }
  });

  app.post("/api/integrations/n8n/crm/follow-ups/delivered", authenticateWrite, async (req, res) => {
    const parsed = deliveryRequestSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: "invalid_follow_up_request" });
    try {
      const actor = await resolveAutomationActor(pool, parsed.data.automationAccountPhone);
      const result = await updateCrmAutomated(
        pool,
        `lead:${parsed.data.leadId}`,
        {
          expectedVersion: parsed.data.expectedVersion,
          followUpAt: parsed.data.followUpKind === "pause_checkin"
            ? null
            : nextIstSlot(new Date()).toISOString(),
        },
        actor,
        {
          eventHash: eventHash("delivery", parsed.data.eventId),
          action: "delivery",
          expectedFollowUpAt: parsed.data.expectedFollowUpAt,
          followUpKind: parsed.data.followUpKind,
        },
      );
      return void res.json({
        status: result.replayed ? "already_processed" : "delivery_recorded",
        followUpAt: result.detail.lead.followUpAt,
        version: result.detail.lead.version,
      });
    } catch (error) {
      return void errorResponse(error, res);
    }
  });
}
