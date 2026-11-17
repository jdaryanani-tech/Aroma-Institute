import { createHash } from "node:crypto";
import type { Express, RequestHandler } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { crmAccessLevel, type CrmPrincipal } from "./authorization";
import { CrmError } from "./evidence";
import { crmModelSql, inspectCrmSchema } from "./model";
import { updateCrmAutomated } from "./write";

const automationAccountPhoneSchema = z.string().trim().min(1).max(32);
const eventIdSchema = z.string().trim().min(8).max(200);
const leadIdSchema = z.string().uuid();
const actorBody = {
  automationAccountPhone: automationAccountPhoneSchema,
};

const dueRequestSchema = z.object({
  ...actorBody,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.object({
    followUpAt: z.string().datetime({ offset: true }),
    leadId: leadIdSchema,
  }).strict().optional(),
}).strict();

const pauseRequestSchema = z.object({
  ...actorBody,
  leadId: leadIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  eventId: eventIdSchema,
  reason: z.string().trim().min(3).max(1000),
}).strict();

const deliveryRequestSchema = z.object({
  ...actorBody,
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

async function resolveAutomationActor(
  pool: Pick<Pool, "query">,
  suppliedPhone: string,
): Promise<CrmPrincipal> {
  const normalized = normalizeIndianMobile(suppliedPhone);
  if (!normalized) throw new CrmError(403, "The CRM automation actor is unavailable or unauthorized.");

  const { rows } = await pool.query(
    `SELECT u.id,u.is_active,
       coalesce(array_agg(r.role::text) FILTER(WHERE r.role IS NOT NULL),ARRAY[]::text[]) AS roles
     FROM lms_users u
     LEFT JOIN lms_user_roles r ON r.user_id=u.id
     WHERE u.phone_e164=$1
     GROUP BY u.id,u.is_active`,
    [`+${normalized}`],
  );
  if (rows.length !== 1 || rows[0].is_active !== true) {
    throw new CrmError(403, "The CRM automation actor is unavailable or unauthorized.");
  }
  const principal = {
    id: Number(rows[0].id),
    roles: rows[0].roles as string[],
  };
  if (!Number.isSafeInteger(principal.id) || crmAccessLevel(principal) === "denied") {
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
  principal: CrmPrincipal,
  input: z.infer<typeof dueRequestSchema>,
) {
  const capabilities = await inspectCrmSchema(pool);
  if (!capabilities.crmPersistence || !capabilities.identityTracking ||
      (crmAccessLevel(principal) === "admissions" && !capabilities.canonicalAssignments)) {
    throw new CrmError(503, "CRM follow-up data is not ready.");
  }
  const { rows: [consentSchema] } = await pool.query(
    "SELECT to_regclass('admissions_lead_contact_preferences') IS NOT NULL AS ready",
  );
  if (consentSchema?.ready !== true) throw new CrmError(503, "CRM consent data is not ready.");

  const admissionsScoped = crmAccessLevel(principal) === "admissions";
  const model = crmModelSql(capabilities, admissionsScoped ? 1 : undefined);
  const values: unknown[] = [];
  if (admissionsScoped) values.push(principal.id);
  const cursorCondition = input.cursor
    ? (() => {
      const timestampParam = values.push(input.cursor!.followUpAt);
      const leadParam = values.push(input.cursor!.leadId);
      return `AND (m.follow_up_at,m.lead_id) > ($${timestampParam}::timestamptz,$${leadParam}::uuid)`;
    })()
    : "";
  const limitParam = values.push(input.limit + 1);
  const { rows } = await pool.query(
    `${model}
     SELECT m.lead_id,m.display_name,concat('+',l.canonical_phone) AS phone,
       m.follow_up_at,m.version,m.stage,
       CASE WHEN m.stage='nurture' AND pause.event_hash IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM admissions_crm_activities delivered
           WHERE delivered.inquiry_id=ANY(m.inquiry_ids)
             AND delivered.data->>'automationAction'='delivery'
             AND delivered.data->>'automationFollowUpKind'='pause_checkin'
             AND delivered.data->>'pauseEventHash'=pause.event_hash)
         AND NOT EXISTS(SELECT 1 FROM admissions_crm_activities reengaged
           WHERE reengaged.inquiry_id=ANY(m.inquiry_ids)
             AND reengaged.occurred_at>pause.occurred_at
             AND reengaged.data->>'automationAction' IS NULL
             AND (reengaged.type='followup'
               OR (reengaged.type='stage' AND reengaged.data->>'to'<>'nurture')))
         THEN 'pause_checkin' ELSE 'routine' END AS follow_up_kind
     FROM model m
     JOIN admissions_leads l ON l.id=m.lead_id
     JOIN admissions_lead_contact_preferences consent ON consent.lead_id=m.lead_id
     LEFT JOIN LATERAL(
       SELECT activity.data->>'automationEventHash' AS event_hash,activity.occurred_at
       FROM admissions_crm_activities activity
       WHERE activity.inquiry_id=ANY(m.inquiry_ids)
         AND activity.data->>'automationAction'='pause'
       ORDER BY activity.occurred_at DESC,activity.id DESC LIMIT 1
     ) pause ON true
     WHERE m.lead_id IS NOT NULL
       AND m.identity_status IN ('linked','unique_phone')
       AND m.follow_up_at IS NOT NULL AND m.follow_up_at<=now()
       AND m.stage NOT IN ('lost','enrolled')
       AND l.canonical_phone IS NOT NULL
       AND consent.consent_status='granted' AND consent.opted_out_at IS NULL
       ${cursorCondition}
     ORDER BY m.follow_up_at,m.lead_id
     LIMIT $${limitParam}`,
    values,
  );
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const items = page.map((row: Record<string, unknown>) => ({
    leadId: row.lead_id,
    name: row.display_name,
    phone: row.phone,
    followUpAt: new Date(row.follow_up_at as string).toISOString(),
    expectedVersion: Number(row.version),
    followUpKind: row.follow_up_kind as "pause_checkin" | "routine",
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? {
      followUpAt: new Date(last.follow_up_at as string).toISOString(),
      leadId: last.lead_id,
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
  authenticate: RequestHandler,
  pool: Pick<Pool, "query" | "connect">,
) {
  app.post("/api/integrations/n8n/crm/follow-ups/due", authenticate, async (req, res) => {
    const parsed = dueRequestSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: "invalid_follow_up_request" });
    try {
      const actor = await resolveAutomationActor(pool, parsed.data.automationAccountPhone);
      return void res.json(await listDueFollowUps(pool, actor, parsed.data));
    } catch (error) {
      return void errorResponse(error, res);
    }
  });

  app.post("/api/integrations/n8n/crm/follow-ups/pause", authenticate, async (req, res) => {
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

  app.post("/api/integrations/n8n/crm/follow-ups/delivered", authenticate, async (req, res) => {
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
