import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { admissionsLeads } from "./admissions-schema";
import { inquiries } from "./schema";

/**
 * One durable row per WhatsApp message. Outbound rows are written as pending
 * before AVNI sends them; a later delivery update records provider acceptance.
 */
export const admissionsConversationMessages = pgTable(
  "admissions_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").notNull().references(() => admissionsLeads.id, { onDelete: "cascade" }),
    inquiryId: integer("inquiry_id").references(() => inquiries.id, { onDelete: "set null" }),
    canonicalPhone: text("canonical_phone").notNull(),
    direction: text("direction").notNull(),
    messageType: text("message_type").notNull().default("text"),
    body: text("body").notNull(),
    provider: text("provider").notNull().default("whatsapp"),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    deliveryState: text("delivery_state").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    sourceSystem: text("source_system"),
    sourceRecordId: text("source_record_id"),
    sourceMessageSide: text("source_message_side"),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>().notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    uniqueIndex("admissions_conversation_messages_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("admissions_conversation_messages_provider_id_uq")
      .on(table.provider, table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    uniqueIndex("admissions_conversation_messages_source_uq")
      .on(table.sourceSystem, table.sourceRecordId, table.sourceMessageSide)
      .where(sql`${table.sourceSystem} IS NOT NULL AND ${table.sourceRecordId} IS NOT NULL`),
    index("admissions_conversation_messages_lead_time_idx").on(table.leadId, table.occurredAt, table.id),
    index("admissions_conversation_messages_phone_time_idx").on(table.canonicalPhone, table.occurredAt),
    check("admissions_conversation_messages_direction_ck", sql`${table.direction} IN ('inbound','outbound')`),
    check("admissions_conversation_messages_delivery_ck", sql`${table.deliveryState} IN ('received','pending','sent','failed','unknown')`),
    check("admissions_conversation_messages_phone_ck", sql`${table.canonicalPhone} ~ '^91[6-9][0-9]{9}$'`),
    check("admissions_conversation_messages_type_ck", sql`length(${table.messageType}) BETWEEN 1 AND 80`),
    check("admissions_conversation_messages_body_ck", sql`length(${table.body}) <= 12000`),
  ],
);

/** Existing Supabase knowledge is imported with its UUID and source ID intact. */
export const lmsCourseKnowledge = pgTable(
  "lms_course_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSystem: text("source_system"),
    sourceRecordId: uuid("source_record_id"),
    slug: text("slug").notNull(),
    category: text("category").notNull(),
    question: text("question"),
    answer: text("answer").notNull(),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").notNull().default("draft"),
    priority: integer("priority").notNull().default(100),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lms_course_knowledge_source_uq")
      .on(table.sourceSystem, table.sourceRecordId)
      .where(sql`${table.sourceSystem} IS NOT NULL AND ${table.sourceRecordId} IS NOT NULL`),
    uniqueIndex("lms_course_knowledge_slug_uq").on(table.slug),
    index("lms_course_knowledge_status_category_idx").on(table.status, table.category, table.priority),
  ],
);

/** Explicit Supabase-lead-to-canonical-lead crosswalk; never merge by phone alone. */
export const admissionsLegacyLeadLinks = pgTable(
  "admissions_legacy_lead_links",
  {
    sourceSystem: text("source_system").notNull(),
    sourceLeadId: uuid("source_lead_id").notNull(),
    leadId: uuid("lead_id").references(() => admissionsLeads.id, { onDelete: "cascade" }),
    matchStatus: text("match_status").notNull().default("review"),
    legacyProfile: jsonb("legacy_profile").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: integer("reviewed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceSystem, table.sourceLeadId], name: "admissions_legacy_lead_links_source_pk" }),
    index("admissions_legacy_lead_links_lead_idx").on(table.leadId),
    check("admissions_legacy_lead_links_status_ck", sql`${table.matchStatus} IN ('review','linked','distinct','held')`),
  ],
);
