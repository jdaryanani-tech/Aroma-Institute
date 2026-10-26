CREATE TABLE "lms_auth_rate_limits" (
	"key_hash" varchar(64) PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_password_setup_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_password_setup_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "lms_users" ADD COLUMN "password_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "lms_password_setup_tokens" ADD CONSTRAINT "lms_password_setup_tokens_user_id_lms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lms_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lms_auth_rate_limits_window_idx" ON "lms_auth_rate_limits" USING btree ("window_started_at");--> statement-breakpoint
CREATE INDEX "lms_password_setup_tokens_user_idx" ON "lms_password_setup_tokens" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "lms_password_setup_tokens_expiry_idx" ON "lms_password_setup_tokens" USING btree ("expires_at");