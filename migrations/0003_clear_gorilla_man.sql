ALTER TABLE "inquiries" ADD COLUMN IF NOT EXISTS "counselling_answers" jsonb;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "counselling_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "counselling_delivery_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "counselling_delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "counselling_delivery_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "counselling_delivery_last_result" text;--> statement-breakpoint
UPDATE "inquiries"
SET "counselling_delivery_status" = 'untracked'
WHERE "counselling_answers" IS NOT NULL;