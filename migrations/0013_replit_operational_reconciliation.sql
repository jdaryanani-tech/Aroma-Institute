-- AICHM Replit PostgreSQL operational reconciliation, version 0013.
--
-- This is an additive/idempotent description of objects found missing in the
-- 2026-11-07 production catalog audit. The production database's Drizzle ledger
-- contains only migrations 0000-0002 while later app tables already exist.
-- Do not run `drizzle-kit migrate` against that drifted ledger. Production
-- schema changes must go through Replit's reviewed Publish schema diff.
-- Supabase is not referenced by this migration.

ALTER TYPE lms_role ADD VALUE IF NOT EXISTS 'admissions';
ALTER TYPE lms_role ADD VALUE IF NOT EXISTS 'academic_coordinator';
ALTER TYPE lms_role ADD VALUE IF NOT EXISTS 'operations';

ALTER TABLE admissions_leads ADD COLUMN IF NOT EXISTS video_observed_percent integer NOT NULL DEFAULT 0;
ALTER TABLE admissions_leads ADD COLUMN IF NOT EXISTS video_last_milestone text;
ALTER TABLE admissions_leads ADD COLUMN IF NOT EXISTS video_last_event_at timestamptz;
ALTER TABLE admissions_leads ADD COLUMN IF NOT EXISTS video_completed_at timestamptz;
ALTER TABLE admissions_leads ADD COLUMN IF NOT EXISTS legacy_profile jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admissions_leads_video_observed_percent'
    AND conrelid='admissions_leads'::regclass) THEN
    ALTER TABLE admissions_leads ADD CONSTRAINT admissions_leads_video_observed_percent
      CHECK (video_observed_percent BETWEEN 0 AND 100);
  END IF;
END $$;

ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS submission_source text NOT NULL DEFAULT 'public_form';
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS submission_idempotency_key text;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS submission_payload_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS inquiries_submission_idempotency_unique
  ON inquiries(submission_idempotency_key) WHERE submission_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS admissions_lead_contact_preferences (
  lead_id uuid PRIMARY KEY REFERENCES admissions_leads(id),
  consent_status text NOT NULL DEFAULT 'not_provided',
  consent_recorded_at timestamptz,
  consent_source text,
  consent_text text,
  consent_version text,
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  opted_out_at timestamptz,
  opt_out_source text,
  CONSTRAINT admissions_contact_consent_status
    CHECK (consent_status IN ('not_provided','granted','opted_out'))
);
CREATE TABLE IF NOT EXISTS admissions_registration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES admissions_leads(id),
  event_type text NOT NULL DEFAULT 'vsl.registered',
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  response_at timestamptz,
  acknowledged_at timestamptz,
  last_http_status integer,
  last_error text,
  locked_at timestamptz,
  lock_token uuid,
  CONSTRAINT admissions_registration_outbox_state
    CHECK (state IN ('pending','sending','acknowledged','failed')),
  CONSTRAINT admissions_registration_outbox_attempts CHECK (attempt_count >= 0)
);
CREATE INDEX IF NOT EXISTS admissions_registration_outbox_due_idx
  ON admissions_registration_outbox(state,available_at);
CREATE INDEX IF NOT EXISTS admissions_registration_outbox_lead_idx
  ON admissions_registration_outbox(lead_id);

