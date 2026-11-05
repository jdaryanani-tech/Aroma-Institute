-- Additive only. No historical row updates, deletes, or automatic deduplication.
CREATE TABLE IF NOT EXISTS "admissions_capture_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admissions_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_phone" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_at" timestamp with time zone,
	"last_registered_at" timestamp with time zone,
	"entry_source" text,
	"entry_path" text,
	"entry_host" text,
	"questionnaire_status" text DEFAULT 'not_submitted' NOT NULL,
	"questionnaire_completed_at" timestamp with time zone,
	"legacy_match_status" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "admissions_leads_canonical_phone_unique" UNIQUE("canonical_phone"),
	CONSTRAINT "admissions_leads_indian_phone" CHECK ("admissions_leads"."canonical_phone" ~ '^91[6-9][0-9]{9}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admissions_vsl_playbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"session_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone,
	"last_position" double precision,
	"duration" double precision,
	"ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admissions_vsl_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"event" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"position_seconds" double precision,
	"duration_seconds" double precision,
	CONSTRAINT "admissions_vsl_event_kind" CHECK ("admissions_vsl_events"."event" IN ('started', '25', '50', '75', '90', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "lead_id" uuid;--> statement-breakpoint
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admissions_vsl_playbacks_lead_id_admissions_leads_id_fk' AND conrelid = 'admissions_vsl_playbacks'::regclass) THEN
ALTER TABLE "admissions_vsl_playbacks" ADD CONSTRAINT "admissions_vsl_playbacks_lead_id_admissions_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "admissions_leads"("id");
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admissions_vsl_events_lead_id_admissions_leads_id_fk' AND conrelid = 'admissions_vsl_events'::regclass) THEN
ALTER TABLE "admissions_vsl_events" ADD CONSTRAINT "admissions_vsl_events_lead_id_admissions_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "admissions_leads"("id");
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_lead_id_admissions_leads_id_fk' AND conrelid = 'inquiries'::regclass) THEN
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_lead_id_admissions_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "admissions_leads"("id");
END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admissions_playbacks_lead_idx" ON "admissions_vsl_playbacks" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admissions_vsl_event_unique" ON "admissions_vsl_events" USING btree ("lead_id","event");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inquiries_lead_id_idx" ON "inquiries" USING btree ("lead_id");