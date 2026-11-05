import { pgTable, uuid, text, timestamp, integer, doublePrecision, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const admissionsLeads = pgTable("admissions_leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  canonicalPhone: text("canonical_phone").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }),
  lastRegisteredAt: timestamp("last_registered_at", { withTimezone: true }),
  entrySource: text("entry_source"),
  entryPath: text("entry_path"),
  entryHost: text("entry_host"),
  questionnaireStatus: text("questionnaire_status").notNull().default("not_submitted"),
  questionnaireCompletedAt: timestamp("questionnaire_completed_at", { withTimezone: true }),
  videoObservedPercent: integer("video_observed_percent").notNull().default(0),
  videoLastMilestone: text("video_last_milestone"),
  videoLastEventAt: timestamp("video_last_event_at", { withTimezone: true }),
  videoCompletedAt: timestamp("video_completed_at", { withTimezone: true }),
  legacyMatchStatus: text("legacy_match_status").notNull().default("none"),
}, (t) => [
  check("admissions_leads_indian_phone", sql`${t.canonicalPhone} ~ '^91[6-9][0-9]{9}$'`),
  check("admissions_leads_video_observed_percent", sql`${t.videoObservedPercent} BETWEEN 0 AND 100`),
]);

export const admissionsPlaybacks = pgTable("admissions_vsl_playbacks", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id").notNull().references(() => admissionsLeads.id),
  sessionHash: text("session_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
  lastPosition: doublePrecision("last_position"),
  duration: doublePrecision("duration"),
  ranges: jsonb("ranges").$type<[number, number][]>().notNull().default([]),
  sequence: integer("sequence").notNull().default(0),
}, (t) => [index("admissions_playbacks_lead_idx").on(t.leadId)]);

export const admissionsVideoEvents = pgTable("admissions_vsl_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id").notNull().references(() => admissionsLeads.id),
  event: text("event").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  positionSeconds: doublePrecision("position_seconds"),
  durationSeconds: doublePrecision("duration_seconds"),
}, (t) => [
  uniqueIndex("admissions_vsl_event_unique").on(t.leadId, t.event),
  check("admissions_vsl_event_kind", sql`${t.event} IN ('started', '25', '50', '75', '90', 'completed')`),
]);

export const admissionsCaptureLimits = pgTable("admissions_capture_limits", {
  keyHash: text("key_hash").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull(),
});

// Separate one-to-one preferences keep Stage 1 usable before the additive Stage 2
// migration is applied. This is consent metadata, not a second lead identity.
export const admissionsLeadContactPreferences = pgTable("admissions_lead_contact_preferences", {
  leadId: uuid("lead_id").primaryKey().references(() => admissionsLeads.id),
  consentStatus: text("consent_status").notNull().default("not_provided"),
  consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }),
  consentSource: text("consent_source"),
  consentText: text("consent_text"),
  consentVersion: text("consent_version"),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }).defaultNow().notNull(),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
  optOutSource: text("opt_out_source"),
}, t => [check("admissions_contact_consent_status", sql`${t.consentStatus} IN ('not_provided','granted','opted_out')`)]);

export const admissionsRegistrationOutbox = pgTable("admissions_registration_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id").notNull().references(() => admissionsLeads.id),
  eventType: text("event_type").notNull().default("vsl.registered"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  state: text("state").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  responseAt: timestamp("response_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  lastHttpStatus: integer("last_http_status"),
  lastError: text("last_error"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockToken: uuid("lock_token"),
}, t => [
  index("admissions_registration_outbox_due_idx").on(t.state,t.availableAt),
  index("admissions_registration_outbox_lead_idx").on(t.leadId),
  check("admissions_registration_outbox_state",sql`${t.state} IN ('pending','sending','acknowledged','failed')`),
  check("admissions_registration_outbox_attempts",sql`${t.attemptCount} >= 0`),
]);

export type LeadJourneySummaryData = {
  leadId: string;
  registeredAt: string | null;
  lastRegisteredAt: string | null;
  entrySource: string | null;
  entryPath: string | null;
  entryHost: string | null;
  questionnaireStatus: string;
  questionnaireCompletedAt: string | null;
  videoObservedPercent: number;
  videoLastMilestone: string | null;
  videoLastEventAt: string | null;
  videoCompletedAt: string | null;
  legacyMatchStatus: string;
  linkedInquiryIds: number[];
  events: { event: string; occurredAt: string; positionSeconds: number | null; durationSeconds: number | null }[];
};
