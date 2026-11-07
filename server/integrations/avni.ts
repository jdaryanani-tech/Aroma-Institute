import type { Express, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { admissionsCaptureLimits, admissionsLeads } from "@shared/admissions-schema";
import { admissionsConversationMessages } from "@shared/avni-schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { db, pool } from "../db";
import { upsertIntegrationLead } from "../admissions/identity";
import { admissionsIntegrationSchemaReady, readLeadFollowUpByPhone } from "../admissions/follow-up";
import { requireLmsRole, requireLmsUser } from "../lms/auth";

export const N8N_VSL_SECRET_ENV = "N8N_VSL_REGISTRATION_WEBHOOK_SECRET";
export const N8N_VSL_SECRET_HEADER = "x-aichm-webhook-secret";
const digest = (value: string) => createHash("sha256").update(value).digest();
const canonicalPhone = z.string().trim().max(32).refine(
  (value) => normalizeIndianMobile(value) !== null,
  "A valid Indian mobile number is required.",
);
const idempotencyKey = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export function verifyAvniIntegrationSecret(supplied: string, expected: string | undefined) {
  if (!expected?.trim() || supplied.length > 1024) return false;
  return timingSafeEqual(digest(supplied), digest(expected.trim()));
}

export function normalizeAvniMessageInput(input: unknown) {
  return z.object({
    phone: canonicalPhone,
    name: z.string().trim().min(2).max(120).optional(),
    direction: z.enum(["inbound", "outbound"]),
    messageType: z.string().trim().min(1).max(80).default("text"),
    body: z.string().max(12000),
    provider: z.string().trim().min(1).max(40).default("whatsapp"),
    providerMessageId: z.string().trim().min(1).max(200).nullable().optional(),
    idempotencyKey,
    occurredAt: z.string().datetime({ offset: true }).optional(),
    inquiryId: z.number().int().positive().nullable().optional(),
  }).strict().superRefine((value, ctx) => {
    if (!value.body.trim()) ctx.addIssue({ code: "custom", path: ["body"], message: "Message body is required." });
    if (value.direction === "inbound" && value.messageType === "booking_confirmation") return;
    if (value.direction === "inbound" && value.messageType === "booking_cancellation") return;
    if (value.direction === "outbound" && ["booking_confirmation", "booking_cancellation"].includes(value.messageType)) {
      ctx.addIssue({ code: "custom", path: ["messageType"], message: "Booking intent must be an inbound message." });
    }
  }).safeParse(input);
}

export function classifyMessageIdempotency(
  existing: { leadId: string; body: string; direction: string } | null,
  incoming: { leadId: string; body: string; direction: string },
) {
  if (!existing) return "new" as const;
  return existing.leadId === incoming.leadId && existing.body === incoming.body
    && existing.direction === incoming.direction ? "duplicate" as const : "conflict" as const;
}

export const avniIntegrationAuth: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Vary", N8N_VSL_SECRET_HEADER);
  const expected = process.env[N8N_VSL_SECRET_ENV];
  if (!expected?.trim()) return void res.status(503).json({ message: "AVNI integration is not configured." });
  if (!verifyAvniIntegrationSecret(req.get(N8N_VSL_SECRET_HEADER) ?? "", expected)) {
    return void res.status(401).json({ message: "Integration authentication required." });
  }
  try {
    const key = createHash("sha256").update(`avni:${req.ip ?? "unknown"}`).digest("hex");
    const now = new Date();
    const cutoff = new Date(now.getTime() - 60_000);
    const [bucket] = await db.insert(admissionsCaptureLimits).values({
      keyHash: key, windowStartedAt: now, attempts: 1,
    }).onConflictDoUpdate({
      target: admissionsCaptureLimits.keyHash,
      set: {
        windowStartedAt: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN ${now} ELSE ${admissionsCaptureLimits.windowStartedAt} END`,
        attempts: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN 1 ELSE LEAST(${admissionsCaptureLimits.attempts}+1,121) END`,
      },
    }).returning({ attempts: admissionsCaptureLimits.attempts });
    if (bucket.attempts > 120) {
      res.setHeader("Retry-After", "60");
      return void res.status(429).json({ message: "Too many integration requests." });
    }
    return next();
  } catch {
    return void res.status(503).json({ message: "AVNI integration is temporarily unavailable." });
  }
};

