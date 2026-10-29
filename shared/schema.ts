import { sql } from "drizzle-orm";
import { pgTable, text, serial, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const counsellingAnswerValues = {
  ageRange: ["under18", "18to20", "21to24", "25plus"],
  currentSituation: ["completed12th", "college", "graduated", "workingOther", "other"],
  coffeeExperience: ["none", "personal", "internship", "professional"],
  careerGoal: ["firstCafeJob", "careerChange", "buildSkills", "openCafe", "explore"],
  scheduleReadiness: ["ready", "needDetails", "unsure"],
  counsellingTopics: [
    "programSchedule",
    "internshipTerms",
    "skillsCertification",
    "careerPreparation",
    "feesScholarshipPayment",
    "parentGuardian",
  ],
  guardianInvolvement: ["yes", "maybe", "no"],
} as const;

export const counsellingAnswersSchema = z.object({
  ageRange: z.enum(counsellingAnswerValues.ageRange),
  currentSituation: z.enum(counsellingAnswerValues.currentSituation),
  coffeeExperience: z.enum(counsellingAnswerValues.coffeeExperience),
  careerGoal: z.enum(counsellingAnswerValues.careerGoal),
  scheduleReadiness: z.enum(counsellingAnswerValues.scheduleReadiness),
  counsellingTopics: z.array(z.enum(counsellingAnswerValues.counsellingTopics)).min(1).max(6),
  guardianInvolvement: z.enum(counsellingAnswerValues.guardianInvolvement),
  additionalQuestion: z.string().trim().max(500).optional(),
});

export type CounsellingAnswers = z.infer<typeof counsellingAnswersSchema>;

export const inquiries = pgTable("inquiries", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  programInterest: text("program_interest").notNull(),
  message: text("message"),
  counsellingAnswers: jsonb("counselling_answers").$type<CounsellingAnswers>(),
});

export const insertInquirySchema = createInsertSchema(inquiries).omit({
  id: true,
}).extend({
  email: z.string().email("Please enter a valid email address"),
  phone: z.string().min(10, "Please enter a valid phone number"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  programInterest: z.string().min(1, "Please select a program"),
  counsellingAnswers: counsellingAnswersSchema.optional(),
});

export type InsertInquiry = z.infer<typeof insertInquirySchema>;
export type Inquiry = typeof inquiries.$inferSelect;
