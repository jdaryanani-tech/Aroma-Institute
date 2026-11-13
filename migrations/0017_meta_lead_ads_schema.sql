-- Install the exact additive Meta consent, attribution, lead-crosswalk, and
-- CAPI-outbox schema from historical Drizzle migration 0012. This belongs to
-- the separate CRM forward stream; do not add it to or rewrite the Drizzle
-- journal. The runner verifies the pinned Development target and absence of
-- partial/conflicting objects before executing this file.
BEGIN;

DO $$
DECLARE
  owner_had_create boolean;
BEGIN
  IF to_regrole('aichm_crm_owner') IS NULL
     OR to_regrole('aichm_app_runtime') IS NULL
     OR to_regrole('aichm_crm_migrator') IS NULL THEN
    RAISE EXCEPTION 'CRM role separation must precede Meta schema installation';
  END IF;
  IF pg_has_role('aichm_app_runtime', 'aichm_crm_owner', 'MEMBER')
     OR pg_has_role('aichm_app_runtime', 'aichm_crm_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'application runtime must not assume CRM owner or migrator';
  END IF;

  -- ALTER OWNER requires CREATE on the containing schema for the new owner.
  -- Grant it only for this transaction when it was not already available, then
  -- restore the prior state after ownership transfer.
  owner_had_create := has_schema_privilege('aichm_crm_owner', 'public', 'CREATE');
  PERFORM set_config('aichm.crm_meta_0017_owner_had_create', owner_had_create::text, true);
  IF NOT owner_had_create THEN
    EXECUTE 'GRANT CREATE ON SCHEMA public TO aichm_crm_owner';
  END IF;
  END;
$$;

CREATE TABLE IF NOT EXISTS public.admissions_marketing_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_key_hash text NOT NULL CHECK (visitor_key_hash ~ '^[0-9a-f]{64}$'),
  lead_id uuid REFERENCES public.admissions_leads(id),
  consent_status text NOT NULL CHECK (consent_status IN ('granted','denied','withdrawn')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  policy_version text NOT NULL,
  source text NOT NULL,
  source_path text CHECK (source_path IS NULL OR source_path IN ('/','/vsl','/vsl-video','/counselling'))
);
CREATE INDEX IF NOT EXISTS admissions_marketing_consent_visitor_idx
  ON public.admissions_marketing_consent_events(visitor_key_hash, occurred_at DESC);
CREATE INDEX IF NOT EXISTS admissions_marketing_consent_lead_idx
  ON public.admissions_marketing_consent_events(lead_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.admissions_lead_touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.admissions_leads(id),
  inquiry_id integer REFERENCES public.inquiries(id),
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
  ON public.admissions_lead_touchpoints(lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS admissions_touchpoints_inquiry_time_idx
  ON public.admissions_lead_touchpoints(inquiry_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS admissions_touchpoints_meta_lead_unique
  ON public.admissions_lead_touchpoints(meta_lead_id) WHERE meta_lead_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.admissions_meta_lead_links (
  meta_lead_id text PRIMARY KEY,
  page_id text NOT NULL,
  form_id text,
  campaign_id text,
  ad_id text,
  adset_id text,
  lead_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid REFERENCES public.admissions_leads(id),
  inquiry_id integer REFERENCES public.inquiries(id),
  state text NOT NULL DEFAULT 'processed' CHECK (state IN ('processed','review','failed')),
  error_code text,
  CHECK (inquiry_id IS NOT NULL OR state IN ('review','failed'))
);
CREATE INDEX IF NOT EXISTS admissions_meta_lead_link_lead_idx
  ON public.admissions_meta_lead_links(lead_id);
CREATE INDEX IF NOT EXISTS admissions_meta_lead_link_inquiry_idx
  ON public.admissions_meta_lead_links(inquiry_id);

CREATE TABLE IF NOT EXISTS public.admissions_meta_event_outbox (
  event_id text PRIMARY KEY,
  visitor_key_hash text NOT NULL CHECK (visitor_key_hash ~ '^[0-9a-f]{64}$'),
  lead_id uuid REFERENCES public.admissions_leads(id),
  inquiry_id integer REFERENCES public.inquiries(id),
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
  ON public.admissions_meta_event_outbox(state, available_at);
CREATE INDEX IF NOT EXISTS admissions_meta_outbox_lead_idx
  ON public.admissions_meta_event_outbox(lead_id, event_time);

ALTER TABLE public.admissions_marketing_consent_events OWNER TO aichm_crm_owner;
ALTER TABLE public.admissions_lead_touchpoints OWNER TO aichm_crm_owner;
ALTER TABLE public.admissions_meta_lead_links OWNER TO aichm_crm_owner;
ALTER TABLE public.admissions_meta_event_outbox OWNER TO aichm_crm_owner;

DO $$
BEGIN
  IF current_setting('aichm.crm_meta_0017_owner_had_create', true) = 'false' THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM aichm_crm_owner';
  END IF;
  END;
$$;

REVOKE ALL ON TABLE
  public.admissions_marketing_consent_events,
  public.admissions_lead_touchpoints,
  public.admissions_meta_lead_links,
  public.admissions_meta_event_outbox
  FROM PUBLIC, aichm_app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.admissions_marketing_consent_events,
  public.admissions_meta_event_outbox
  TO aichm_app_runtime;
GRANT SELECT, INSERT ON TABLE
  public.admissions_lead_touchpoints,
  public.admissions_meta_lead_links
  TO aichm_app_runtime;

COMMIT;