export function registerAvniIntegrationRoutes(app: Express) {

  const schemaReady = async () => await admissionsIntegrationSchemaReady(db)
    && (await pool.query(`SELECT to_regclass('admissions_conversation_messages') IS NOT NULL AS ready`)).rows[0]?.ready === true;

  app.get("/api/admin/integrations/avni/status", requireLmsUser, requireLmsRole("admin"), async (_req, res) => {
    const names = [
      "N8N_VSL_REGISTRATION_WEBHOOK_SECRET",
      "N8N_VSL_REGISTRATION_WEBHOOK_URL",
      "N8N_VSL_DISPATCH_ENABLED",
      "AICHM_VAPID_PUBLIC_KEY",
      "AICHM_VAPID_PRIVATE_KEY",
    ];
    const configured = Object.fromEntries(names.map((name) => [name, Boolean(process.env[name]?.trim())]));
    let schemaReady = false, calendarReady = false;
    try {
      schemaReady = await admissionsIntegrationSchemaReady(db)
        && (await pool.query(`SELECT to_regclass('admissions_conversation_messages') IS NOT NULL AS ready`)).rows[0]?.ready === true;
      calendarReady = (await pool.query(`SELECT
        to_regclass('calendar_events') IS NOT NULL AND
        to_regclass('calendar_event_attendees') IS NOT NULL AND
        to_regclass('calendar_reminder_jobs') IS NOT NULL AND
        to_regclass('calendar_integration_requests') IS NOT NULL AS ready`)).rows[0]?.ready === true;
    } catch { /* report unavailable, never expose driver details */ }
    return void res.json({
      sourceOfTruth: "replit_postgresql",
      configured,
      missing: names.filter((name) => !configured[name]),
      avniSchemaReady: schemaReady,
      calendarSchemaReady: calendarReady,
      reminderRunnerCommandAvailable: true,
      schedulerHookupRequired: true,
      supabaseRuntime: false,
    });
  });

  app.get("/api/integrations/n8n/health", avniIntegrationAuth, async (_req, res) => {
    try {
      const ready = await schemaReady();
      return void res.status(ready ? 200 : 503).json({ ready, sourceOfTruth: "replit_postgresql" });
    } catch {
      return void res.status(503).json({ ready: false, sourceOfTruth: "replit_postgresql" });
    }
  });

  app.post("/api/integrations/n8n/leads/upsert", avniIntegrationAuth, async (req, res) => {
    const parsed = z.object({
      phone: canonicalPhone,
      name: z.string().trim().min(2).max(120),
      source: z.string().trim().min(1).max(80).default("avni_whatsapp"),
      programInterest: z.string().trim().min(1).max(200).default("Professional Barista Executive Program"),
    }).strict().safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ message: "A valid phone and name are required." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const result = await upsertIntegrationLead(parsed.data);
      const journey = await readLeadFollowUpByPhone(result.canonicalPhone);
      return void res.status(result.inquiryCreated ? 201 : 200).json({
        leadId: result.lead.id,
        inquiryId: result.inquiryId,
        inquiryCreated: result.inquiryCreated,
        registeredAt: journey?.registeredAt ?? null,
        video: journey?.video ?? null,
        questionnaire: journey?.questionnaire ? {
          status: journey.questionnaire.status,
          completedAt: journey.questionnaire.completedAt,
        } : null,
      });
    } catch {
      return void res.status(503).json({ message: "Lead could not be saved." });
    }
  });

  app.post("/api/integrations/n8n/conversations/messages", avniIntegrationAuth, async (req, res) => {
    const parsed = normalizeAvniMessageInput(req.body);
    if (!parsed.success) return void res.status(400).json({ message: "Conversation message is invalid." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const input = parsed.data;
      const canonical = normalizeIndianMobile(input.phone)!;
      const upsert = await upsertIntegrationLead({
        phone: canonical, name: input.name ?? "WhatsApp enquiry", source: "avni_whatsapp",
      });
      const message = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`avni-message:${input.idempotencyKey}`}))`);
        const [byKey] = await tx.select().from(admissionsConversationMessages)
          .where(eq(admissionsConversationMessages.idempotencyKey, input.idempotencyKey)).limit(1);
        if (byKey) {
          if (classifyMessageIdempotency(byKey, {
            leadId: upsert.lead.id, body: input.body, direction: input.direction,
          }) === "conflict") {
            throw new Error("idempotency_conflict");
          }
          return { row: byKey, duplicate: true };
        }
        if (input.providerMessageId) {
          const [byProvider] = await tx.select().from(admissionsConversationMessages).where(and(
            eq(admissionsConversationMessages.provider, input.provider),
            eq(admissionsConversationMessages.providerMessageId, input.providerMessageId),
          )).limit(1);
          if (byProvider) return { row: byProvider, duplicate: true };
        }
        const [row] = await tx.insert(admissionsConversationMessages).values({
          leadId: upsert.lead.id,
          inquiryId: input.inquiryId ?? upsert.inquiryId,
          canonicalPhone: canonical,
          direction: input.direction,
          messageType: input.messageType,
          body: input.body,
          provider: input.provider,
          providerMessageId: input.providerMessageId ?? null,
          idempotencyKey: input.idempotencyKey,
          deliveryState: input.direction === "inbound" ? "received" : "pending",
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        }).returning();
        return { row, duplicate: false };
      });
      return void res.status(message.duplicate ? 200 : 201).json({
        saved: true, duplicate: message.duplicate, messageId: message.row.id,
        leadId: message.row.leadId, deliveryState: message.row.deliveryState,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "idempotency_conflict") {
        return void res.status(409).json({ message: "Idempotency key was already used for different message data." });
      }
      return void res.status(503).json({ message: "Conversation message could not be saved." });
    }
  });

  app.patch("/api/integrations/n8n/conversations/messages/:messageId/delivery", avniIntegrationAuth, async (req, res) => {
    const messageId = z.string().uuid().safeParse(req.params.messageId);
    const parsed = z.object({
      state: z.enum(["sent", "failed"]),
      providerMessageId: z.string().trim().min(1).max(200).nullable().optional(),
    }).strict().safeParse(req.body);
    if (!messageId.success || !parsed.success) return void res.status(400).json({ message: "Delivery update is invalid." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const [existing] = await db.select().from(admissionsConversationMessages)
        .where(eq(admissionsConversationMessages.id, messageId.data)).limit(1);
      if (!existing || existing.direction !== "outbound") return void res.status(404).json({ message: "Outbound message not found." });
      if (existing.deliveryState !== "pending") {
        const identical = existing.deliveryState === parsed.data.state
          && (!parsed.data.providerMessageId || existing.providerMessageId === parsed.data.providerMessageId);
        return void res.status(identical ? 200 : 409).json(identical
          ? { saved: true, duplicate: true, messageId: existing.id, deliveryState: existing.deliveryState }
          : { message: "Outbound delivery is already finalized." });
      }
      const [saved] = await db.update(admissionsConversationMessages).set({
        deliveryState: parsed.data.state,
        providerMessageId: parsed.data.providerMessageId ?? existing.providerMessageId,
        updatedAt: new Date(),
      }).where(and(eq(admissionsConversationMessages.id, existing.id), eq(admissionsConversationMessages.deliveryState, "pending")))
        .returning({ id: admissionsConversationMessages.id, deliveryState: admissionsConversationMessages.deliveryState });
      if (!saved) return void res.status(409).json({ message: "Outbound delivery changed; read its current state." });
      return void res.json({ saved: true, duplicate: false, messageId: saved.id, deliveryState: saved.deliveryState });
    } catch {
      return void res.status(503).json({ message: "Delivery state could not be saved." });
    }
  });

  app.get("/api/integrations/n8n/leads/:leadId/conversations", avniIntegrationAuth, async (req, res) => {
    const leadId = z.string().uuid().safeParse(req.params.leadId);
    const limit = z.coerce.number().int().min(1).max(200).default(50).safeParse(req.query.limit);
    if (!leadId.success || !limit.success) return void res.status(400).json({ message: "Conversation query is invalid." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const rows = await db.select({
        id: admissionsConversationMessages.id,
        direction: admissionsConversationMessages.direction,
        messageType: admissionsConversationMessages.messageType,
        body: admissionsConversationMessages.body,
        deliveryState: admissionsConversationMessages.deliveryState,
        providerMessageId: admissionsConversationMessages.providerMessageId,
        occurredAt: admissionsConversationMessages.occurredAt,
      }).from(admissionsConversationMessages)
        .where(eq(admissionsConversationMessages.leadId, leadId.data))
        .orderBy(desc(admissionsConversationMessages.occurredAt), desc(admissionsConversationMessages.id))
        .limit(limit.data);
      return void res.json({ leadId: leadId.data, items: rows.reverse() });
    } catch {
      return void res.status(503).json({ message: "Conversation history is temporarily unavailable." });
    }
  });

  app.post("/api/integrations/n8n/conversations/read", avniIntegrationAuth, async (req, res) => {
    const parsed = z.object({ phone: canonicalPhone, limit: z.number().int().min(1).max(200).default(50) }).strict().safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ message: "Phone and conversation limit are invalid." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const phone = normalizeIndianMobile(parsed.data.phone)!;
      const [lead] = await db.select({ id: admissionsLeads.id }).from(admissionsLeads)
        .where(eq(admissionsLeads.canonicalPhone, phone)).limit(1);
      if (!lead) return void res.status(404).json({ message: "Lead not found." });
      const rows = await db.select({
        id: admissionsConversationMessages.id,
        direction: admissionsConversationMessages.direction,
        messageType: admissionsConversationMessages.messageType,
        body: admissionsConversationMessages.body,
        deliveryState: admissionsConversationMessages.deliveryState,
        providerMessageId: admissionsConversationMessages.providerMessageId,
        occurredAt: admissionsConversationMessages.occurredAt,
      }).from(admissionsConversationMessages)
        .where(eq(admissionsConversationMessages.leadId, lead.id))
        .orderBy(desc(admissionsConversationMessages.occurredAt), desc(admissionsConversationMessages.id))
        .limit(parsed.data.limit);
      return void res.json({ leadId: lead.id, items: rows.reverse() });
    } catch {
      return void res.status(503).json({ message: "Conversation history is temporarily unavailable." });
    }
  });
}
