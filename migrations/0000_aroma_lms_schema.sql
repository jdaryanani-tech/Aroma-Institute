CREATE TYPE "public"."lms_certificate_status" AS ENUM('not_eligible', 'eligible', 'pending_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."lms_content_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."lms_enrollment_status" AS ENUM('active', 'completed', 'suspended', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."lms_invitation_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."lms_role" AS ENUM('student', 'trainer', 'admin');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inquiries" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"program_interest" text NOT NULL,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "lms_assessment_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"enrollment_id" integer NOT NULL,
	"assessment_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"score_percent" integer NOT NULL,
	"passed" boolean NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_assessment_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"question_id" integer NOT NULL,
	"label" text NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_assessment_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL,
	"prompt" text NOT NULL,
	"explanation" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_assessment_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"assessment_id" integer NOT NULL,
	"version" integer NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"passing_percent" integer DEFAULT 100 NOT NULL,
	"show_explanations_after_attempt" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"chapter_id" integer NOT NULL,
	"title" text NOT NULL,
	"status" "lms_content_status" DEFAULT 'draft' NOT NULL,
	"active_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"live_session_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"recorded_by" integer,
	"recorded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lms_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" integer,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"enrollment_id" integer NOT NULL,
	"status" "lms_certificate_status" DEFAULT 'not_eligible' NOT NULL,
	"certificate_number" varchar(64),
	"approved_by" integer,
	"issued_at" timestamp with time zone,
	"review_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_certificates_enrollment_id_unique" UNIQUE("enrollment_id"),
	CONSTRAINT "lms_certificates_certificate_number_unique" UNIQUE("certificate_number")
);
--> statement-breakpoint
CREATE TABLE "lms_chapters" (
	"id" serial PRIMARY KEY NOT NULL,
	"module_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" "lms_content_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(120) NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "lms_content_status" DEFAULT 'draft' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_courses_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "lms_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	"status" "lms_enrollment_status" DEFAULT 'active' NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lms_invitation_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"course_id" integer NOT NULL,
	"status" "lms_invitation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses_count" integer DEFAULT 0 NOT NULL,
	"reserved_for_phone" varchar(20),
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "lms_invitation_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "lms_invitation_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"invitation_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"enrollment_id" integer NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_lesson_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"enrollment_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_lessons" (
	"id" serial PRIMARY KEY NOT NULL,
	"chapter_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"youtube_url" text,
	"duration_minutes" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"required_for_assessment" boolean DEFAULT true NOT NULL,
	"status" "lms_content_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_live_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"trainer_id" integer,
	"title" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"meet_url" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_modules" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" "lms_content_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_otp_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone_e164" varchar(20) NOT NULL,
	"provider_challenge_id" varchar(160),
	"expires_at" timestamp with time zone NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_resources_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "lms_trainer_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"trainer_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	"assigned_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_user_roles" (
	"user_id" integer NOT NULL,
	"role" "lms_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "lms_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone_e164" varchar(20) NOT NULL,
	"display_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_users_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar(255) PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lms_assessment_attempts" ADD CONSTRAINT "lms_assessment_attempts_enrollment_id_lms_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."lms_enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_assessment_attempts" ADD CONSTRAINT "lms_assessment_attempts_assessment_id_lms_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."lms_assessments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_assessment_attempts" ADD CONSTRAINT "lms_assessment_attempts_version_id_lms_assessment_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."lms_assessment_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_assessment_options" ADD CONSTRAINT "lms_assessment_options_question_id_lms_assessment_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."lms_assessment_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_assessment_questions" ADD CONSTRAINT "lms_assessment_questions_version_id_lms_assessment_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."lms_assessment_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_assessment_versions" ADD CONSTRAINT "lms_assessment_versions_assessment_id_lms_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."lms_assessments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_assessment_versions" ADD CONSTRAINT "lms_assessment_versions_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_assessments" ADD CONSTRAINT "lms_assessments_chapter_id_lms_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."lms_chapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_attendance" ADD CONSTRAINT "lms_attendance_live_session_id_lms_live_sessions_id_fk" FOREIGN KEY ("live_session_id") REFERENCES "public"."lms_live_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_attendance" ADD CONSTRAINT "lms_attendance_student_id_lms_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."lms_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_attendance" ADD CONSTRAINT "lms_attendance_recorded_by_lms_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_audit_logs" ADD CONSTRAINT "lms_audit_logs_actor_id_lms_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_certificates" ADD CONSTRAINT "lms_certificates_enrollment_id_lms_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."lms_enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_certificates" ADD CONSTRAINT "lms_certificates_approved_by_lms_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_chapters" ADD CONSTRAINT "lms_chapters_module_id_lms_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."lms_modules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_courses" ADD CONSTRAINT "lms_courses_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_enrollments" ADD CONSTRAINT "lms_enrollments_student_id_lms_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."lms_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_enrollments" ADD CONSTRAINT "lms_enrollments_course_id_lms_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."lms_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_invitation_codes" ADD CONSTRAINT "lms_invitation_codes_course_id_lms_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."lms_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_invitation_codes" ADD CONSTRAINT "lms_invitation_codes_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_invitation_redemptions" ADD CONSTRAINT "lms_invitation_redemptions_invitation_id_lms_invitation_codes_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."lms_invitation_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_invitation_redemptions" ADD CONSTRAINT "lms_invitation_redemptions_student_id_lms_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."lms_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_invitation_redemptions" ADD CONSTRAINT "lms_invitation_redemptions_enrollment_id_lms_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."lms_enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_lesson_progress" ADD CONSTRAINT "lms_lesson_progress_enrollment_id_lms_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."lms_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_lesson_progress" ADD CONSTRAINT "lms_lesson_progress_lesson_id_lms_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lms_lessons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_lessons" ADD CONSTRAINT "lms_lessons_chapter_id_lms_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."lms_chapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_live_sessions" ADD CONSTRAINT "lms_live_sessions_course_id_lms_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."lms_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_live_sessions" ADD CONSTRAINT "lms_live_sessions_trainer_id_lms_users_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_modules" ADD CONSTRAINT "lms_modules_course_id_lms_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."lms_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_notifications" ADD CONSTRAINT "lms_notifications_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_resources" ADD CONSTRAINT "lms_resources_lesson_id_lms_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lms_lessons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_resources" ADD CONSTRAINT "lms_resources_uploaded_by_lms_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_trainer_assignments" ADD CONSTRAINT "lms_trainer_assignments_trainer_id_lms_users_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."lms_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_trainer_assignments" ADD CONSTRAINT "lms_trainer_assignments_course_id_lms_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."lms_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_trainer_assignments" ADD CONSTRAINT "lms_trainer_assignments_assigned_by_lms_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."lms_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_user_roles" ADD CONSTRAINT "lms_user_roles_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lms_assessment_attempts_enrollment_assessment_number_uq" ON "lms_assessment_attempts" USING btree ("enrollment_id","assessment_id","attempt_number");--> statement-breakpoint
CREATE INDEX "lms_assessment_attempts_enrollment_idx" ON "lms_assessment_attempts" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "lms_assessment_attempts_assessment_idx" ON "lms_assessment_attempts" USING btree ("assessment_id");--> statement-breakpoint
CREATE INDEX "lms_assessment_options_question_position_idx" ON "lms_assessment_options" USING btree ("question_id","position");--> statement-breakpoint
CREATE INDEX "lms_assessment_questions_version_position_idx" ON "lms_assessment_questions" USING btree ("version_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "lms_assessment_versions_assessment_version_uq" ON "lms_assessment_versions" USING btree ("assessment_id","version");--> statement-breakpoint
CREATE INDEX "lms_assessment_versions_assessment_idx" ON "lms_assessment_versions" USING btree ("assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lms_assessments_chapter_uq" ON "lms_assessments" USING btree ("chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lms_attendance_session_student_uq" ON "lms_attendance" USING btree ("live_session_id","student_id");--> statement-breakpoint
CREATE INDEX "lms_audit_logs_created_idx" ON "lms_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "lms_audit_logs_actor_idx" ON "lms_audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "lms_audit_logs_entity_idx" ON "lms_audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "lms_certificates_status_idx" ON "lms_certificates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lms_chapters_module_position_idx" ON "lms_chapters" USING btree ("module_id","position");--> statement-breakpoint
CREATE INDEX "lms_courses_status_idx" ON "lms_courses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "lms_enrollments_student_course_uq" ON "lms_enrollments" USING btree ("student_id","course_id");--> statement-breakpoint
CREATE INDEX "lms_enrollments_course_status_idx" ON "lms_enrollments" USING btree ("course_id","status");--> statement-breakpoint
CREATE INDEX "lms_enrollments_student_status_idx" ON "lms_enrollments" USING btree ("student_id","status");--> statement-breakpoint
CREATE INDEX "lms_invitation_codes_course_idx" ON "lms_invitation_codes" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "lms_invitation_codes_status_expiry_idx" ON "lms_invitation_codes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lms_invitation_redemptions_invitation_student_uq" ON "lms_invitation_redemptions" USING btree ("invitation_id","student_id");--> statement-breakpoint
CREATE INDEX "lms_invitation_redemptions_student_idx" ON "lms_invitation_redemptions" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lms_lesson_progress_enrollment_lesson_uq" ON "lms_lesson_progress" USING btree ("enrollment_id","lesson_id");--> statement-breakpoint
CREATE INDEX "lms_lesson_progress_enrollment_idx" ON "lms_lesson_progress" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "lms_lessons_chapter_position_idx" ON "lms_lessons" USING btree ("chapter_id","position");--> statement-breakpoint
CREATE INDEX "lms_lessons_status_idx" ON "lms_lessons" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lms_live_sessions_course_start_idx" ON "lms_live_sessions" USING btree ("course_id","starts_at");--> statement-breakpoint
CREATE INDEX "lms_modules_course_position_idx" ON "lms_modules" USING btree ("course_id","position");--> statement-breakpoint
CREATE INDEX "lms_notifications_user_created_idx" ON "lms_notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "lms_otp_challenges_phone_created_idx" ON "lms_otp_challenges" USING btree ("phone_e164","created_at");--> statement-breakpoint
CREATE INDEX "lms_otp_challenges_expiry_idx" ON "lms_otp_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "lms_resources_lesson_idx" ON "lms_resources" USING btree ("lesson_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lms_trainer_assignments_trainer_course_uq" ON "lms_trainer_assignments" USING btree ("trainer_id","course_id");--> statement-breakpoint
CREATE INDEX "lms_trainer_assignments_course_idx" ON "lms_trainer_assignments" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "lms_users_active_idx" ON "lms_users" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "sessions_expire_idx" ON "sessions" USING btree ("expire");