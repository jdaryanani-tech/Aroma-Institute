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
  legacyProfile: jsonb("legacy_profile").$type<Record<string, unknown> | null>(),
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

// Marketing consent is scoped to an opaque server-session hash, never a raw
// session cookie. Rows are append-only so withdrawal and policy-version changes
// remain auditable.
export const admissionsMarketingConsentEvents = pgTable("admissions_marketing_consent_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  visitorKeyHash: text("visitor_key_hash").notNull(),
  leadId: uuid("lead_id").references(() => admissionsLeads.id),
  consentStatus: text("consent_status").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  policyVersion: text("policy_version").notNull(),
  source: text("source").notNull(),
  sourcePath: text("source_path"),
}, (t) => [
  index("admissions_marketing_consent_visitor_idx").on(t.visitorKeyHash, t.occurredAt),
  index("admissions_marketing_consent_lead_idx").on(t.leadId, t.occurredAt),
  check("admissions_marketing_consent_visitor_hash", sql`${t.visitorKeyHash} ~ '^[0-9a-f]{64}$'`),
  check("admissions_marketing_consent_status", sql`${t.consentStatus} IN ('granted','denied','withdrawn')`),
  check("admissions_marketing_consent_source_path", sql`${t.sourcePath} IS NULL OR ${t.sourcePath} IN ('/','/vsl','/vsl-video','/counselling')`),
]);

// A source/touchpoint row is retained for every accepted website or Meta lead
// event. First/last touch are computed chronologically, not destructively
// overwritten on the lead or inquiry.
export const admissionsLeadTouchpoints = pgTable("admissions_lead_touchpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id").references(() => admissionsLeads.id),
  inquiryId: integer("inquiry_id"),
  sourceChannel: text("source_channel").notNull(),
  source: text("source"),
  medium: text("medium"),
  campaign: text("campaign"),
  campaignId: text("campaign_id"),
  adId: text("ad_id"),
  adsetId: text("adset_id"),
  formId: text("form_id"),
  metaLeadId: text("meta_lead_id"),
  fbc: text("fbc"),
  fbp: text("fbp"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("admissions_touchpoints_lead_time_idx").on(t.leadId, t.occurredAt),
  index("admissions_touchpoints_inquiry_time_idx").on(t.inquiryId, t.occurredAt),
  uniqueIndex("admissions_touchpoints_meta_lead_unique").on(t.metaLeadId).where(sql`${t.metaLeadId} IS NOT NULL`),
  check("admissions_touchpoint_parent_required", sql`${t.leadId} IS NOT NULL OR ${t.inquiryId} IS NOT NULL`),
]);

// The Meta lead ID is the ingestion idempotency key and explicit source
// crosswalk. The raw Meta response is deliberately not retained.
export const admissionsMetaLeadLinks = pgTable("admissions_meta_lead_links", {
  metaLeadId: text("meta_lead_id").primaryKey(),
  pageId: text("page_id").notNull(),
  formId: text("form_id"),
  campaignId: text("campaign_id"),
  adId: text("ad_id"),
  adsetId: text("adset_id"),
  leadCreatedAt: timestamp("lead_created_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  leadId: uuid("lead_id").references(() => admissionsLeads.id),
  inquiryId: integer("inquiry_id"),
  state: text("state").notNull().default("processed"),
  errorCode: text("error_code"),
}, (t) => [
  index("admissions_meta_lead_link_lead_idx").on(t.leadId),
  index("admissions_meta_lead_link_inquiry_idx").on(t.inquiryId),
  check("admissions_meta_lead_link_state", sql`${t.state} IN ('processed','review','failed')`),
  check("admissions_meta_lead_link_inquiry_required", sql`${t.inquiryId} IS NOT NULL OR ${t.state} IN ('review','failed')`),
]);

// CAPI payloads are intentionally limited to event metadata/custom data.
// No user_data or direct identifiers are stored or sent.
export const admissionsMetaEventOutbox = pgTable("admissions_meta_event_outbox", {
  eventId: text("event_id").primaryKey(),
  visitorKeyHash: text("visitor_key_hash").notNull(),
  leadId: uuid("lead_id").references(() => admissionsLeads.id),
  inquiryId: integer("inquiry_id"),
  eventName: text("event_name").notNull(),
  eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
  eventSourceUrl: text("event_source_url").notNull(),
  customData: jsonb("custom_data").$type<Record<string, string | number | boolean>>().notNull().default(sql`'{}'::jsonb`),
  state: text("state").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  responseAt: timestamp("response_at", { withTimezone: true }),
  httpStatus: integer("http_status"),
  lastError: text("last_error"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockToken: uuid("lock_token"),
}, (t) => [
  index("admissions_meta_outbox_due_idx").on(t.state, t.availableAt),
  index("admissions_meta_outbox_lead_idx").on(t.leadId, t.eventTime),
  check("admissions_meta_outbox_event", sql`${t.eventName} IN ('PageView','Lead','VslRegistered','VslProgress','VslCompleted','CounsellingSubmitted')`),
  check("admissions_meta_outbox_state", sql`${t.state} IN ('pending','sending','sent','failed','suppressed')`),
  check("admissions_meta_outbox_attempts", sql`${t.attemptCount} >= 0`),
  check("admissions_meta_outbox_visitor_hash", sql`${t.visitorKeyHash} ~ '^[0-9a-f]{64}$'`),
  check("admissions_meta_outbox_source_url", sql`${t.eventSourceUrl} !~ '[?#]' AND ${t.eventSourceUrl} ~ '^https://[^/]+(/|/vsl|/vsl-video|/counselling)$'`),
  check("admissions_meta_outbox_custom_data", sql`jsonb_typeof(${t.customData})='object'
    AND NOT (${t.customData} ? 'user_data')
    AND NOT (${t.customData} ?| ARRAY['email','phone','name','full_name','answers','questionnaire'])
    AND ${t.customData} - ARRAY['funnel_step','milestone','observed_percent'] = '{}'::jsonb`),
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
