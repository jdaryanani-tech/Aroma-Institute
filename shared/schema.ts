import { sql } from "drizzle-orm";
import { pgTable, text, serial, jsonb, integer, timestamp, uniqueIndex, uuid, index } from "drizzle-orm/pg-core";
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
}, (t) => [index("inquiries_lead_id_idx").on(t.leadId)]);

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
