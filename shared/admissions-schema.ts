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
  legacyMatchStatus: text("legacy_match_status").notNull().default("none"),
}, (t) => [check("admissions_leads_indian_phone", sql`${t.canonicalPhone} ~ '^91[6-9][0-9]{9}$'`)]);

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

export type LeadJourneySummaryData = {
  leadId: string;
  registeredAt: string | null;
  lastRegisteredAt: string | null;
  entrySource: string | null;
  entryPath: string | null;
  entryHost: string | null;
  questionnaireStatus: string;
  questionnaireCompletedAt: string | null;
  legacyMatchStatus: string;
  linkedInquiryIds: number[];
  events: { event: string; occurredAt: string; positionSeconds: number | null; durationSeconds: number | null }[];
};
