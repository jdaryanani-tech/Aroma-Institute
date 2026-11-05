import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

const lmsResourceBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const lmsRoleEnum = pgEnum("lms_role", ["student", "trainer", "admin", "admissions", "academic_coordinator", "operations"]);
export const contentStatusEnum = pgEnum("lms_content_status", ["draft", "published", "archived"]);
export const enrollmentStatusEnum = pgEnum("lms_enrollment_status", ["active", "completed", "suspended", "withdrawn"]);
export const invitationStatusEnum = pgEnum("lms_invitation_status", ["active", "revoked"]);
export const certificateStatusEnum = pgEnum("lms_certificate_status", [
  "not_eligible",
  "eligible",
  "pending_review",
  "approved",
  "rejected",
]);

export const lmsUsers = pgTable(
  "lms_users",
  {
    id: serial("id").primaryKey(),
    phoneE164: varchar("phone_e164", { length: 20 }).notNull().unique(),
    displayName: text("display_name"),
    passwordHash: varchar("password_hash", { length: 255 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_users_active_idx").on(table.isActive)],
);

export const lmsUserRoles = pgTable(
  "lms_user_roles",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "cascade" }),
    role: lmsRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const lmsCourses = pgTable(
  "lms_courses",
  {
    id: serial("id").primaryKey(),
    slug: varchar("slug", { length: 120 }).notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: contentStatusEnum("status").notNull().default("draft"),
    createdBy: integer("created_by").references(() => lmsUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_courses_status_idx").on(table.status)],
);

export const lmsEnrollments = pgTable(
  "lms_enrollments",
  {
    id: serial("id").primaryKey(),
    studentId: integer("student_id")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "restrict" }),
    courseId: integer("course_id")
      .notNull()
      .references(() => lmsCourses.id, { onDelete: "restrict" }),
    status: enrollmentStatusEnum("status").notNull().default("active"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("lms_enrollments_student_course_uq").on(table.studentId, table.courseId),
    index("lms_enrollments_course_status_idx").on(table.courseId, table.status),
    index("lms_enrollments_student_status_idx").on(table.studentId, table.status),
  ],
);

export const lmsModules = pgTable(
  "lms_modules",
  {
    id: serial("id").primaryKey(),
    courseId: integer("course_id")
      .notNull()
      .references(() => lmsCourses.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull().default(0),
    status: contentStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_modules_course_position_idx").on(table.courseId, table.position)],
);

export const lmsChapters = pgTable(
  "lms_chapters",
  {
    id: serial("id").primaryKey(),
    moduleId: integer("module_id")
      .notNull()
      .references(() => lmsModules.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull().default(0),
    status: contentStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_chapters_module_position_idx").on(table.moduleId, table.position)],
);

export const lmsLessons = pgTable(
  "lms_lessons",
  {
    id: serial("id").primaryKey(),
    chapterId: integer("chapter_id")
      .notNull()
      .references(() => lmsChapters.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    youtubeUrl: text("youtube_url"),
    durationMinutes: integer("duration_minutes"),
    position: integer("position").notNull().default(0),
    requiredForAssessment: boolean("required_for_assessment").notNull().default(true),
    status: contentStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("lms_lessons_chapter_position_idx").on(table.chapterId, table.position),
    index("lms_lessons_status_idx").on(table.status),
  ],
);

export const lmsResources = pgTable(
  "lms_resources",
  {
    id: serial("id").primaryKey(),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lmsLessons.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    fileData: lmsResourceBytes("file_data"),
    uploadedBy: integer("uploaded_by").references(() => lmsUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_resources_lesson_idx").on(table.lessonId)],
);

export const lmsInvitationCodes = pgTable(
  "lms_invitation_codes",
  {
    id: serial("id").primaryKey(),
    codeHash: varchar("code_hash", { length: 64 }).notNull().unique(),
    courseId: integer("course_id")
      .notNull()
      .references(() => lmsCourses.id, { onDelete: "restrict" }),
    status: invitationStatusEnum("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses").notNull().default(1),
    usesCount: integer("uses_count").notNull().default(0),
    reservedForPhone: varchar("reserved_for_phone", { length: 20 }),
    createdBy: integer("created_by")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("lms_invitation_codes_course_idx").on(table.courseId),
    index("lms_invitation_codes_status_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const lmsInvitationRedemptions = pgTable(
  "lms_invitation_redemptions",
  {
    id: serial("id").primaryKey(),
    invitationId: integer("invitation_id")
      .notNull()
      .references(() => lmsInvitationCodes.id, { onDelete: "restrict" }),
    studentId: integer("student_id")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "restrict" }),
    enrollmentId: integer("enrollment_id")
      .notNull()
      .references(() => lmsEnrollments.id, { onDelete: "restrict" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lms_invitation_redemptions_invitation_student_uq").on(table.invitationId, table.studentId),
    index("lms_invitation_redemptions_student_idx").on(table.studentId),
  ],
);

export const lmsLessonProgress = pgTable(
  "lms_lesson_progress",
  {
    id: serial("id").primaryKey(),
    enrollmentId: integer("enrollment_id")
      .notNull()
      .references(() => lmsEnrollments.id, { onDelete: "cascade" }),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lmsLessons.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lms_lesson_progress_enrollment_lesson_uq").on(table.enrollmentId, table.lessonId),
    index("lms_lesson_progress_enrollment_idx").on(table.enrollmentId),
  ],
);

export const lmsTrainerAssignments = pgTable(
  "lms_trainer_assignments",
  {
    id: serial("id").primaryKey(),
    trainerId: integer("trainer_id")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "restrict" }),
    courseId: integer("course_id")
      .notNull()
      .references(() => lmsCourses.id, { onDelete: "restrict" }),
    assignedBy: integer("assigned_by")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lms_trainer_assignments_trainer_course_uq").on(table.trainerId, table.courseId),
    index("lms_trainer_assignments_course_idx").on(table.courseId),
  ],
);

export const lmsAssessments = pgTable(
  "lms_assessments",
  {
    id: serial("id").primaryKey(),
    chapterId: integer("chapter_id")
      .notNull()
      .references(() => lmsChapters.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    status: contentStatusEnum("status").notNull().default("draft"),
    activeVersion: integer("active_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("lms_assessments_chapter_uq").on(table.chapterId)],
);

export const lmsAssessmentVersions = pgTable(
  "lms_assessment_versions",
  {
    id: serial("id").primaryKey(),
    assessmentId: integer("assessment_id")
      .notNull()
      .references(() => lmsAssessments.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    instructions: text("instructions").notNull().default(""),
    passingPercent: integer("passing_percent").notNull().default(100),
    showExplanationsAfterAttempt: boolean("show_explanations_after_attempt").notNull().default(false),
    createdBy: integer("created_by").references(() => lmsUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lms_assessment_versions_assessment_version_uq").on(table.assessmentId, table.version),
    index("lms_assessment_versions_assessment_idx").on(table.assessmentId),
  ],
);

export const lmsAssessmentQuestions = pgTable(
  "lms_assessment_questions",
  {
    id: serial("id").primaryKey(),
    versionId: integer("version_id")
      .notNull()
      .references(() => lmsAssessmentVersions.id, { onDelete: "restrict" }),
    prompt: text("prompt").notNull(),
    explanation: text("explanation"),
    position: integer("position").notNull().default(0),
  },
  (table) => [index("lms_assessment_questions_version_position_idx").on(table.versionId, table.position)],
);

export const lmsAssessmentOptions = pgTable(
  "lms_assessment_options",
  {
    id: serial("id").primaryKey(),
    questionId: integer("question_id")
      .notNull()
      .references(() => lmsAssessmentQuestions.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    isCorrect: boolean("is_correct").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (table) => [index("lms_assessment_options_question_position_idx").on(table.questionId, table.position)],
);

export const lmsAssessmentAttempts = pgTable(
  "lms_assessment_attempts",
  {
    id: serial("id").primaryKey(),
    enrollmentId: integer("enrollment_id")
      .notNull()
      .references(() => lmsEnrollments.id, { onDelete: "restrict" }),
    assessmentId: integer("assessment_id")
      .notNull()
      .references(() => lmsAssessments.id, { onDelete: "restrict" }),
    versionId: integer("version_id")
      .notNull()
      .references(() => lmsAssessmentVersions.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    answers: jsonb("answers").$type<Record<string, number>>().notNull(),
    scorePercent: integer("score_percent").notNull(),
    passed: boolean("passed").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lms_assessment_attempts_enrollment_assessment_number_uq").on(
      table.enrollmentId,
      table.assessmentId,
      table.attemptNumber,
    ),
    index("lms_assessment_attempts_enrollment_idx").on(table.enrollmentId),
    index("lms_assessment_attempts_assessment_idx").on(table.assessmentId),
  ],
);

export const lmsLiveSessions = pgTable(
  "lms_live_sessions",
  {
    id: serial("id").primaryKey(),
    courseId: integer("course_id")
      .notNull()
      .references(() => lmsCourses.id, { onDelete: "restrict" }),
    trainerId: integer("trainer_id").references(() => lmsUsers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    topic: text("topic").notNull().default(""),
    meetUrl: text("meet_url").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: text("status").notNull().default("scheduled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_live_sessions_course_start_idx").on(table.courseId, table.startsAt)],
);

export const lmsAttendance = pgTable(
  "lms_attendance",
  {
    id: serial("id").primaryKey(),
    liveSessionId: integer("live_session_id")
      .notNull()
      .references(() => lmsLiveSessions.id, { onDelete: "restrict" }),
    studentId: integer("student_id")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("unknown"),
    recordedBy: integer("recorded_by").references(() => lmsUsers.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("lms_attendance_session_student_uq").on(table.liveSessionId, table.studentId)],
);

export const lmsCertificates = pgTable(
  "lms_certificates",
  {
    id: serial("id").primaryKey(),
    enrollmentId: integer("enrollment_id")
      .notNull()
      .unique()
      .references(() => lmsEnrollments.id, { onDelete: "restrict" }),
    status: certificateStatusEnum("status").notNull().default("not_eligible"),
    certificateNumber: varchar("certificate_number", { length: 64 }).unique(),
    approvedBy: integer("approved_by").references(() => lmsUsers.id, { onDelete: "set null" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_certificates_status_idx").on(table.status)],
);

export const lmsNotifications = pgTable(
  "lms_notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull(),
    priority: text("priority").notNull().default("normal"),
    link: text("link"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    idempotencyKey: text("idempotency_key").unique(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("lms_notifications_user_created_idx").on(table.userId, table.createdAt)],
);

export const lmsAuditLogs = pgTable(
  "lms_audit_logs",
  {
    id: serial("id").primaryKey(),
    actorId: integer("actor_id").references(() => lmsUsers.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("lms_audit_logs_created_idx").on(table.createdAt),
    index("lms_audit_logs_actor_idx").on(table.actorId),
    index("lms_audit_logs_entity_idx").on(table.entityType, table.entityId),
  ],
);

export const lmsOtpChallenges = pgTable(
  "lms_otp_challenges",
  {
    id: serial("id").primaryKey(),
    phoneE164: varchar("phone_e164", { length: 20 }).notNull(),
    providerChallengeId: varchar("provider_challenge_id", { length: 160 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resendAvailableAt: timestamp("resend_available_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("lms_otp_challenges_phone_created_idx").on(table.phoneE164, table.createdAt),
    index("lms_otp_challenges_expiry_idx").on(table.expiresAt),
  ],
);

export const lmsPasswordSetupTokens = pgTable(
  "lms_password_setup_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => lmsUsers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("lms_password_setup_tokens_user_idx").on(table.userId, table.createdAt),
    index("lms_password_setup_tokens_expiry_idx").on(table.expiresAt),
  ],
);

export const lmsAuthRateLimits = pgTable(
  "lms_auth_rate_limits",
  {
    keyHash: varchar("key_hash", { length: 64 }).primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [index("lms_auth_rate_limits_window_idx").on(table.windowStartedAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid", { length: 255 }).primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (table) => [index("sessions_expire_idx").on(table.expire)],
);
