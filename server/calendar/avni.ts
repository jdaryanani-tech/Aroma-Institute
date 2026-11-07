import type { Express } from "express";
import { and, eq, inArray, lt, gt, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { admissionsLeads } from "@shared/admissions-schema";
import { admissionsConversationMessages } from "@shared/avni-schema";
import { admissionsCrmActivities, admissionsCrmProfiles, inquiries } from "@shared/schema";
import {
  availabilityExceptions, calendarActivity, calendarEventAttendees, calendarEvents, calendarIntegrationRequests,
  calendarReminderJobs, calendarResources, staffAvailability,
} from "@shared/calendar-schema";
import { lmsLiveSessions, lmsUserRoles, lmsUsers } from "@shared/lms-schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { db, pool } from "../db";
import { calendarLockKeys, findConflicts, queueEventReminderJobs } from "./routes";
import { avniIntegrationAuth } from "../integrations/avni";

const slotRequestSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  durationMinutes: z.coerce.number().int().min(30).max(180).default(60),
  staffId: z.coerce.number().int().positive().optional(),
  resourceId: z.coerce.number().int().positive().optional(),
}).strict();
const bookingCommon = {
  phone: z.string().trim().max(32).refine((value) => normalizeIndianMobile(value) !== null),
  staffId: z.number().int().positive(),
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(30).max(180).default(60),
  confirmationMessageId: z.string().uuid(),
  resourceId: z.number().int().positive().nullable().optional(),
};
const keySchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export function counsellingBookingEligible(
  lead: { videoCompletedAt: Date | string | null; questionnaireStatus: string },
  form: { submittedAt: Date | string | null; answers: unknown } | null,
) {
  return Boolean(lead.videoCompletedAt && lead.questionnaireStatus === "completed"
    && form?.submittedAt && form.answers && typeof form.answers === "object");
}

export function explicitStudentConfirmation(
  message: { direction: string; messageType: string } | null,
  expected: "booking_confirmation" | "booking_cancellation",
) {
  return message?.direction === "inbound" && message.messageType === expected;
}

export function intervalsOverlap(
  start: Date, end: Date,
  item: { startsAt: Date; endsAt: Date | null },
) {
  return item.startsAt < end && (item.endsAt ?? new Date(item.startsAt.getTime() + 3_600_000)) > start;
}

export function hasSlotConflict(candidate: {
  start: Date; end: Date; staffId: number; resourceId?: number | null; leadId?: string | null; inquiryId?: number | null;
}, entries: Array<{
  startsAt: Date; endsAt: Date | null; status?: string; ownerId?: number | null; trainerId?: number | null;
  resourceId?: number | null; leadId?: string | null; inquiryId?: number | null; kind?: "event" | "session" | "exception";
}>) {
  return entries.some((entry) => {
    if (entry.status === "cancelled" || entry.status === "completed") return false;
    const relevant = entry.kind === "exception"
      ? entry.ownerId === candidate.staffId || (candidate.resourceId != null && entry.resourceId === candidate.resourceId)
      : entry.trainerId === candidate.staffId || entry.ownerId === candidate.staffId
        || (candidate.resourceId != null && entry.resourceId === candidate.resourceId)
        || (candidate.leadId != null && entry.leadId === candidate.leadId)
        || (candidate.inquiryId != null && entry.inquiryId === candidate.inquiryId);
    return relevant && intervalsOverlap(candidate.start, candidate.end, entry);
  });
}

