ALTER TYPE "public"."lms_role" ADD VALUE IF NOT EXISTS 'admissions';--> statement-breakpoint
ALTER TYPE "public"."lms_role" ADD VALUE IF NOT EXISTS 'academic_coordinator';--> statement-breakpoint
ALTER TYPE "public"."lms_role" ADD VALUE IF NOT EXISTS 'operations';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "availability_exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"resource_id" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_exceptions_identity" CHECK (num_nonnulls("availability_exceptions"."user_id","availability_exceptions"."resource_id") = 1),
	CONSTRAINT "availability_exceptions_kind" CHECK ("availability_exceptions"."kind" IN ('unavailable','leave','maintenance','available_override')),
	CONSTRAINT "availability_exceptions_range" CHECK ("availability_exceptions"."ends_at" > "availability_exceptions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"actor_id" integer,
	"action" text NOT NULL,
	"old_values" jsonb,
	"new_values" jsonb,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_batch_students" (
	"batch_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"assigned_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_batches_status" CHECK ("calendar_batches"."status" IN ('planned','active','completed','cancelled')),
	CONSTRAINT "calendar_batches_range" CHECK ("calendar_batches"."ends_at" IS NULL OR "calendar_batches"."ends_at" > "calendar_batches"."starts_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_event_attendees" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" integer,
	"lead_id" uuid,
	"inquiry_id" integer,
	"required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_attendees_identity" CHECK (num_nonnulls("calendar_event_attendees"."user_id","calendar_event_attendees"."lead_id","calendar_event_attendees"."inquiry_id") = 1),
	CONSTRAINT "calendar_event_attendees_status" CHECK ("calendar_event_attendees"."status" IN ('invited','accepted','declined','attended','no_show'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"event_type" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"location" text,
	"online_url" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"organizer_id" integer,
	"owner_id" integer,
	"lead_id" uuid,
	"inquiry_id" integer,
	"student_id" integer,
	"course_id" integer,
	"batch_id" integer,
	"trainer_id" integer,
	"resource_id" integer,
	"lms_live_session_id" integer,
	"source_type" text,
	"source_id" text,
	"idempotency_key" text,
	"capacity" integer,
	"recurrence_rule" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_lms_live_session_id_unique" UNIQUE("lms_live_session_id"),
	CONSTRAINT "calendar_events_category" CHECK ("calendar_events"."category" IN ('admissions','academic','workshops','staff','operations','student')),
	CONSTRAINT "calendar_events_status" CHECK ("calendar_events"."status" IN ('draft','requested','confirmed','completed','cancelled','rescheduled')),
	CONSTRAINT "calendar_events_range" CHECK ("calendar_events"."ends_at" IS NULL OR "calendar_events"."ends_at" > "calendar_events"."starts_at"),
	CONSTRAINT "calendar_events_capacity" CHECK ("calendar_events"."capacity" IS NULL OR "calendar_events"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_reminder_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"notification_id" integer,
	"user_id" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"lock_token" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "calendar_reminder_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "calendar_reminder_jobs_state" CHECK ("calendar_reminder_jobs"."state" IN ('pending','sending','sent','failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"location" text,
	"capacity" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_resources_kind" CHECK ("calendar_resources"."kind" IN ('classroom','lab','equipment','location','other')),
	CONSTRAINT "calendar_resources_capacity" CHECK ("calendar_resources"."capacity" IS NULL OR "calendar_resources"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_delivery_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" integer NOT NULL,
	"subscription_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"state" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"error_summary" text,
	CONSTRAINT "notification_delivery_logs_state" CHECK ("notification_delivery_logs"."state" IN ('sent','failed','expired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"category" text NOT NULL,
	"in_app_enabled" boolean DEFAULT true NOT NULL,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"reminder_offsets_minutes" integer[] DEFAULT ARRAY[1440,120]::integer[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"endpoint_hash" text NOT NULL,
	"subscription_ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"app_scope" text NOT NULL,
	"device_label" text DEFAULT 'This device' NOT NULL,
	"expiration_time" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_hash_unique" UNIQUE("endpoint_hash"),
	CONSTRAINT "push_subscriptions_scope" CHECK ("push_subscriptions"."app_scope" IN ('admin','learn'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_availability" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"weekday" integer NOT NULL,
	"starts_at_local" text NOT NULL,
	"ends_at_local" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_until" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_availability_weekday" CHECK ("staff_availability"."weekday" BETWEEN 0 AND 6)
);
--> statement-breakpoint
ALTER TABLE "lms_notifications" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "lms_notifications" ADD COLUMN IF NOT EXISTS "link" text;--> statement-breakpoint
ALTER TABLE "lms_notifications" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lms_notifications" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='availability_exceptions_user_id_lms_users_id_fk' AND conrelid='public.availability_exceptions'::regclass) THEN ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='availability_exceptions_resource_id_calendar_resources_id_fk' AND conrelid='public.availability_exceptions'::regclass) THEN ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_resource_id_calendar_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."calendar_resources"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='availability_exceptions_created_by_lms_users_id_fk' AND conrelid='public.availability_exceptions'::regclass) THEN ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_activity_event_id_calendar_events_id_fk' AND conrelid='public.calendar_activity'::regclass) THEN ALTER TABLE "calendar_activity" ADD CONSTRAINT "calendar_activity_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_activity_actor_id_lms_users_id_fk' AND conrelid='public.calendar_activity'::regclass) THEN ALTER TABLE "calendar_activity" ADD CONSTRAINT "calendar_activity_actor_id_lms_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_batch_students_batch_id_calendar_batches_id_fk' AND conrelid='public.calendar_batch_students'::regclass) THEN ALTER TABLE "calendar_batch_students" ADD CONSTRAINT "calendar_batch_students_batch_id_calendar_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."calendar_batches"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_batch_students_student_id_lms_users_id_fk' AND conrelid='public.calendar_batch_students'::regclass) THEN ALTER TABLE "calendar_batch_students" ADD CONSTRAINT "calendar_batch_students_student_id_lms_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."lms_users"("id") ON DELETE restrict ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_batch_students_assigned_by_lms_users_id_fk' AND conrelid='public.calendar_batch_students'::regclass) THEN ALTER TABLE "calendar_batch_students" ADD CONSTRAINT "calendar_batch_students_assigned_by_lms_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."lms_users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_batches_course_id_lms_courses_id_fk' AND conrelid='public.calendar_batches'::regclass) THEN ALTER TABLE "calendar_batches" ADD CONSTRAINT "calendar_batches_course_id_lms_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."lms_courses"("id") ON DELETE restrict ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_batches_created_by_lms_users_id_fk' AND conrelid='public.calendar_batches'::regclass) THEN ALTER TABLE "calendar_batches" ADD CONSTRAINT "calendar_batches_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_event_attendees_event_id_calendar_events_id_fk' AND conrelid='public.calendar_event_attendees'::regclass) THEN ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_event_attendees_user_id_lms_users_id_fk' AND conrelid='public.calendar_event_attendees'::regclass) THEN ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_event_attendees_lead_id_admissions_leads_id_fk' AND conrelid='public.calendar_event_attendees'::regclass) THEN ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_lead_id_admissions_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."admissions_leads"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_event_attendees_inquiry_id_inquiries_id_fk' AND conrelid='public.calendar_event_attendees'::regclass) THEN ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_organizer_id_lms_users_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organizer_id_lms_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_owner_id_lms_users_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_owner_id_lms_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_lead_id_admissions_leads_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_lead_id_admissions_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."admissions_leads"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_inquiry_id_inquiries_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_student_id_lms_users_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_student_id_lms_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_course_id_lms_courses_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_course_id_lms_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."lms_courses"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_batch_id_calendar_batches_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_batch_id_calendar_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."calendar_batches"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_trainer_id_lms_users_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_trainer_id_lms_users_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."lms_users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_resource_id_calendar_resources_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_resource_id_calendar_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."calendar_resources"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_lms_live_session_id_lms_live_sessions_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_lms_live_session_id_lms_live_sessions_id_fk" FOREIGN KEY ("lms_live_session_id") REFERENCES "public"."lms_live_sessions"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_created_by_lms_users_id_fk' AND conrelid='public.calendar_events'::regclass) THEN ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_reminder_jobs_event_id_calendar_events_id_fk' AND conrelid='public.calendar_reminder_jobs'::regclass) THEN ALTER TABLE "calendar_reminder_jobs" ADD CONSTRAINT "calendar_reminder_jobs_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_reminder_jobs_notification_id_lms_notifications_id_fk' AND conrelid='public.calendar_reminder_jobs'::regclass) THEN ALTER TABLE "calendar_reminder_jobs" ADD CONSTRAINT "calendar_reminder_jobs_notification_id_lms_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."lms_notifications"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_reminder_jobs_user_id_lms_users_id_fk' AND conrelid='public.calendar_reminder_jobs'::regclass) THEN ALTER TABLE "calendar_reminder_jobs" ADD CONSTRAINT "calendar_reminder_jobs_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_resources_created_by_lms_users_id_fk' AND conrelid='public.calendar_resources'::regclass) THEN ALTER TABLE "calendar_resources" ADD CONSTRAINT "calendar_resources_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='notification_delivery_logs_notification_id_lms_notifications_id_fk' AND conrelid='public.notification_delivery_logs'::regclass) THEN ALTER TABLE "notification_delivery_logs" ADD CONSTRAINT "notification_delivery_logs_notification_id_lms_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."lms_notifications"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='notification_delivery_logs_subscription_id_push_subscriptions_id_fk' AND conrelid='public.notification_delivery_logs'::regclass) THEN ALTER TABLE "notification_delivery_logs" ADD CONSTRAINT "notification_delivery_logs_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='notification_preferences_user_id_lms_users_id_fk' AND conrelid='public.notification_preferences'::regclass) THEN ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='push_subscriptions_user_id_lms_users_id_fk' AND conrelid='public.push_subscriptions'::regclass) THEN ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_availability_user_id_lms_users_id_fk' AND conrelid='public.staff_availability'::regclass) THEN ALTER TABLE "staff_availability" ADD CONSTRAINT "staff_availability_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_availability_created_by_lms_users_id_fk' AND conrelid='public.staff_availability'::regclass) THEN ALTER TABLE "staff_availability" ADD CONSTRAINT "staff_availability_created_by_lms_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lms_users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "availability_exceptions_user_time_idx" ON "availability_exceptions" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "availability_exceptions_resource_time_idx" ON "availability_exceptions" USING btree ("resource_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_activity_event_idx" ON "calendar_activity" USING btree ("event_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_activity_actor_idx" ON "calendar_activity" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_batch_students_batch_student_uq" ON "calendar_batch_students" USING btree ("batch_id","student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_batch_students_student_idx" ON "calendar_batch_students" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_batches_course_start_idx" ON "calendar_batches" USING btree ("course_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_attendees_user_uq" ON "calendar_event_attendees" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_attendees_lead_uq" ON "calendar_event_attendees" USING btree ("event_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_attendees_inquiry_uq" ON "calendar_event_attendees" USING btree ("event_id","inquiry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_event_attendees_user_idx" ON "calendar_event_attendees" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_events_source_unique" ON "calendar_events" USING btree ("source_type","source_id") WHERE "calendar_events"."source_type" IS NOT NULL AND "calendar_events"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_events_idempotency_unique" ON "calendar_events" USING btree ("idempotency_key") WHERE "calendar_events"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_time_idx" ON "calendar_events" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_category_time_idx" ON "calendar_events" USING btree ("category","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_resource_time_idx" ON "calendar_events" USING btree ("resource_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_course_time_idx" ON "calendar_events" USING btree ("course_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_lead_idx" ON "calendar_events" USING btree ("lead_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_reminder_jobs_due_idx" ON "calendar_reminder_jobs" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_resources_active_idx" ON "calendar_resources" USING btree ("active","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_delivery_logs_attempt_uq" ON "notification_delivery_logs" USING btree ("notification_id","subscription_id","attempt_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_delivery_logs_notification_idx" ON "notification_delivery_logs" USING btree ("notification_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_user_category_uq" ON "notification_preferences" USING btree ("user_id","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_preferences_user_idx" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_availability_user_idx" ON "staff_availability" USING btree ("user_id","weekday","active");--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lms_notifications_idempotency_key_unique' AND conrelid='public.lms_notifications'::regclass) THEN ALTER TABLE "lms_notifications" ADD CONSTRAINT "lms_notifications_idempotency_key_unique" UNIQUE("idempotency_key"); END IF; END $$;