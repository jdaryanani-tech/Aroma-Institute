import { sql } from "drizzle-orm";
import {
  boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { admissionsLeads } from "./admissions-schema";
import { inquiries } from "./schema";
import { lmsCourses, lmsLiveSessions, lmsNotifications, lmsUsers } from "./lms-schema";

export const calendarResources = pgTable("calendar_resources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  location: text("location"),
  capacity: integer("capacity"),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").notNull().references(() => lmsUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("calendar_resources_kind", sql`${table.kind} IN ('classroom','lab','equipment','location','other')`),
  check("calendar_resources_capacity", sql`${table.capacity} IS NULL OR ${table.capacity} > 0`),
  index("calendar_resources_active_idx").on(table.active, table.kind),
]);

export const calendarBatches = pgTable("calendar_batches", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => lmsCourses.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  status: text("status").notNull().default("planned"),
  createdBy: integer("created_by").notNull().references(() => lmsUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("calendar_batches_status", sql`${table.status} IN ('planned','active','completed','cancelled')`),
  check("calendar_batches_range", sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
  index("calendar_batches_course_start_idx").on(table.courseId, table.startsAt),
]);

export const calendarBatchStudents = pgTable("calendar_batch_students", {
  batchId: integer("batch_id").notNull().references(() => calendarBatches.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => lmsUsers.id, { onDelete: "restrict" }),
  assignedBy: integer("assigned_by").notNull().references(() => lmsUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("calendar_batch_students_batch_student_uq").on(table.batchId, table.studentId),
  index("calendar_batch_students_student_idx").on(table.studentId),
]);

export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  eventType: text("event_type").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  allDay: boolean("all_day").notNull().default(false),
  location: text("location"),
  onlineUrl: text("online_url"),
  status: text("status").notNull().default("confirmed"),
  organizerId: integer("organizer_id").references(() => lmsUsers.id, { onDelete: "set null" }),
  ownerId: integer("owner_id").references(() => lmsUsers.id, { onDelete: "set null" }),
  leadId: uuid("lead_id").references(() => admissionsLeads.id, { onDelete: "set null" }),
  inquiryId: integer("inquiry_id").references(() => inquiries.id, { onDelete: "set null" }),
  studentId: integer("student_id").references(() => lmsUsers.id, { onDelete: "set null" }),
  courseId: integer("course_id").references(() => lmsCourses.id, { onDelete: "set null" }),
  batchId: integer("batch_id").references(() => calendarBatches.id, { onDelete: "set null" }),
  trainerId: integer("trainer_id").references(() => lmsUsers.id, { onDelete: "set null" }),
  resourceId: integer("resource_id").references(() => calendarResources.id, { onDelete: "set null" }),
  lmsLiveSessionId: integer("lms_live_session_id").unique().references(() => lmsLiveSessions.id, { onDelete: "set null" }),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  idempotencyKey: text("idempotency_key"),
  capacity: integer("capacity"),
  recurrenceRule: jsonb("recurrence_rule").$type<{
    frequency: "daily" | "weekly" | "monthly";
    interval: number;
    until: string | null;
    weekdays?: number[];
  } | null>(),
  version: integer("version").notNull().default(1),
  createdBy: integer("created_by").notNull().references(() => lmsUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("calendar_events_category", sql`${table.category} IN ('admissions','academic','workshops','staff','operations','student')`),
  check("calendar_events_status", sql`${table.status} IN ('draft','requested','confirmed','completed','cancelled','rescheduled')`),
  check("calendar_events_range", sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
  check("calendar_events_capacity", sql`${table.capacity} IS NULL OR ${table.capacity} > 0`),
  uniqueIndex("calendar_events_source_unique").on(table.sourceType, table.sourceId)
    .where(sql`${table.sourceType} IS NOT NULL AND ${table.sourceId} IS NOT NULL`),
  uniqueIndex("calendar_events_idempotency_unique").on(table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
  index("calendar_events_time_idx").on(table.startsAt, table.endsAt),
  index("calendar_events_category_time_idx").on(table.category, table.startsAt),
  index("calendar_events_resource_time_idx").on(table.resourceId, table.startsAt),
  index("calendar_events_course_time_idx").on(table.courseId, table.startsAt),
  index("calendar_events_lead_idx").on(table.leadId, table.startsAt),
]);

export const calendarEventAttendees = pgTable("calendar_event_attendees", {
  id: serial("id").primaryKey(),
  eventId: uuid("event_id").notNull().references(() => calendarEvents.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => lmsUsers.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").references(() => admissionsLeads.id, { onDelete: "cascade" }),
  inquiryId: integer("inquiry_id").references(() => inquiries.id, { onDelete: "cascade" }),
  required: boolean("required").notNull().default(true),
  status: text("status").notNull().default("invited"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("calendar_event_attendees_identity", sql`num_nonnulls(${table.userId},${table.leadId},${table.inquiryId}) = 1`),
  check("calendar_event_attendees_status", sql`${table.status} IN ('invited','accepted','declined','attended','no_show')`),
  uniqueIndex("calendar_event_attendees_user_uq").on(table.eventId, table.userId),
  uniqueIndex("calendar_event_attendees_lead_uq").on(table.eventId, table.leadId),
  uniqueIndex("calendar_event_attendees_inquiry_uq").on(table.eventId, table.inquiryId),
  index("calendar_event_attendees_user_idx").on(table.userId, table.eventId),
]);

export const staffAvailability = pgTable("staff_availability", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => lmsUsers.id, { onDelete: "cascade" }),
  weekday: integer("weekday").notNull(),
  startsAtLocal: text("starts_at_local").notNull(),
  endsAtLocal: text("ends_at_local").notNull(),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").notNull().references(() => lmsUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("staff_availability_weekday", sql`${table.weekday} BETWEEN 0 AND 6`),
  index("staff_availability_user_idx").on(table.userId, table.weekday, table.active),
]);

export const availabilityExceptions = pgTable("availability_exceptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => lmsUsers.id, { onDelete: "cascade" }),
  resourceId: integer("resource_id").references(() => calendarResources.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  kind: text("kind").notNull(),
  reason: text("reason"),
  createdBy: integer("created_by").notNull().references(() => lmsUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("availability_exceptions_identity", sql`num_nonnulls(${table.userId},${table.resourceId}) = 1`),
  check("availability_exceptions_kind", sql`${table.kind} IN ('unavailable','leave','maintenance','available_override')`),
  check("availability_exceptions_range", sql`${table.endsAt} > ${table.startsAt}`),
  index("availability_exceptions_user_time_idx").on(table.userId, table.startsAt),
  index("availability_exceptions_resource_time_idx").on(table.resourceId, table.startsAt),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => lmsUsers.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  inAppEnabled: boolean("in_app_enabled").notNull().default(true),
  pushEnabled: boolean("push_enabled").notNull().default(true),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  reminderOffsetsMinutes: integer("reminder_offsets_minutes").array().notNull().default(sql`ARRAY[1440,120]::integer[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("notification_preferences_user_category_uq").on(table.userId, table.category),
  index("notification_preferences_user_idx").on(table.userId),
]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: integer("user_id").notNull().references(() => lmsUsers.id, { onDelete: "cascade" }),
  endpointHash: text("endpoint_hash").notNull().unique(),
  subscriptionCiphertext: text("subscription_ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  appScope: text("app_scope").notNull(),
  deviceLabel: text("device_label").notNull().default("This device"),
  expirationTime: timestamp("expiration_time", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("push_subscriptions_scope", sql`${table.appScope} IN ('admin','learn')`),
  index("push_subscriptions_user_idx").on(table.userId, table.active),
]);

export const calendarReminderJobs = pgTable("calendar_reminder_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").references(() => calendarEvents.id, { onDelete: "cascade" }),
  notificationId: integer("notification_id").references(() => lmsNotifications.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => lmsUsers.id, { onDelete: "cascade" }),
  eventVersion: integer("event_version"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  state: text("state").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockToken: uuid("lock_token"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, table => [
  check("calendar_reminder_jobs_state", sql`${table.state} IN ('pending','sending','sent','failed')`),
  index("calendar_reminder_jobs_due_idx").on(table.state, table.dueAt),
]);

export const notificationDeliveryLogs = pgTable("notification_delivery_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  notificationId: integer("notification_id").notNull().references(() => lmsNotifications.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => pushSubscriptions.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  state: text("state").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  httpStatus: integer("http_status"),
  errorSummary: text("error_summary"),
}, table => [
  check("notification_delivery_logs_state", sql`${table.state} IN ('sent','failed','expired')`),
  uniqueIndex("notification_delivery_logs_attempt_uq").on(table.notificationId, table.subscriptionId, table.attemptNumber),
  index("notification_delivery_logs_notification_idx").on(table.notificationId, table.attemptedAt),
]);

export const calendarActivity = pgTable("calendar_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").references(() => calendarEvents.id, { onDelete: "set null" }),
  actorId: integer("actor_id").references(() => lmsUsers.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  oldValues: jsonb("old_values").$type<Record<string, unknown> | null>(),
  newValues: jsonb("new_values").$type<Record<string, unknown> | null>(),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("calendar_activity_event_idx").on(table.eventId, table.occurredAt),
  index("calendar_activity_actor_idx").on(table.actorId, table.occurredAt),
]);
