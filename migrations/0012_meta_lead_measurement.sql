-- Additive Meta consent, source attribution, Instant Form crosswalk and CAPI outbox.
-- Apply only through the reviewed application migration workflow. This file is not
-- executed automatically by the app, build, or startup.
BEGIN;

CREATE TABLE IF NOT EXISTS admissions_marketing_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_key_hash text NOT NULL CHECK (visitor_key_hash ~ '^[0-9a-f]{64}$'),
  lead_id uuid REFERENCES admissions_leads(id),
  consent_status text NOT NULL CHECK (consent_status IN ('granted','denied','withdrawn')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  policy_version text NOT NULL,
  source text NOT NULL,
  source_path text CHECK (source_path IS NULL OR source_path IN ('/','/vsl','/vsl-video','/counselling'))
);
CREATE INDEX IF NOT EXISTS admissions_marketing_consent_visitor_idx
  ON admissions_marketing_consent_events(visitor_key_hash, occurred_at DESC);
CREATE INDEX IF NOT EXISTS admissions_marketing_consent_lead_idx
  ON admissions_marketing_consent_events(lead_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS admissions_lead_touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES admissions_leads(id),
  inquiry_id integer REFERENCES inquiries(id),
  source_channel text NOT NULL,
  source text,
  medium text,
  campaign text,
  campaign_id text,
  ad_id text,
  adset_id text,
  form_id text,
  meta_lead_id text,
  fbc text,
  fbp text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lead_id IS NOT NULL OR inquiry_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS admissions_touchpoints_lead_time_idx
  ON admissions_lead_touchpoints(lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS admissions_touchpoints_inquiry_time_idx
  ON admissions_lead_touchpoints(inquiry_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS admissions_touchpoints_meta_lead_unique
  ON admissions_lead_touchpoints(meta_lead_id) WHERE meta_lead_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admissions_meta_lead_links (
  meta_lead_id text PRIMARY KEY,
  page_id text NOT NULL,
  form_id text,
  campaign_id text,
  ad_id text,
  adset_id text,
  lead_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid REFERENCES admissions_leads(id),
  inquiry_id integer REFERENCES inquiries(id),
  state text NOT NULL DEFAULT 'processed' CHECK (state IN ('processed','review','failed')),
  error_code text,
  CHECK (inquiry_id IS NOT NULL OR state IN ('review','failed'))
);
CREATE INDEX IF NOT EXISTS admissions_meta_lead_link_lead_idx ON admissions_meta_lead_links(lead_id);
CREATE INDEX IF NOT EXISTS admissions_meta_lead_link_inquiry_idx ON admissions_meta_lead_links(inquiry_id);

CREATE TABLE IF NOT EXISTS admissions_meta_event_outbox (
  event_id text PRIMARY KEY,
  visitor_key_hash text NOT NULL CHECK (visitor_key_hash ~ '^[0-9a-f]{64}$'),
  lead_id uuid REFERENCES admissions_leads(id),
  inquiry_id integer REFERENCES inquiries(id),
  event_name text NOT NULL CHECK (event_name IN ('PageView','Lead','VslRegistered','VslProgress','VslCompleted','CounsellingSubmitted')),
  event_time timestamptz NOT NULL,
  event_source_url text NOT NULL CHECK (
    event_source_url !~ '[?#]' AND event_source_url ~ '^https://[^/]+(/|/vsl|/vsl-video|/counselling)$'
  ),
  custom_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(custom_data)='object'
    AND NOT (custom_data ? 'user_data')
    AND NOT (custom_data ?| ARRAY['email','phone','name','full_name','answers','questionnaire'])
    AND custom_data - ARRAY['funnel_step','milestone','observed_percent'] = '{}'::jsonb
  ),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','suppressed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  response_at timestamptz,
  http_status integer,
  last_error text,
  locked_at timestamptz,
  lock_token uuid
);
CREATE INDEX IF NOT EXISTS admissions_meta_outbox_due_idx
  ON admissions_meta_event_outbox(state, available_at);
CREATE INDEX IF NOT EXISTS admissions_meta_outbox_lead_idx
  ON admissions_meta_event_outbox(lead_id, event_time);

COMMIT;