CREATE TABLE IF NOT EXISTS admissions_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES admissions_leads(id) ON DELETE CASCADE,
  inquiry_id integer REFERENCES inquiries(id) ON DELETE SET NULL,
  canonical_phone text NOT NULL,
  direction text NOT NULL,
  message_type text NOT NULL DEFAULT 'text',
  body text NOT NULL,
  provider text NOT NULL DEFAULT 'whatsapp',
  provider_message_id text,
  idempotency_key text NOT NULL,
  delivery_state text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text,
  source_record_id text,
  source_message_side text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT admissions_conversation_messages_direction_ck CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT admissions_conversation_messages_delivery_ck CHECK (delivery_state IN ('received','pending','sent','failed','unknown')),
  CONSTRAINT admissions_conversation_messages_phone_ck CHECK (canonical_phone ~ '^91[6-9][0-9]{9}$'),
  CONSTRAINT admissions_conversation_messages_type_ck CHECK (length(message_type) BETWEEN 1 AND 80),
  CONSTRAINT admissions_conversation_messages_body_ck CHECK (length(body) <= 12000)
);
CREATE UNIQUE INDEX IF NOT EXISTS admissions_conversation_messages_idempotency_uq
  ON admissions_conversation_messages(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS admissions_conversation_messages_provider_id_uq
  ON admissions_conversation_messages(provider,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admissions_conversation_messages_source_uq
  ON admissions_conversation_messages(source_system,source_record_id,source_message_side)
  WHERE source_system IS NOT NULL AND source_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS admissions_conversation_messages_lead_time_idx
  ON admissions_conversation_messages(lead_id,occurred_at,id);
CREATE INDEX IF NOT EXISTS admissions_conversation_messages_phone_time_idx
  ON admissions_conversation_messages(canonical_phone,occurred_at);

CREATE TABLE IF NOT EXISTS admissions_legacy_lead_links (
  source_system text NOT NULL,
  source_lead_id uuid NOT NULL,
  lead_id uuid REFERENCES admissions_leads(id) ON DELETE CASCADE,
  match_status text NOT NULL DEFAULT 'review',
  legacy_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at timestamptz,
  reviewed_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admissions_legacy_lead_links_status_ck CHECK (match_status IN ('review','linked','distinct','held')),
  CONSTRAINT admissions_legacy_lead_links_source_pk PRIMARY KEY(source_system,source_lead_id)
);
CREATE INDEX IF NOT EXISTS admissions_legacy_lead_links_lead_idx ON admissions_legacy_lead_links(lead_id);

CREATE TABLE IF NOT EXISTS lms_course_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text,
  source_record_id uuid,
  slug text NOT NULL,
  category text NOT NULL,
  question text,
  answer text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'draft',
  priority integer NOT NULL DEFAULT 100,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lms_course_knowledge_source_uq
  ON lms_course_knowledge(source_system,source_record_id)
  WHERE source_system IS NOT NULL AND source_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lms_course_knowledge_slug_uq ON lms_course_knowledge(slug);
CREATE INDEX IF NOT EXISTS lms_course_knowledge_status_category_idx
  ON lms_course_knowledge(status,category,priority);

-- Existing Calendar schema definitions (migration 0010) are intentionally
-- restated here because none of those tables exist in the audited production
-- catalog. This avoids replaying unrelated historical migrations.
ALTER TABLE lms_notifications ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
ALTER TABLE lms_notifications ADD COLUMN IF NOT EXISTS link text;
ALTER TABLE lms_notifications ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE lms_notifications ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS lms_notifications_idempotency_key_uq
  ON lms_notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS calendar_resources (
  id serial PRIMARY KEY, name text NOT NULL, kind text NOT NULL, location text, capacity integer,
  active boolean NOT NULL DEFAULT true, created_by integer NOT NULL REFERENCES lms_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_resources_kind CHECK (kind IN ('classroom','lab','equipment','location','other')),
  CONSTRAINT calendar_resources_capacity CHECK (capacity IS NULL OR capacity>0)
);
CREATE INDEX IF NOT EXISTS calendar_resources_active_idx ON calendar_resources(active,kind);
CREATE TABLE IF NOT EXISTS calendar_batches (
  id serial PRIMARY KEY, course_id integer NOT NULL REFERENCES lms_courses(id) ON DELETE RESTRICT,
  name text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', status text NOT NULL DEFAULT 'planned',
  created_by integer NOT NULL REFERENCES lms_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_batches_status CHECK (status IN ('planned','active','completed','cancelled')),
  CONSTRAINT calendar_batches_range CHECK (ends_at IS NULL OR ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS calendar_batches_course_start_idx ON calendar_batches(course_id,starts_at);
CREATE TABLE IF NOT EXISTS calendar_batch_students (
  batch_id integer NOT NULL REFERENCES calendar_batches(id) ON DELETE CASCADE,
  student_id integer NOT NULL REFERENCES lms_users(id) ON DELETE RESTRICT,
  assigned_by integer NOT NULL REFERENCES lms_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_batch_students_batch_student_uq UNIQUE(batch_id,student_id)
);
CREATE INDEX IF NOT EXISTS calendar_batch_students_student_idx ON calendar_batch_students(student_id);
CREATE TABLE IF NOT EXISTS staff_availability (
  id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES lms_users(id) ON DELETE CASCADE,
  weekday integer NOT NULL, starts_at_local text NOT NULL, ends_at_local text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', effective_from timestamptz, effective_until timestamptz,
  active boolean NOT NULL DEFAULT true, created_by integer NOT NULL REFERENCES lms_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_availability_weekday CHECK (weekday BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS staff_availability_user_idx ON staff_availability(user_id,weekday,active);
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id serial PRIMARY KEY, user_id integer REFERENCES lms_users(id) ON DELETE CASCADE,
  resource_id integer REFERENCES calendar_resources(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, kind text NOT NULL, reason text,
  created_by integer NOT NULL REFERENCES lms_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_identity CHECK (num_nonnulls(user_id,resource_id)=1),
  CONSTRAINT availability_exceptions_kind CHECK (kind IN ('unavailable','leave','maintenance','available_override')),
  CONSTRAINT availability_exceptions_range CHECK (ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS availability_exceptions_user_time_idx ON availability_exceptions(user_id,starts_at);
CREATE INDEX IF NOT EXISTS availability_exceptions_resource_time_idx ON availability_exceptions(resource_id,starts_at);

CREATE TABLE IF NOT EXISTS calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text,
  category text NOT NULL, event_type text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', all_day boolean NOT NULL DEFAULT false,
  location text, online_url text, status text NOT NULL DEFAULT 'confirmed',
  organizer_id integer REFERENCES lms_users(id) ON DELETE SET NULL,
  owner_id integer REFERENCES lms_users(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES admissions_leads(id) ON DELETE SET NULL,
  inquiry_id integer REFERENCES inquiries(id) ON DELETE SET NULL,
  student_id integer REFERENCES lms_users(id) ON DELETE SET NULL,
  course_id integer REFERENCES lms_courses(id) ON DELETE SET NULL,
  batch_id integer REFERENCES calendar_batches(id) ON DELETE SET NULL,
  trainer_id integer REFERENCES lms_users(id) ON DELETE SET NULL,
  resource_id integer REFERENCES calendar_resources(id) ON DELETE SET NULL,
  lms_live_session_id integer UNIQUE REFERENCES lms_live_sessions(id) ON DELETE SET NULL,
  source_type text, source_id text, idempotency_key text,
  confirmation_message_id uuid REFERENCES admissions_conversation_messages(id) ON DELETE SET NULL,
  capacity integer, recurrence_rule jsonb, version integer NOT NULL DEFAULT 1,
  created_by integer NOT NULL REFERENCES lms_users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_category CHECK (category IN ('admissions','academic','workshops','staff','operations','student')),
  CONSTRAINT calendar_events_status CHECK (status IN ('draft','requested','confirmed','completed','cancelled','rescheduled')),
  CONSTRAINT calendar_events_range CHECK (ends_at IS NULL OR ends_at>starts_at),
  CONSTRAINT calendar_events_capacity CHECK (capacity IS NULL OR capacity>0)
);
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS confirmation_message_id uuid
  REFERENCES admissions_conversation_messages(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_source_unique
  ON calendar_events(source_type,source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_idempotency_unique
  ON calendar_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_confirmation_message_uq
  ON calendar_events(confirmation_message_id) WHERE confirmation_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS calendar_integration_requests (
  idempotency_key text PRIMARY KEY,
  action text NOT NULL,
  payload_hash text NOT NULL,
  event_id uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_integration_requests_action_ck CHECK (action IN ('book','reschedule','cancel')),
  CONSTRAINT calendar_integration_requests_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS calendar_integration_requests_event_idx
  ON calendar_integration_requests(event_id,created_at);
CREATE INDEX IF NOT EXISTS calendar_events_time_idx ON calendar_events(starts_at,ends_at);
CREATE INDEX IF NOT EXISTS calendar_events_category_time_idx ON calendar_events(category,starts_at);
CREATE INDEX IF NOT EXISTS calendar_events_resource_time_idx ON calendar_events(resource_id,starts_at);
CREATE INDEX IF NOT EXISTS calendar_events_course_time_idx ON calendar_events(course_id,starts_at);
CREATE INDEX IF NOT EXISTS calendar_events_lead_idx ON calendar_events(lead_id,starts_at);
CREATE TABLE IF NOT EXISTS calendar_event_attendees (
  id serial PRIMARY KEY, event_id uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id integer REFERENCES lms_users(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES admissions_leads(id) ON DELETE CASCADE,
  inquiry_id integer REFERENCES inquiries(id) ON DELETE CASCADE,
  required boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'invited',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_event_attendees_identity CHECK (num_nonnulls(user_id,lead_id,inquiry_id)=1),
  CONSTRAINT calendar_event_attendees_status CHECK (status IN ('invited','accepted','declined','attended','no_show'))
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_attendees_user_uq ON calendar_event_attendees(event_id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_attendees_lead_uq ON calendar_event_attendees(event_id,lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_attendees_inquiry_uq ON calendar_event_attendees(event_id,inquiry_id);
CREATE INDEX IF NOT EXISTS calendar_event_attendees_user_idx ON calendar_event_attendees(user_id,event_id);
CREATE TABLE IF NOT EXISTS notification_preferences (
  id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES lms_users(id) ON DELETE CASCADE,
  category text NOT NULL, in_app_enabled boolean NOT NULL DEFAULT true, push_enabled boolean NOT NULL DEFAULT true,
  quiet_hours_start text, quiet_hours_end text, timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  reminder_offsets_minutes integer[] NOT NULL DEFAULT ARRAY[1440,120]::integer[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_user_category_uq UNIQUE(user_id,category)
);
CREATE INDEX IF NOT EXISTS notification_preferences_user_idx ON notification_preferences(user_id);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id integer NOT NULL REFERENCES lms_users(id) ON DELETE CASCADE,
  endpoint_hash text NOT NULL UNIQUE, subscription_ciphertext text NOT NULL, nonce text NOT NULL,
  app_scope text NOT NULL, device_label text NOT NULL DEFAULT 'This device', expiration_time timestamptz,
  active boolean NOT NULL DEFAULT true, last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_scope CHECK (app_scope IN ('admin','learn'))
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id,active);
CREATE TABLE IF NOT EXISTS calendar_reminder_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES calendar_events(id) ON DELETE CASCADE,
  notification_id integer REFERENCES lms_notifications(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES lms_users(id) ON DELETE CASCADE,
  event_version integer, idempotency_key text NOT NULL UNIQUE, due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending', attempt_count integer NOT NULL DEFAULT 0,
  locked_at timestamptz, lock_token uuid, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT calendar_reminder_jobs_state CHECK (state IN ('pending','sending','sent','failed'))
);
CREATE INDEX IF NOT EXISTS calendar_reminder_jobs_due_idx ON calendar_reminder_jobs(state,due_at);
CREATE TABLE IF NOT EXISTS notification_delivery_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id integer NOT NULL REFERENCES lms_notifications(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL, state text NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now(),
  http_status integer, error_summary text,
  CONSTRAINT notification_delivery_logs_state CHECK (state IN ('sent','failed','expired')),
  CONSTRAINT notification_delivery_logs_attempt_uq UNIQUE(notification_id,subscription_id,attempt_number)
);
CREATE INDEX IF NOT EXISTS notification_delivery_logs_notification_idx
  ON notification_delivery_logs(notification_id,attempted_at);
CREATE TABLE IF NOT EXISTS calendar_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid REFERENCES calendar_events(id) ON DELETE SET NULL,
  actor_id integer REFERENCES lms_users(id) ON DELETE SET NULL, action text NOT NULL,
  old_values jsonb, new_values jsonb, reason text, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_activity_event_idx ON calendar_activity(event_id,occurred_at);
CREATE INDEX IF NOT EXISTS calendar_activity_actor_idx ON calendar_activity(actor_id,occurred_at);
