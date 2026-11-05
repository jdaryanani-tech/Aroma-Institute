CREATE TABLE IF NOT EXISTS "admissions_lead_contact_preferences" (
	"lead_id" uuid PRIMARY KEY NOT NULL,
	"consent_status" text DEFAULT 'not_provided' NOT NULL,
	"consent_recorded_at" timestamp with time zone,
	"consent_source" text,
	"consent_text" text,
	"consent_version" text,
	"status_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opted_out_at" timestamp with time zone,
	"opt_out_source" text,
	CONSTRAINT "admissions_contact_consent_status" CHECK ("admissions_lead_contact_preferences"."consent_status" IN ('not_provided','granted','opted_out'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admissions_registration_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"event_type" text DEFAULT 'vsl.registered' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"response_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"last_http_status" integer,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"lock_token" uuid,
	CONSTRAINT "admissions_registration_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "admissions_registration_outbox_state" CHECK ("admissions_registration_outbox"."state" IN ('pending','sending','acknowledged','failed')),
	CONSTRAINT "admissions_registration_outbox_attempts" CHECK ("admissions_registration_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname='admissions_lead_contact_preferences_lead_id_admissions_leads_id_fk'
    AND conrelid='admissions_lead_contact_preferences'::regclass) THEN
    ALTER TABLE "admissions_lead_contact_preferences" ADD CONSTRAINT "admissions_lead_contact_preferences_lead_id_admissions_leads_id_fk"
      FOREIGN KEY ("lead_id") REFERENCES "public"."admissions_leads"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname='admissions_registration_outbox_lead_id_admissions_leads_id_fk'
    AND conrelid='admissions_registration_outbox'::regclass) THEN
    ALTER TABLE "admissions_registration_outbox" ADD CONSTRAINT "admissions_registration_outbox_lead_id_admissions_leads_id_fk"
      FOREIGN KEY ("lead_id") REFERENCES "public"."admissions_leads"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admissions_registration_outbox_due_idx" ON "admissions_registration_outbox" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admissions_registration_outbox_lead_idx" ON "admissions_registration_outbox" USING btree ("lead_id");