function validTimezone(timezone: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return true; } catch { return false; }
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) => parts.find((item) => item.type === key)?.value ?? "";
  return {
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function nextLocalDate(day: string) {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Convert a local wall-clock time to UTC without relying on the host timezone. */
function wallTimeToUtc(day: string, minutes: number, timezone: string) {
  const [year, month, date] = day.split("-").map(Number);
  let guess = Date.UTC(year, month - 1, date, Math.floor(minutes / 60), minutes % 60);
  for (let i = 0; i < 3; i++) {
    const actual = zonedParts(new Date(guess), timezone);
    const [ay, am, ad] = actual.date.split("-").map(Number);
    const actualUtc = Date.UTC(ay, am - 1, ad, Math.floor(actual.minutes / 60), actual.minutes % 60);
    const desiredUtc = Date.UTC(year, month - 1, date, Math.floor(minutes / 60), minutes % 60);
    const delta = desiredUtc - actualUtc;
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

async function calendarIntegrationSchemaReady() {
  const { rows: [row] } = await pool.query(`SELECT
    to_regclass('calendar_events') IS NOT NULL AND
    to_regclass('calendar_event_attendees') IS NOT NULL AND
    to_regclass('staff_availability') IS NOT NULL AND
    to_regclass('availability_exceptions') IS NOT NULL AND
    to_regclass('calendar_reminder_jobs') IS NOT NULL AND
    to_regclass('admissions_conversation_messages') IS NOT NULL AS ready`);
  return row?.ready === true;
}

async function findEligibleLead(phone: string) {
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) throw new Error("invalid_phone");
  const [lead] = await db.select().from(admissionsLeads).where(eq(admissionsLeads.canonicalPhone, normalized)).limit(1);
  if (!lead) throw new Error("lead_not_found");
  if (!lead.videoCompletedAt || lead.questionnaireStatus !== "completed") throw new Error("eligibility_not_met");
  const [form] = await db.select({
    id: inquiries.id, submittedAt: inquiries.counsellingSubmittedAt, answers: inquiries.counsellingAnswers,
    leadId: inquiries.leadId,
  }).from(inquiries).where(and(
    eq(inquiries.leadId, lead.id), sql`${inquiries.counsellingAnswers} IS NOT NULL`,
    sql`${inquiries.counsellingSubmittedAt} IS NOT NULL`,
  )).orderBy(sql`${inquiries.counsellingSubmittedAt} DESC`, sql`${inquiries.id} DESC`).limit(1);
  if (!counsellingBookingEligible(lead, form ?? null)) throw new Error("questionnaire_not_verified");
  return { lead, form };
}

async function requireConfirmation(leadId: string, messageId: string, type: "booking_confirmation" | "booking_cancellation") {
  const [message] = await db.select({
    id: admissionsConversationMessages.id,
    direction: admissionsConversationMessages.direction,
    messageType: admissionsConversationMessages.messageType,
    leadId: admissionsConversationMessages.leadId,
  }).from(admissionsConversationMessages).where(and(
    eq(admissionsConversationMessages.id, messageId),
    eq(admissionsConversationMessages.leadId, leadId),
  )).limit(1);
  if (!explicitStudentConfirmation(message ?? null, type)) {
    throw new Error("explicit_confirmation_required");
  }
}

async function validateStaffAndResource(staffId: number, resourceId?: number | null) {
  const [staff] = await db.select({ id: lmsUsers.id }).from(lmsUsers).innerJoin(
    lmsUserRoles, eq(lmsUserRoles.userId, lmsUsers.id),
  ).where(and(
    eq(lmsUsers.id, staffId), eq(lmsUsers.isActive, true),
    inArray(lmsUserRoles.role, ["admin", "admissions"]),
  )).limit(1);
  if (!staff) throw new Error("staff_unavailable");
  if (resourceId) {
    const [resource] = await db.select({ id: calendarResources.id }).from(calendarResources)
      .where(and(eq(calendarResources.id, resourceId), eq(calendarResources.active, true))).limit(1);
    if (!resource) throw new Error("resource_unavailable");
  }
}

async function requireAvailableStaffSlot(input: {
  staffId: number; start: Date; end: Date; leadId: string; inquiryId: number;
  resourceId?: number | null; ignoreEventId?: string;
}) {
  const schedules = await db.select().from(staffAvailability).where(and(
    eq(staffAvailability.userId, input.staffId), eq(staffAvailability.active, true),
  ));
  const fitsSchedule = schedules.some((schedule) => {
    if (!validTimezone(schedule.timezone)) return false;
    const start = zonedParts(input.start, schedule.timezone);
    const end = zonedParts(input.end, schedule.timezone);
    const [sh, sm] = schedule.startsAtLocal.split(":").map(Number);
    const [eh, em] = schedule.endsAtLocal.split(":").map(Number);
    return start.weekday === schedule.weekday && start.date === end.date
      && start.minutes >= sh * 60 + sm && end.minutes <= eh * 60 + em
      && (!schedule.effectiveFrom || schedule.effectiveFrom <= input.start)
      && (!schedule.effectiveUntil || schedule.effectiveUntil >= input.end);
  });
  if (!fitsSchedule) throw new Error("slot_not_available");

  const [events, sessions, exceptions] = await Promise.all([
    db.select({
      startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, ownerId: calendarEvents.ownerId,
      trainerId: calendarEvents.trainerId, resourceId: calendarEvents.resourceId, leadId: calendarEvents.leadId,
      inquiryId: calendarEvents.inquiryId, status: calendarEvents.status,
    }).from(calendarEvents).where(and(
      lt(calendarEvents.startsAt, input.end),
      or(sql`${calendarEvents.endsAt} IS NULL`, gt(calendarEvents.endsAt, input.start)),
      sql`${calendarEvents.status} NOT IN ('cancelled','completed')`,
      input.ignoreEventId ? sql`${calendarEvents.id}<>${input.ignoreEventId}::uuid` : undefined,
    )),
    db.select({
      startsAt: lmsLiveSessions.startsAt, endsAt: lmsLiveSessions.endsAt,
      trainerId: lmsLiveSessions.trainerId, status: lmsLiveSessions.status,
    }).from(lmsLiveSessions).where(and(
      lt(lmsLiveSessions.startsAt, input.end),
      or(sql`${lmsLiveSessions.endsAt} IS NULL`, gt(lmsLiveSessions.endsAt, input.start)),
      eq(lmsLiveSessions.status, "scheduled"),
    )),
    db.select().from(availabilityExceptions).where(and(
      lt(availabilityExceptions.startsAt, input.end), gt(availabilityExceptions.endsAt, input.start),
      or(eq(availabilityExceptions.userId, input.staffId),
        input.resourceId ? eq(availabilityExceptions.resourceId, input.resourceId) : undefined),
    )),
  ]);
  const conflicts = [
    ...events.map((event) => ({ ...event, kind: "event" as const })),
    ...sessions.map((session) => ({ ...session, kind: "session" as const, ownerId: null, resourceId: null, leadId: null, inquiryId: null })),
    ...exceptions.filter((exception) => exception.kind !== "available_override").map((exception) => ({
      startsAt: exception.startsAt, endsAt: exception.endsAt, ownerId: exception.userId,
      trainerId: null, resourceId: exception.resourceId, kind: "exception" as const,
    })),
  ];
  if (hasSlotConflict({
    start: input.start, end: input.end, staffId: input.staffId, resourceId: input.resourceId,
    leadId: input.leadId, inquiryId: input.inquiryId,
  }, conflicts)) throw new Error("slot_not_available");
}

async function updateCrmBookingEvidence(tx: any, inquiryId: number, leadId: string, staffId: number, event: any, action: string) {
  const evidence = {
    kind: "calendar_booking",
    reference: event.id,
    source: "aichm_calendar",
    occurredAt: new Date().toISOString(),
    explicitStudentConfirmation: true,
    confirmationMessageId: event.confirmationMessageId,
  };
  const [profile] = await tx.select().from(admissionsCrmProfiles)
    .where(eq(admissionsCrmProfiles.inquiryId, inquiryId)).for("update");
  const early = ["new_enquiry", "contacted", "qualified", "vsl_shared", "vsl_watched", "form_submitted", "counselling_pending"];
  if (!profile) {
    await tx.insert(admissionsCrmProfiles).values({
      inquiryId, stage: "counselling_booked", stageEvidence: evidence,
      ownerId: staffId, updatedBy: staffId, updatedAt: new Date(), version: 1,
    });
  } else if (!profile.stage || early.includes(profile.stage) || profile.stage === "counselling_booked") {
    await tx.update(admissionsCrmProfiles).set({
      stage: "counselling_booked",
      stageEvidence: evidence,
      ownerId: profile.ownerId ?? staffId,
      updatedBy: staffId,
      updatedAt: new Date(),
      version: profile.version + 1,
    }).where(eq(admissionsCrmProfiles.inquiryId, inquiryId));
  }
  await tx.insert(admissionsCrmActivities).values({
    inquiryId,
    type: action,
    actorId: staffId,
    body: action === "counselling_booked"
      ? "Counselling appointment confirmed through the authenticated AVNI Calendar integration."
      : `Counselling appointment ${action === "counselling_cancelled" ? "cancelled" : "rescheduled"} through the authenticated AVNI Calendar integration.`,
    data: {
      eventId: event.id, leadId, confirmationMessageId: event.confirmationMessageId,
      actorSource: "avni_integration", startsAt: event.startsAt,
    },
  });
}

async function updateCrmCancellationEvidence(tx: any, inquiryId: number | null, leadId: string, staffId: number, event: any) {
  if (!inquiryId) return;
  const [profile] = await tx.select().from(admissionsCrmProfiles)
    .where(eq(admissionsCrmProfiles.inquiryId, inquiryId)).for("update");
  if (profile?.stage === "counselling_booked") {
    await tx.update(admissionsCrmProfiles).set({
      stage: "counselling_pending",
      stageEvidence: {
        kind: "calendar_booking_cancelled", reference: event.id,
        source: "aichm_calendar", occurredAt: new Date().toISOString(),
        cancellationMessageId: event.cancellationMessageId,
      },
      updatedBy: staffId, updatedAt: new Date(), version: profile.version + 1,
    }).where(eq(admissionsCrmProfiles.inquiryId, inquiryId));
    await tx.insert(admissionsCrmActivities).values({
      inquiryId, type: "stage", actorId: staffId,
      body: "Lifecycle moved to Counselling Pending after the confirmed Calendar appointment was cancelled.",
      data: { from: "counselling_booked", to: "counselling_pending", eventId: event.id, source: "aichm_calendar" },
    });
  }
}

function errorResponse(res: any, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "lead_not_found") return res.status(404).json({ message: "Lead not found." });
  if (message === "eligibility_not_met" || message === "questionnaire_not_verified") {
    return res.status(409).json({ message: "A verified VSL completion and saved counselling questionnaire are required before booking." });
  }
  if (message === "explicit_confirmation_required") return res.status(409).json({ message: "A persisted explicit student confirmation is required." });
  if (message === "staff_unavailable" || message === "resource_unavailable") return res.status(400).json({ message: "The selected staff member or resource is unavailable." });
  if (message === "slot_not_available") return res.status(409).json({ message: "The selected slot is outside staff availability or conflicts with an event, exception, resource, or prospect booking." });
  if (message === "calendar_conflict") return res.status(409).json({ message: "The selected time conflicts with another appointment or session." });
  if (message === "idempotency_conflict") return res.status(409).json({ message: "Idempotency key conflicts with a prior calendar request." });
  return res.status(503).json({ message: "Calendar scheduling is temporarily unavailable." });
}

async function lockIntegrationRequest(
  tx: any,
  requestKey: string,
  input: { staffId: number; leadId: string; inquiryId: number; resourceId?: number | null; confirmationMessageId?: string; bookingId?: string },
) {
  const keys = new Set([
    `calendar-request:${requestKey}`,
    ...calendarLockKeys({
      ownerId: input.staffId, trainerId: input.staffId, leadId: input.leadId,
      inquiryId: input.inquiryId, resourceId: input.resourceId ?? null, attendeeIds: [],
    }, input.staffId),
    ...(input.confirmationMessageId ? [`confirmation:${input.confirmationMessageId}`] : []),
    ...(input.bookingId ? [`booking:${input.bookingId}`] : []),
  ]);
  for (const lockKey of Array.from(keys).sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
  }
}

export function registerAvniCalendarRoutes(app: Express) {
  const auth = avniIntegrationAuth;

  app.get("/api/integrations/n8n/calendar/availability", auth, async (req, res) => {
    const parsed = slotRequestSchema.safeParse({
      from: req.query.from, to: req.query.to, durationMinutes: req.query.durationMinutes,
      staffId: req.query.staffId, resourceId: req.query.resourceId,
    });
    if (!parsed.success) return void res.status(400).json({ message: "Availability range or filter is invalid." });
    const input = parsed.data, from = new Date(input.from), to = new Date(input.to);
    if (to <= from || to.getTime() - from.getTime() > 14 * 86_400_000) {
      return void res.status(400).json({ message: "Availability must be requested for a range of at most 14 days." });
    }
    try {
      if (!await calendarIntegrationSchemaReady()) return void res.status(503).json({ message: "Calendar schema is not ready." });
      const scheduleRows = await db.select({
        userId: staffAvailability.userId, weekday: staffAvailability.weekday,
        startsAtLocal: staffAvailability.startsAtLocal, endsAtLocal: staffAvailability.endsAtLocal,
        timezone: staffAvailability.timezone, effectiveFrom: staffAvailability.effectiveFrom,
        effectiveUntil: staffAvailability.effectiveUntil, name: lmsUsers.displayName,
      }).from(staffAvailability).innerJoin(lmsUsers, eq(lmsUsers.id, staffAvailability.userId))
        .innerJoin(lmsUserRoles, eq(lmsUserRoles.userId, staffAvailability.userId)).where(and(
          eq(staffAvailability.active, true), eq(lmsUsers.isActive, true),
          inArray(lmsUserRoles.role, ["admin", "admissions"]),
          input.staffId ? eq(staffAvailability.userId, input.staffId) : undefined,
        ));
      const uniqueSchedules = Array.from(new Map(scheduleRows.map(row => [
        `${row.userId}:${row.weekday}:${row.startsAtLocal}:${row.endsAtLocal}:${row.timezone}:${row.effectiveFrom?.toISOString() ?? ""}:${row.effectiveUntil?.toISOString() ?? ""}`,
        row,
      ])).values());
      const staffIds = Array.from(new Set(uniqueSchedules.map(row => row.userId)));
      if (!staffIds.length) return void res.json({ timezone: "Asia/Kolkata", durationMinutes: input.durationMinutes, slots: [] });
      const events = await db.select({
        startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, ownerId: calendarEvents.ownerId,
        trainerId: calendarEvents.trainerId, resourceId: calendarEvents.resourceId, status: calendarEvents.status,
      }).from(calendarEvents).where(and(
        lt(calendarEvents.startsAt, to),
        or(sql`${calendarEvents.endsAt} IS NULL`, gt(calendarEvents.endsAt, from)),
        sql`${calendarEvents.status} NOT IN ('cancelled','completed')`,
      ));
      const sessions = await db.select({
        startsAt: lmsLiveSessions.startsAt, endsAt: lmsLiveSessions.endsAt,
        trainerId: lmsLiveSessions.trainerId, status: lmsLiveSessions.status,
      }).from(lmsLiveSessions).where(and(
        lt(lmsLiveSessions.startsAt, to),
        or(sql`${lmsLiveSessions.endsAt} IS NULL`, gt(lmsLiveSessions.endsAt, from)),
        eq(lmsLiveSessions.status, "scheduled"),
      ));
      const exceptions = await db.select().from(availabilityExceptions).where(and(
        lt(availabilityExceptions.startsAt, to), gt(availabilityExceptions.endsAt, from),
        or(inArray(availabilityExceptions.userId, staffIds),
          input.resourceId ? eq(availabilityExceptions.resourceId, input.resourceId) : undefined),
      ));
      const slots: { startsAt: string; endsAt: string; staffId: number; staffName: string | null; resourceId: number | null }[] = [];
      for (const schedule of uniqueSchedules) {
        if (!validTimezone(schedule.timezone)) continue;
        const firstDay = zonedParts(from, schedule.timezone).date;
        const lastDay = zonedParts(new Date(to.getTime() - 1), schedule.timezone).date;
        for (let day = firstDay; day <= lastDay; day = nextLocalDate(day)) {
          const [sh, sm] = schedule.startsAtLocal.split(":").map(Number);
          const [eh, em] = schedule.endsAtLocal.split(":").map(Number);
          const windowStart = sh * 60 + sm, windowEnd = eh * 60 + em;
          for (let minute = windowStart; minute + input.durationMinutes <= windowEnd; minute += 30) {
            const start = wallTimeToUtc(day, minute, schedule.timezone);
            const end = new Date(start.getTime() + input.durationMinutes * 60_000);
            if (start < from || end > to) continue;
            const localStart = zonedParts(start, schedule.timezone);
            const localEnd = zonedParts(end, schedule.timezone);
            if (localStart.weekday !== schedule.weekday || localStart.date !== localEnd.date
              || localStart.minutes < windowStart || localEnd.minutes > windowEnd) continue;
            if (schedule.effectiveFrom && schedule.effectiveFrom > start) continue;
            if (schedule.effectiveUntil && schedule.effectiveUntil < end) continue;
            const conflicts = [
              ...events.map(event => ({ ...event, kind: "event" as const })),
              ...sessions.map(session => ({ ...session, kind: "session" as const, ownerId: null, resourceId: null, leadId: null, inquiryId: null })),
              ...exceptions.filter(exception => exception.kind !== "available_override").map(exception => ({
                startsAt: exception.startsAt, endsAt: exception.endsAt, ownerId: exception.userId,
                trainerId: null, resourceId: exception.resourceId, kind: "exception" as const,
              })),
            ];
            if (hasSlotConflict({
              start, end, staffId: schedule.userId, resourceId: input.resourceId ?? null,
            }, conflicts)) continue;
            slots.push({
              startsAt: start.toISOString(), endsAt: end.toISOString(), staffId: schedule.userId,
              staffName: schedule.name, resourceId: input.resourceId ?? null,
            });
            if (slots.length >= 500) break;
          }
          if (slots.length >= 500) break;
        }
        if (slots.length >= 500) break;
      }
      return void res.json({ timezone: "Asia/Kolkata", durationMinutes: input.durationMinutes, slots });
    } catch {
      return void res.status(503).json({ message: "Availability is temporarily unavailable." });
    }
  });

  app.post("/api/integrations/n8n/calendar/bookings", auth, async (req, res) => {
    const key = keySchema.safeParse(req.get("Idempotency-Key"));
    const parsed = z.object(bookingCommon).strict().safeParse(req.body);
    if (!key.success || !parsed.success) return void res.status(400).json({ message: "Booking request is invalid." });
    try {
      if (!await calendarIntegrationSchemaReady()) return void res.status(503).json({ message: "Calendar schema is not ready." });
      const input = parsed.data, normalized = normalizeIndianMobile(input.phone)!;
      const { lead, form } = await findEligibleLead(normalized);
      await requireConfirmation(lead.id, input.confirmationMessageId, "booking_confirmation");
      await validateStaffAndResource(input.staffId, input.resourceId);
      const end = new Date(new Date(input.startsAt).getTime() + input.durationMinutes * 60_000);
      const payloadHash = createHash("sha256").update(JSON.stringify({
        leadId: lead.id, inquiryId: form.id, staffId: input.staffId, startsAt: input.startsAt,
        durationMinutes: input.durationMinutes, confirmationMessageId: input.confirmationMessageId,
        resourceId: input.resourceId ?? null,
      })).digest("hex");
      const event = await db.transaction(async tx => {
        await lockIntegrationRequest(tx, key.data, {
          staffId: input.staffId, leadId: lead.id, inquiryId: form.id,
          resourceId: input.resourceId ?? null, confirmationMessageId: input.confirmationMessageId,
        });
        const [priorRequest] = await tx.select().from(calendarIntegrationRequests)
          .where(eq(calendarIntegrationRequests.idempotencyKey, key.data)).limit(1);
        if (priorRequest) {
          if (priorRequest.action !== "book" || priorRequest.payloadHash !== payloadHash) throw new Error("idempotency_conflict");
          const [priorEvent] = await tx.select().from(calendarEvents)
            .where(eq(calendarEvents.id, priorRequest.eventId)).limit(1);
          if (!priorEvent) throw new Error("idempotency_conflict");
          return { row: priorEvent, duplicate: true };
        }
        const [existingBooking] = await tx.select().from(calendarEvents).where(and(
          eq(calendarEvents.sourceType, "counselling_booking"),
          eq(calendarEvents.sourceId, String(form.id)),
        )).for("update");
        if (existingBooking && existingBooking.status !== "cancelled") {
          await tx.insert(calendarIntegrationRequests).values({
            idempotencyKey: key.data, action: "book", payloadHash, eventId: existingBooking.id,
          });
          return { row: existingBooking, duplicate: true };
        }
        if (existingBooking?.confirmationMessageId === input.confirmationMessageId) {
          throw new Error("explicit_confirmation_required");
        }
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`confirmation:${input.confirmationMessageId}`}))`);
        const [confirmationUsed] = await tx.select({ id: calendarEvents.id }).from(calendarEvents).where(and(
          eq(calendarEvents.confirmationMessageId, input.confirmationMessageId),
          existingBooking ? sql`${calendarEvents.id}<>${existingBooking.id}::uuid` : sql`true`,
        )).limit(1);
        if (confirmationUsed) throw new Error("explicit_confirmation_required");
        await requireAvailableStaffSlot({
          staffId: input.staffId, start: new Date(input.startsAt), end, leadId: lead.id,
          inquiryId: form.id, resourceId: input.resourceId ?? null,
        });
        const conflictInput = {
          startsAt: input.startsAt, endsAt: end.toISOString(), ownerId: input.staffId,
          trainerId: null, attendeeIds: [], resourceId: input.resourceId ?? null,
          leadId: lead.id, inquiryId: form.id,
        };
        const conflicts = await findConflicts(conflictInput, input.staffId);
        if (conflicts.length) throw new Error("calendar_conflict");
        const eventValues = {
          title: "Counselling appointment",
          description: "Confirmed after verified VSL completion, saved questionnaire, and explicit student confirmation.",
          category: "admissions",
          eventType: "counselling_appointment",
          startsAt: new Date(input.startsAt),
          endsAt: end,
          timezone: "Asia/Kolkata",
          allDay: false,
          location: form.answers?.visitMode === "instituteAhmedabad" ? "Aroma Cafe Institute, Ahmedabad" : "Online counselling",
          status: "confirmed",
          organizerId: input.staffId,
          ownerId: input.staffId,
          leadId: lead.id,
          inquiryId: form.id,
          resourceId: input.resourceId ?? null,
          sourceType: "counselling_booking",
          sourceId: String(form.id),
          idempotencyKey: key.data,
          confirmationMessageId: input.confirmationMessageId,
          version: (existingBooking?.version ?? 0) + 1,
          updatedAt: new Date(),
        };
        const [created] = existingBooking
          ? await tx.update(calendarEvents).set(eventValues).where(eq(calendarEvents.id, existingBooking.id)).returning()
          : await tx.insert(calendarEvents).values({ ...eventValues, createdBy: input.staffId }).returning();
        await tx.insert(calendarEventAttendees).values([
          { eventId: created.id, leadId: lead.id, required: true, status: "accepted" },
          { eventId: created.id, inquiryId: form.id, required: true, status: "accepted" },
        ]).onConflictDoNothing();
        await tx.insert(calendarActivity).values({
          eventId: created.id, actorId: input.staffId,
          action: existingBooking ? "counselling.booking_reconfirmed" : "counselling.booking_confirmed",
          newValues: { inquiryId: form.id, startsAt: created.startsAt.toISOString(), source: "avni_integration" },
        });
        await updateCrmBookingEvidence(tx, form.id, lead.id, input.staffId, created, "counselling_booked");
        await queueEventReminderJobs(tx, created, input.staffId, [], existingBooking ? "updated" : "created");
        await tx.insert(calendarIntegrationRequests).values({
          idempotencyKey: key.data, action: "book", payloadHash, eventId: created.id,
        });
        return { row: created, duplicate: false };
      });
      return void res.status(event.duplicate ? 200 : 201).json({
        booked: true, duplicate: event.duplicate, bookingReference: event.row.id,
        leadId: lead.id, inquiryId: form.id,
        startsAt: event.row.startsAt.toISOString(), endsAt: event.row.endsAt?.toISOString() ?? null,
        status: event.row.status,
      });
    } catch (error) {
      return void errorResponse(res, error);
    }
  });

  app.patch("/api/integrations/n8n/calendar/bookings/:bookingId", auth, async (req, res) => {
    const key = keySchema.safeParse(req.get("Idempotency-Key"));
    const bookingId = z.string().uuid().safeParse(req.params.bookingId);
    const parsed = z.object({ ...bookingCommon, phone: bookingCommon.phone }).strict().safeParse(req.body);
    if (!key.success || !bookingId.success || !parsed.success) return void res.status(400).json({ message: "Reschedule request is invalid." });
    try {
      if (!await calendarIntegrationSchemaReady()) return void res.status(503).json({ message: "Calendar schema is not ready." });
      const input = parsed.data, normalized = normalizeIndianMobile(input.phone)!;
      const { lead, form } = await findEligibleLead(normalized);
      await requireConfirmation(lead.id, input.confirmationMessageId, "booking_confirmation");
      await validateStaffAndResource(input.staffId, input.resourceId);
      const end = new Date(new Date(input.startsAt).getTime() + input.durationMinutes * 60_000);
      const payloadHash = createHash("sha256").update(JSON.stringify({
        bookingId: bookingId.data, leadId: lead.id, inquiryId: form.id, staffId: input.staffId,
        startsAt: input.startsAt, durationMinutes: input.durationMinutes,
        confirmationMessageId: input.confirmationMessageId, resourceId: input.resourceId ?? null,
      })).digest("hex");
      const updated = await db.transaction(async tx => {
        await lockIntegrationRequest(tx, key.data, {
          staffId: input.staffId, leadId: lead.id, inquiryId: form.id,
          resourceId: input.resourceId ?? null, confirmationMessageId: input.confirmationMessageId,
          bookingId: bookingId.data,
        });
        const [before] = await tx.select().from(calendarEvents).where(and(
          eq(calendarEvents.id, bookingId.data), eq(calendarEvents.leadId, lead.id),
          eq(calendarEvents.inquiryId, form.id), eq(calendarEvents.sourceType, "counselling_booking"),
        )).for("update");
        if (!before || before.status === "cancelled" || before.status === "completed") throw new Error("lead_not_found");
        const [priorRequest] = await tx.select().from(calendarIntegrationRequests)
          .where(eq(calendarIntegrationRequests.idempotencyKey, key.data)).limit(1);
        if (priorRequest) {
          if (priorRequest.action !== "reschedule" || priorRequest.payloadHash !== payloadHash || priorRequest.eventId !== before.id) {
            throw new Error("idempotency_conflict");
          }
          return { row: before, duplicate: true };
        }
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`confirmation:${input.confirmationMessageId}`}))`);
        const [confirmationUsed] = await tx.select({ id: calendarEvents.id }).from(calendarEvents).where(and(
          eq(calendarEvents.confirmationMessageId, input.confirmationMessageId),
          sql`${calendarEvents.id}<>${before.id}::uuid`,
        )).limit(1);
        if (confirmationUsed) throw new Error("explicit_confirmation_required");
        await requireAvailableStaffSlot({
          staffId: input.staffId, start: new Date(input.startsAt), end, leadId: lead.id,
          inquiryId: form.id, resourceId: input.resourceId ?? null, ignoreEventId: before.id,
        });
        const conflicts = await findConflicts({
          startsAt: input.startsAt, endsAt: end.toISOString(), ownerId: input.staffId,
          resourceId: input.resourceId ?? null, leadId: lead.id, inquiryId: form.id, attendeeIds: [],
        }, input.staffId, before.id);
        if (conflicts.length) throw new Error("calendar_conflict");
        const [row] = await tx.update(calendarEvents).set({
          startsAt: new Date(input.startsAt), endsAt: end, ownerId: input.staffId,
          organizerId: input.staffId, resourceId: input.resourceId ?? null,
          confirmationMessageId: input.confirmationMessageId, idempotencyKey: key.data,
          status: "confirmed", version: before.version + 1, updatedAt: new Date(),
        }).where(eq(calendarEvents.id, before.id)).returning();
        await tx.update(calendarReminderJobs).set({
          state: "failed", lastError: "Superseded by a schedule update.", lockedAt: null, lockToken: null,
          updatedAt: new Date(),
        }).where(and(eq(calendarReminderJobs.eventId, before.id), eq(calendarReminderJobs.state, "pending")));
        await tx.insert(calendarActivity).values({
          eventId: row.id, actorId: input.staffId, action: "counselling.booking_rescheduled",
          oldValues: { startsAt: before.startsAt.toISOString(), ownerId: before.ownerId },
          newValues: { startsAt: row.startsAt.toISOString(), ownerId: row.ownerId, source: "avni_integration" },
        });
        await updateCrmBookingEvidence(tx, form.id, lead.id, input.staffId, row, "counselling_booking_rescheduled");
        await queueEventReminderJobs(tx, row, input.staffId, [], "updated");
        await tx.insert(calendarIntegrationRequests).values({
          idempotencyKey: key.data, action: "reschedule", payloadHash, eventId: row.id,
        });
        return { row, duplicate: false };
      });
      return void res.json({
        rescheduled: true, duplicate: updated.duplicate, bookingReference: updated.row.id,
        startsAt: updated.row.startsAt.toISOString(), endsAt: updated.row.endsAt?.toISOString() ?? null,
      });
    } catch (error) { return void errorResponse(res, error); }
  });

  app.post("/api/integrations/n8n/calendar/bookings/:bookingId/cancel", auth, async (req, res) => {
    const key = keySchema.safeParse(req.get("Idempotency-Key"));
    const bookingId = z.string().uuid().safeParse(req.params.bookingId);
    const parsed = z.object({
      phone: bookingCommon.phone,
      cancellationMessageId: z.string().uuid(),
    }).strict().safeParse(req.body);
    if (!key.success || !bookingId.success || !parsed.success) return void res.status(400).json({ message: "Cancellation request is invalid." });
    try {
      if (!await calendarIntegrationSchemaReady()) return void res.status(503).json({ message: "Calendar schema is not ready." });
      const normalized = normalizeIndianMobile(parsed.data.phone)!;
      const [lead] = await db.select().from(admissionsLeads).where(eq(admissionsLeads.canonicalPhone, normalized)).limit(1);
      if (!lead) throw new Error("lead_not_found");
      await requireConfirmation(lead.id, parsed.data.cancellationMessageId, "booking_cancellation");
      const payloadHash = createHash("sha256").update(JSON.stringify({
        bookingId: bookingId.data, leadId: lead.id, cancellationMessageId: parsed.data.cancellationMessageId,
      })).digest("hex");
      const result = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-request:${key.data}`}))`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lead:${lead.id}`}))`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booking:${bookingId.data}`}))`);
        const [before] = await tx.select().from(calendarEvents).where(and(
          eq(calendarEvents.id, bookingId.data), eq(calendarEvents.leadId, lead.id),
          eq(calendarEvents.sourceType, "counselling_booking"),
        )).for("update");
        if (!before) throw new Error("lead_not_found");
        const actorId = before.organizerId ?? before.ownerId;
        if (!actorId) throw new Error("staff_unavailable");
        const [priorRequest] = await tx.select().from(calendarIntegrationRequests)
          .where(eq(calendarIntegrationRequests.idempotencyKey, key.data)).limit(1);
        if (priorRequest) {
          if (priorRequest.action !== "cancel" || priorRequest.payloadHash !== payloadHash || priorRequest.eventId !== before.id) {
            throw new Error("idempotency_conflict");
          }
          return { row: before, duplicate: true };
        }
        if (before.status === "cancelled") {
          await tx.insert(calendarIntegrationRequests).values({
            idempotencyKey: key.data, action: "cancel", payloadHash, eventId: before.id,
          });
          return { row: before, duplicate: true };
        }
        const [row] = await tx.update(calendarEvents).set({
          status: "cancelled", version: before.version + 1, updatedAt: new Date(), idempotencyKey: key.data,
        }).where(eq(calendarEvents.id, before.id)).returning();
        await tx.insert(calendarActivity).values({
          eventId: row.id, actorId,
          action: "counselling.booking_cancelled",
          oldValues: { startsAt: before.startsAt.toISOString(), status: before.status },
          newValues: { status: "cancelled", source: "avni_integration", cancellationMessageId: parsed.data.cancellationMessageId },
        });
        await updateCrmCancellationEvidence(tx, before.inquiryId, lead.id, actorId, {
          ...row, cancellationMessageId: parsed.data.cancellationMessageId,
        });
        await queueEventReminderJobs(tx, row, actorId, [], "cancelled");
        await tx.insert(calendarIntegrationRequests).values({
          idempotencyKey: key.data, action: "cancel", payloadHash, eventId: row.id,
        });
        return { row, duplicate: false };
      });
      return void res.json({ cancelled: true, duplicate: result.duplicate, bookingReference: result.row.id, status: "cancelled" });
    } catch (error) { return void errorResponse(res, error); }
  });
}

