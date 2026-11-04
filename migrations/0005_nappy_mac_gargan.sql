CREATE TABLE "counselling_delivery_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"inquiry_id" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"delivery_state" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"response_at" timestamp with time zone,
	"http_status" integer,
	"error_summary" text
);
--> statement-breakpoint
ALTER TABLE "counselling_delivery_attempts" ADD CONSTRAINT "counselling_delivery_attempts_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counselling_delivery_attempts_inquiry_attempt_unique" ON "counselling_delivery_attempts" USING btree ("inquiry_id","attempt_number");