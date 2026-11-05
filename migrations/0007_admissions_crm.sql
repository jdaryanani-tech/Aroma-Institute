-- Repair only missing verification columns; never replay historical migrations.
ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "counselling_delivery_last_verified_at" timestamp with time zone;
ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "counselling_delivery_last_verified_by" integer;
CREATE TABLE IF NOT EXISTS "admissions_crm_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inquiry_id" integer NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" integer NOT NULL,
	"body" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admissions_crm_profiles" (
	"inquiry_id" integer PRIMARY KEY NOT NULL,
	"stage" text,
	"stage_evidence" jsonb,
	"owner_id" integer,
	"follow_up_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "admissions_crm_stage" CHECK ("admissions_crm_profiles"."stage" IN ('new_enquiry','contacted','qualified','vsl_shared','vsl_watched','form_submitted','counselling_pending','counselling_booked','counselling_attended','enrolled','nurture','lost'))
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admissions_crm_activities_inquiry_id_inquiries_id_fk' AND conrelid='admissions_crm_activities'::regclass) THEN
    ALTER TABLE "admissions_crm_activities" ADD CONSTRAINT "admissions_crm_activities_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admissions_crm_activities_actor_id_lms_users_id_fk' AND conrelid='admissions_crm_activities'::regclass) THEN
    ALTER TABLE "admissions_crm_activities" ADD CONSTRAINT "admissions_crm_activities_actor_id_lms_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."lms_users"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admissions_crm_profiles_inquiry_id_inquiries_id_fk' AND conrelid='admissions_crm_profiles'::regclass) THEN
    ALTER TABLE "admissions_crm_profiles" ADD CONSTRAINT "admissions_crm_profiles_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admissions_crm_profiles_owner_id_lms_users_id_fk' AND conrelid='admissions_crm_profiles'::regclass) THEN
    ALTER TABLE "admissions_crm_profiles" ADD CONSTRAINT "admissions_crm_profiles_owner_id_lms_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."lms_users"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admissions_crm_profiles_updated_by_lms_users_id_fk' AND conrelid='admissions_crm_profiles'::regclass) THEN
    ALTER TABLE "admissions_crm_profiles" ADD CONSTRAINT "admissions_crm_profiles_updated_by_lms_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."lms_users"("id");
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admissions_crm_activity_inquiry_idx" ON "admissions_crm_activities" USING btree ("inquiry_id","occurred_at");
CREATE INDEX IF NOT EXISTS "admissions_crm_owner_idx" ON "admissions_crm_profiles" USING btree ("owner_id");
CREATE INDEX IF NOT EXISTS "admissions_crm_follow_up_idx" ON "admissions_crm_profiles" USING btree ("follow_up_at");