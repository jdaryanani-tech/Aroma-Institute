import { sql } from "drizzle-orm";
import { pgTable, text, serial, jsonb, integer, timestamp, uniqueIndex, uuid, index, check } from "drizzle-orm/pg-core";
import { lmsUsers } from "./lms-schema";
import { admissionsLeads } from "./admissions-schema";
import { normalizeIndianMobile } from "./indian-mobile";
export * from "./admissions-schema";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const counsellingAnswerValues = {
  ageRange: ["under18", "18to20", "21to24", "25plus"],
  currentActivity: [
    "studying12th",
    "completed12th",
    "college",
    "graduated",
    "working",
    "notStudyingOrWorking",
    "other",
  ],
  careerReasons: [
    "startEarning",
    "careerDirection",
    "coffeeCulture",
    "practicalSkills",
    "financialIndependence",
    "hospitalityIndustry",
    "longTermCareer",
    "other",
  ],
  mainBarrier: [
    "unclearStartingPoint",
    "practicalSkills",
    "noWorkExperience",
    "unsureHowToGetCaféJob",
    "lowConfidence",
    "careerConfusion",
    "other",
  ],
  sixToTwelveMonthGoal: [
    "professionalBaristaSkills",
    "caféExperience",
    "firstCaféJob",
    "independentEarning",
    "longTermHospitalityCareer",
    "unsure",
  ],
  coffeeKnowledge: [
    "beginner",
    "someKnowledge",
    "homeCoffeeOrLatteArt",
    "professionalTraining",
    "caféWorkExperience",
  ],
  stepsTaken: [
    "onlineResearch",
    "visitedCafés",
    "appliedForJobs",
    "exploredInstitutes",
    "homeCoffeePractice",
    "noStepsYet",
    "other",
  ],
  biggestConcern: [
    "canLearnSkills",
    "careerOpportunities",
    "jobWithoutExperience",
    "rightCareer",
    "programValue",
    "feesAndInvestment",
    "familySupport",
    "other",
  ],
  desiredStart: ["asSoonAsPossible", "withinOneMonth", "withinTwoToThreeMonths", "withinThreeToSixMonths", "exploring"],
  handsOnReadiness: ["ready", "needScheduleDetails", "unsure", "notReady"],
  timeAvailability: ["fullTime", "partTime", "eveningsOrWeekends", "afterScheduleDetails"],
  decisionMaker: ["self", "family", "together", "other"],
  familyDiscussion: ["supportive", "notDiscussed", "hasConcerns", "notApplicable"],
  investmentSituation: [
    "considerIfRightFit",
    "needScholarshipDetails",
    "needPaymentTerms",
    "discussWithFamily",
    "difficultToManage",
    "understandProgramFirst",
  ],
  visitMode: ["instituteAhmedabad", "onlineCounselling"],
  preferredTime: ["10to12", "12to14", "14to16", "16to18", "flexible"],
  visitCompanion: ["alone", "parent", "parents", "friendOrGuardian"],
  counsellingLanguage: ["hinglish", "hindi", "english", "gujarati"],
  parentJoining: ["yes", "no", "maybe"],
} as const;

export function getIndiaDateString(date: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const preferredVisitDateSchema = z
  .string()
  .refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }, "Please select a valid visit date.")
  .refine(
    (value) => value >= getIndiaDateString(),
    "Please choose a date that is not in the past.",
  );

const counsellingPhoneSchema = z.string().trim().refine(
  (value) => normalizeIndianMobile(value) !== null,
  "Please enter a valid mobile or WhatsApp number.",
);

