ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "submission_source" text DEFAULT 'public_form' NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "submission_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "submission_payload_hash" text;--> statement-breakpoint
ALTER TABLE "admissions_leads" ADD COLUMN IF NOT EXISTS "video_observed_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admissions_leads" ADD COLUMN IF NOT EXISTS "video_last_milestone" text;--> statement-breakpoint
ALTER TABLE "admissions_leads" ADD COLUMN IF NOT EXISTS "video_last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admissions_leads" ADD COLUMN IF NOT EXISTS "video_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inquiries_submission_idempotency_unique" ON "inquiries" USING btree ("submission_idempotency_key") WHERE "inquiries"."submission_idempotency_key" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admissions_leads_video_observed_percent'
    AND conrelid='admissions_leads'::regclass) THEN
    ALTER TABLE "admissions_leads" ADD CONSTRAINT "admissions_leads_video_observed_percent"
      CHECK ("video_observed_percent" BETWEEN 0 AND 100);
  END IF;
END $$;