export const counsellingAnswersSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  ageRange: z.enum(counsellingAnswerValues.ageRange),
  currentActivity: z.enum(counsellingAnswerValues.currentActivity),
  city: z.string().trim().min(2).max(120),
  careerReasons: z.array(z.enum(counsellingAnswerValues.careerReasons)).min(1).max(8),
  mainBarrier: z.enum(counsellingAnswerValues.mainBarrier),
  situationImpact: z.string().trim().max(2000),
  sixToTwelveMonthGoal: z.enum(counsellingAnswerValues.sixToTwelveMonthGoal),
  coffeeKnowledge: z.enum(counsellingAnswerValues.coffeeKnowledge),
  stepsTaken: z.array(z.enum(counsellingAnswerValues.stepsTaken)).min(1).max(7),
  biggestConcern: z.enum(counsellingAnswerValues.biggestConcern),
  desiredStart: z.enum(counsellingAnswerValues.desiredStart),
  handsOnReadiness: z.enum(counsellingAnswerValues.handsOnReadiness),
  timeAvailability: z.enum(counsellingAnswerValues.timeAvailability),
  decisionMaker: z.enum(counsellingAnswerValues.decisionMaker),
  familyDiscussion: z.enum(counsellingAnswerValues.familyDiscussion),
  investmentSituation: z.enum(counsellingAnswerValues.investmentSituation),
  topQuestions: z.string().trim().max(2000),
  counsellorNote: z.string().trim().max(2000),
  visitMode: z.enum(counsellingAnswerValues.visitMode),
  preferredDate: preferredVisitDateSchema,
  preferredTime: z.enum(counsellingAnswerValues.preferredTime),
  visitCompanion: z.enum(counsellingAnswerValues.visitCompanion),
  visitFocus: z.string().trim().max(2000),
  mobileWhatsapp: counsellingPhoneSchema,
  email: z.string().trim().email().or(z.literal("")),
  counsellingLanguage: z.enum(counsellingAnswerValues.counsellingLanguage),
  parentJoining: z.enum(counsellingAnswerValues.parentJoining),
  consentToContact: z.literal(true),
});

export type CounsellingAnswers = z.infer<typeof counsellingAnswersSchema>;

export const counsellingDeliveryStatuses = [
  "not_applicable",
  "untracked",
  "pending",
  "sending",
  "retrying",
  "sent",
  "acknowledged",
  "failed",
] as const;
export type CounsellingDeliveryStatus = (typeof counsellingDeliveryStatuses)[number];

export const counsellingAttemptStates = ["sending", "acknowledged", "failed"] as const;
export type CounsellingAttemptState = (typeof counsellingAttemptStates)[number];

export const inquiries = pgTable("inquiries", {
  id: serial("id").primaryKey(),
  leadId: uuid("lead_id").references(() => admissionsLeads.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  programInterest: text("program_interest").notNull(),
  message: text("message"),
  counsellingAnswers: jsonb("counselling_answers").$type<CounsellingAnswers>(),
  counsellingSubmittedAt: timestamp("counselling_submitted_at", { withTimezone: true }),
  counsellingDeliveryStatus: text("counselling_delivery_status")
    .$type<CounsellingDeliveryStatus>()
    .notNull()
    .default("not_applicable"),
  counsellingDeliveryAttempts: integer("counselling_delivery_attempts").notNull().default(0),
  counsellingDeliveryLastAttemptAt: timestamp("counselling_delivery_last_attempt_at", { withTimezone: true }),
  counsellingDeliveryLastResult: text("counselling_delivery_last_result"),
  counsellingDeliveryLastVerifiedAt: timestamp("counselling_delivery_last_verified_at", { withTimezone: true }),
  counsellingDeliveryLastVerifiedBy: integer("counselling_delivery_last_verified_by"),
  submissionSource: text("submission_source").notNull().default("public_form"),
  submissionIdempotencyKey: text("submission_idempotency_key"),
  submissionPayloadHash: text("submission_payload_hash"),
}, (t) => [
  index("inquiries_lead_id_idx").on(t.leadId),
  uniqueIndex("inquiries_submission_idempotency_unique")
    .on(t.submissionIdempotencyKey)
    .where(sql`${t.submissionIdempotencyKey} IS NOT NULL`),
]);

export const counsellingDeliveryAttemptRecords = pgTable(
  "counselling_delivery_attempts",
  {
    id: serial("id").primaryKey(),
    inquiryId: integer("inquiry_id").notNull().references(() => inquiries.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    deliveryState: text("delivery_state").$type<CounsellingAttemptState>().notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    responseAt: timestamp("response_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    errorSummary: text("error_summary"),
  },
  (table) => [
    uniqueIndex("counselling_delivery_attempts_inquiry_attempt_unique").on(
      table.inquiryId,
      table.attemptNumber,
    ),
  ],
);
export type CounsellingDeliveryAttemptRecord = typeof counsellingDeliveryAttemptRecords.$inferSelect;

// CRM metadata is anchored to an existing inquiry. When safe identity links change,
// all metadata/history remains with its original inquiry and is grouped at read time.
export const admissionsCrmProfiles = pgTable("admissions_crm_profiles", {
  inquiryId: integer("inquiry_id").primaryKey().references(() => inquiries.id),
  stage: text("stage"),
  stageEvidence: jsonb("stage_evidence").$type<Record<string, unknown>>(),
  ownerId: integer("owner_id").references(() => lmsUsers.id),
  followUpAt: timestamp("follow_up_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: integer("updated_by").notNull().references(() => lmsUsers.id),
  version: integer("version").notNull().default(1),
}, t => [
  index("admissions_crm_owner_idx").on(t.ownerId),
  index("admissions_crm_follow_up_idx").on(t.followUpAt),
  check("admissions_crm_stage", sql`${t.stage} IN ('new_enquiry','contacted','qualified','vsl_shared','vsl_watched','form_submitted','counselling_pending','counselling_booked','counselling_attended','enrolled','nurture','lost')`),
]);
export const admissionsCrmActivities = pgTable("admissions_crm_activities", {
  id: uuid("id").primaryKey().defaultRandom(),
  inquiryId: integer("inquiry_id").notNull().references(() => inquiries.id),
  type: text("type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  actorId: integer("actor_id").notNull().references(() => lmsUsers.id),
  body: text("body"),
  data: jsonb("data").$type<Record<string, unknown>>(),
}, t => [index("admissions_crm_activity_inquiry_idx").on(t.inquiryId, t.occurredAt)]);

// Canonical ownership is one assignment per person, not one owner per inquiry.
// Existing admissions_crm_profiles.owner_id values remain inquiry-level legacy metadata.
export const admissionsLeadAssignments = pgTable("admissions_lead_assignments", {
  leadId: uuid("lead_id").primaryKey().references(() => admissionsLeads.id, { onDelete: "restrict" }),
  assigneeUserId: integer("assignee_user_id").references(() => lmsUsers.id, { onDelete: "restrict" }),
  assignedBy: integer("assigned_by").notNull().references(() => lmsUsers.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  version: integer("version").notNull().default(1),
}, t => [
  index("admissions_lead_assignments_assignee_idx").on(t.assigneeUserId, t.leadId),
  check("admissions_lead_assignments_version_ck", sql`${t.version} > 0`),
]);

export const admissionsLeadAssignmentHistory = pgTable("admissions_lead_assignment_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull().references(() => admissionsLeads.id, { onDelete: "restrict" }),
  previousAssigneeUserId: integer("previous_assignee_user_id").references(() => lmsUsers.id, { onDelete: "restrict" }),
  newAssigneeUserId: integer("new_assignee_user_id").references(() => lmsUsers.id, { onDelete: "restrict" }),
  actorUserId: integer("actor_user_id").notNull().references(() => lmsUsers.id, { onDelete: "restrict" }),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  reason: text("reason").notNull(),
  source: text("source").notNull(),
  requestId: uuid("request_id").notNull().unique(),
  assignmentVersion: integer("assignment_version").notNull(),
}, t => [
  index("admissions_lead_assignment_history_lead_time_idx").on(t.leadId, t.changedAt),
  index("admissions_lead_assignment_history_assignee_time_idx").on(t.newAssigneeUserId, t.changedAt),
 uniqueIndex("admissions_lead_assignment_history_lead_version_uidx").on(t.leadId, t.assignmentVersion),
  check("admissions_lead_assignment_history_reason_ck", sql`length(btrim(${t.reason})) BETWEEN 3 AND 1000`),
  check("admissions_lead_assignment_history_source_ck", sql`${t.source} IN ('admin_ui')`),
  check("admissions_lead_assignment_history_version_ck", sql`${t.assignmentVersion} > 0`),
  check("admissions_lead_assignment_history_changed_ck", sql`${t.previousAssigneeUserId} IS DISTINCT FROM ${t.newAssigneeUserId}`),
]);

export const insertInquirySchema = createInsertSchema(inquiries).omit({
  id: true,
  leadId: true,
  counsellingSubmittedAt: true,
  counsellingDeliveryStatus: true,
  counsellingDeliveryAttempts: true,
  counsellingDeliveryLastAttemptAt: true,
  counsellingDeliveryLastResult: true,
  counsellingDeliveryLastVerifiedAt: true,
  counsellingDeliveryLastVerifiedBy: true,
}).extend({
  email: z.string().email("Please enter a valid email address"),
  phone: z.string().min(10, "Please enter a valid phone number"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  programInterest: z.string().min(1, "Please select a program"),
  counsellingAnswers: counsellingAnswersSchema.optional(),
});

export const insertCounsellingInquirySchema = insertInquirySchema.extend({
  email: z.string().email("Please enter a valid email address").or(z.literal("")),
  phone: counsellingPhoneSchema,
  counsellingAnswers: counsellingAnswersSchema,
});

export type InsertInquiry = z.infer<typeof insertInquirySchema>;
export type InsertCounsellingInquiry = z.infer<typeof insertCounsellingInquirySchema>;
export type NewInquiry = typeof inquiries.$inferInsert;
export type Inquiry = typeof inquiries.$inferSelect;
