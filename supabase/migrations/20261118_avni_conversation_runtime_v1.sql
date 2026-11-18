-- Draft migration: do not apply to a live Supabase project without separate review.
-- Prerequisite: 20261107_aichm_two_database_contract.sql and the documented
-- public.leads/public.conversations base tables must be verified in an isolated DB.
-- No legacy transcript rows are copied, rewritten, or backfilled here.

BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'aichm_conversation_owner') THEN
    CREATE ROLE aichm_conversation_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'aichm_conversation_runtime') THEN
    CREATE ROLE aichm_conversation_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$role$;

ALTER ROLE aichm_conversation_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS NOREPLICATION;
ALTER ROLE aichm_conversation_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS NOREPLICATION;
DO $role_membership$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
    JOIN pg_catalog.pg_roles u ON u.oid=m.member
    WHERE r.rolname IN ('aichm_conversation_owner','aichm_conversation_runtime')
       OR u.rolname IN ('aichm_conversation_owner','aichm_conversation_runtime')
  ) THEN
    RAISE EXCEPTION 'AVNI_CONVERSATION_ROLE_MEMBERSHIP_PREEXISTS';
  END IF;
END
$role_membership$;

DO $role_attributes$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('aichm_conversation_owner','aichm_conversation_runtime')
      AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'AVNI_CONVERSATION_ROLE_ATTRIBUTES_UNSAFE';
  END IF;
END
$role_attributes$;

GRANT CREATE,USAGE ON SCHEMA aichm_private TO aichm_conversation_owner;
GRANT USAGE ON SCHEMA aichm_private TO aichm_conversation_runtime;

CREATE TABLE aichm_private.conversation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_thread_key text NOT NULL,
  supabase_lead_id uuid REFERENCES public.leads(id) ON DELETE RESTRICT,
  mapping_status text NOT NULL DEFAULT 'unmapped',
  mode text NOT NULL DEFAULT 'human',
  lifecycle text NOT NULL DEFAULT 'open',
  control_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avni_conversation_threads_provider_ck
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT avni_conversation_threads_thread_hash_ck
    CHECK (provider_thread_key ~ '^hmac-sha256:v1:[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_threads_mapping_ck
    CHECK (
      mapping_status IN ('unmapped','mapped','ambiguous','held')
      AND ((mapping_status = 'mapped') = (supabase_lead_id IS NOT NULL))
    ),
  CONSTRAINT avni_conversation_threads_mode_ck CHECK (mode IN ('ai','human')),
  CONSTRAINT avni_conversation_threads_lifecycle_ck CHECK (lifecycle IN ('open','closed')),
  CONSTRAINT avni_conversation_threads_version_ck CHECK (control_version >= 0),
  CONSTRAINT avni_conversation_threads_provider_thread_uq UNIQUE (provider,provider_thread_key)
);

CREATE UNIQUE INDEX avni_conversation_threads_mapped_lead_uq
  ON aichm_private.conversation_threads(provider,supabase_lead_id)
  WHERE mapping_status='mapped' AND supabase_lead_id IS NOT NULL;
CREATE INDEX avni_conversation_threads_lead_updated_idx
  ON aichm_private.conversation_threads(supabase_lead_id,updated_at DESC,id DESC)
  WHERE supabase_lead_id IS NOT NULL;

CREATE TABLE aichm_private.conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES aichm_private.conversation_threads(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_message_key text,
  idempotency_key text NOT NULL,
  message_fingerprint text NOT NULL,
  direction text NOT NULL,
  author text NOT NULL,
  message_type text NOT NULL DEFAULT 'text',
  body text,
  media_ref text,
  delivery_state text,
  legacy_conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avni_conversation_messages_provider_ck
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT avni_conversation_messages_provider_ref_ck
    CHECK (provider_message_key IS NULL OR provider_message_key ~ '^hmac-sha256:v1:[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_messages_idempotency_ck
    CHECK (idempotency_key ~ '^message:v1:[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_messages_fingerprint_ck
    CHECK (message_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_messages_direction_author_ck
    CHECK (
      (direction='inbound' AND author IN ('prospect','unknown'))
      OR (direction='outbound' AND author IN ('assistant','human_staff','system','unknown'))
    ),
  CONSTRAINT avni_conversation_messages_type_ck
    CHECK (message_type IN ('text','image','audio','video','document','interactive','location','unknown')),
  CONSTRAINT avni_conversation_messages_body_ck
    CHECK (body IS NULL OR length(body)<=12000),
  CONSTRAINT avni_conversation_messages_media_ref_ck
    CHECK (media_ref IS NULL OR (
      media_ref ~ '^media:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )),
  CONSTRAINT avni_conversation_messages_content_ck
    CHECK (
      (message_type='text' AND nullif(btrim(body),'') IS NOT NULL AND media_ref IS NULL)
      OR (message_type<>'text' AND (body IS NULL OR length(body)<=12000))
    ),
  CONSTRAINT avni_conversation_messages_delivery_ck
    CHECK (delivery_state IS NULL OR delivery_state IN ('queued','sent','delivered','read','failed','unknown')),
  CONSTRAINT avni_conversation_messages_inbound_delivery_ck
    CHECK (direction<>'inbound' OR delivery_state IS NULL),
  CONSTRAINT avni_conversation_messages_legacy_fk_uq UNIQUE (legacy_conversation_id)
);

CREATE UNIQUE INDEX avni_conversation_messages_provider_ref_uq
  ON aichm_private.conversation_messages(provider,provider_message_key)
  WHERE provider_message_key IS NOT NULL;
CREATE UNIQUE INDEX avni_conversation_messages_idempotency_uq
  ON aichm_private.conversation_messages(idempotency_key);
CREATE INDEX avni_conversation_messages_thread_time_idx
  ON aichm_private.conversation_messages(thread_id,occurred_at,id);
CREATE INDEX avni_conversation_messages_delivery_idx
  ON aichm_private.conversation_messages(delivery_state,received_at)
  WHERE delivery_state IS NOT NULL;

CREATE TABLE aichm_private.conversation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES aichm_private.conversation_threads(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_event_key text NOT NULL,
  idempotency_key text NOT NULL,
  event_fingerprint text NOT NULL,
  event_kind text NOT NULL,
  message_id uuid REFERENCES aichm_private.conversation_messages(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avni_conversation_events_provider_ck
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT avni_conversation_events_provider_ref_ck
    CHECK (provider_event_key ~ '^hmac-sha256:v1:[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_events_idempotency_ck
    CHECK (
      idempotency_key ~ '^event:v1:[0-9a-f]{64}$'
      AND idempotency_key='event:v1:'||split_part(provider_event_key,':',3)
    ),
  CONSTRAINT avni_conversation_events_fingerprint_ck
    CHECK (event_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_events_kind_ck CHECK (event_kind IN ('message','delivery')),
  CONSTRAINT avni_conversation_events_provider_event_uq UNIQUE (provider,provider_event_key),
  CONSTRAINT avni_conversation_events_idempotency_uq UNIQUE (idempotency_key)
);

CREATE INDEX avni_conversation_events_thread_time_idx
  ON aichm_private.conversation_events(thread_id,occurred_at DESC,id DESC);
CREATE INDEX avni_conversation_events_unlinked_idx
  ON aichm_private.conversation_events(received_at,id)
  WHERE message_id IS NULL;

CREATE TABLE aichm_private.conversation_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES aichm_private.conversation_threads(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL UNIQUE REFERENCES aichm_private.conversation_messages(id) ON DELETE RESTRICT,
  author text NOT NULL,
  actor_ref text,
  idempotency_key text NOT NULL UNIQUE,
  expected_control_version bigint NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt_count smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avni_conversation_outbox_author_ck CHECK (author IN ('assistant','human_staff')),
  CONSTRAINT avni_conversation_outbox_actor_ck
    CHECK (
      (author='assistant' AND actor_ref IS NULL)
      OR (author='human_staff' AND actor_ref ~ '^replit_lms_user:[1-9][0-9]{0,9}$')
    ),
  CONSTRAINT avni_conversation_outbox_idempotency_ck
    CHECK (idempotency_key ~ '^message:v1:[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_outbox_version_ck CHECK (expected_control_version>=0),
  CONSTRAINT avni_conversation_outbox_state_ck
    CHECK (state IN ('pending','claimed','sending','accepted','delivered','failed','unknown','cancelled')),
  CONSTRAINT avni_conversation_outbox_attempts_ck
    CHECK (max_attempts BETWEEN 1 AND 8 AND attempt_count BETWEEN 0 AND max_attempts),
  CONSTRAINT avni_conversation_outbox_lease_ck
    CHECK ((state IN ('claimed','sending')) = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX avni_conversation_outbox_due_idx
  ON aichm_private.conversation_outbox(available_at,id)
  WHERE state='pending' AND attempt_count<max_attempts;
CREATE INDEX avni_conversation_outbox_lease_idx
  ON aichm_private.conversation_outbox(lease_expires_at,id)
  WHERE state IN ('claimed','sending');
CREATE INDEX avni_conversation_outbox_thread_state_idx
  ON aichm_private.conversation_outbox(thread_id,state,created_at);

CREATE TABLE aichm_private.conversation_outbox_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES aichm_private.conversation_outbox(id) ON DELETE RESTRICT,
  attempt_number smallint NOT NULL,
  provider text NOT NULL,
  provider_message_key text,
  state text NOT NULL DEFAULT 'claimed',
  delivery_state text NOT NULL DEFAULT 'queued',
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avni_conversation_attempts_number_ck CHECK (attempt_number BETWEEN 1 AND 8),
  CONSTRAINT avni_conversation_attempts_provider_ck
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT avni_conversation_attempts_provider_ref_ck
    CHECK (provider_message_key IS NULL OR provider_message_key ~ '^hmac-sha256:v1:[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_attempts_state_ck
    CHECK (state IN ('claimed','sending','sent','delivered','read','failed','unknown','cancelled')),
  CONSTRAINT avni_conversation_attempts_delivery_ck
    CHECK (delivery_state IN ('queued','sent','delivered','read','failed','unknown')),
  CONSTRAINT avni_conversation_attempts_outbox_number_uq UNIQUE (outbox_id,attempt_number)
);

CREATE UNIQUE INDEX avni_conversation_attempts_provider_message_uq
  ON aichm_private.conversation_outbox_attempts(provider,provider_message_key)
  WHERE provider_message_key IS NOT NULL;
CREATE INDEX avni_conversation_attempts_expiry_idx
  ON aichm_private.conversation_outbox_attempts(lease_expires_at,id)
  WHERE state IN ('claimed','sending');

CREATE TABLE aichm_private.conversation_delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES aichm_private.conversation_events(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES aichm_private.conversation_outbox_attempts(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_receipt_key text NOT NULL,
  raw_provider_state text NOT NULL,
  normalized_state text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avni_conversation_receipts_provider_ck
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT avni_conversation_receipts_ref_ck
    CHECK (provider_receipt_key ~ '^hmac-sha256:v1:[0-9a-f]{64}$'),
  CONSTRAINT avni_conversation_receipts_raw_state_ck
    CHECK (raw_provider_state ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  CONSTRAINT avni_conversation_receipts_state_ck
    CHECK (normalized_state IN ('queued','sent','delivered','read','failed','unknown')),
  CONSTRAINT avni_conversation_receipts_provider_ref_uq UNIQUE (provider,provider_receipt_key)
);

CREATE INDEX avni_conversation_receipts_attempt_time_idx
  ON aichm_private.conversation_delivery_receipts(attempt_id,occurred_at,id);

CREATE TABLE aichm_private.conversation_control_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES aichm_private.conversation_threads(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE,
  action text NOT NULL,
  actor_ref text NOT NULL,
  reason text,
  prior_version bigint NOT NULL,
  resulting_version bigint NOT NULL,
  whatsapp_consent_granted boolean,
  whatsapp_opted_out boolean,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avni_conversation_control_action_ck CHECK (action IN ('lead_linked','takeover','resume')),
  CONSTRAINT avni_conversation_control_actor_ck
    CHECK (actor_ref ~ '^(replit_lms_user:[1-9][0-9]{0,9}|system:[a-z][a-z0-9_-]{0,39})$'),
  CONSTRAINT avni_conversation_control_reason_ck
    CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT avni_conversation_control_versions_ck
    CHECK (prior_version>=0 AND resulting_version=prior_version+1),
  CONSTRAINT avni_conversation_control_resume_evidence_ck CHECK (
    (action='resume' AND whatsapp_consent_granted IS NOT NULL AND whatsapp_opted_out IS NOT NULL)
    OR (action<>'resume' AND whatsapp_consent_granted IS NULL AND whatsapp_opted_out IS NULL)
  ),
  CONSTRAINT avni_conversation_control_thread_version_uq UNIQUE (thread_id,resulting_version)
);

CREATE INDEX avni_conversation_control_thread_time_idx
  ON aichm_private.conversation_control_events(thread_id,occurred_at DESC,id DESC);

ALTER TABLE aichm_private.conversation_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_outbox_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_control_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE aichm_private.conversation_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_events FORCE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_outbox_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_delivery_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE aichm_private.conversation_control_events FORCE ROW LEVEL SECURITY;

CREATE POLICY avni_rpc_owner_threads ON aichm_private.conversation_threads
  TO aichm_conversation_owner USING (true) WITH CHECK (true);
CREATE POLICY avni_rpc_owner_messages ON aichm_private.conversation_messages
  TO aichm_conversation_owner USING (true) WITH CHECK (true);
CREATE POLICY avni_rpc_owner_events ON aichm_private.conversation_events
  TO aichm_conversation_owner USING (true) WITH CHECK (true);
CREATE POLICY avni_rpc_owner_outbox ON aichm_private.conversation_outbox
  TO aichm_conversation_owner USING (true) WITH CHECK (true);
CREATE POLICY avni_rpc_owner_attempts ON aichm_private.conversation_outbox_attempts
  TO aichm_conversation_owner USING (true) WITH CHECK (true);
CREATE POLICY avni_rpc_owner_receipts ON aichm_private.conversation_delivery_receipts
  TO aichm_conversation_owner USING (true) WITH CHECK (true);
CREATE POLICY avni_rpc_owner_controls ON aichm_private.conversation_control_events
  TO aichm_conversation_owner USING (true) WITH CHECK (true);

ALTER TABLE aichm_private.conversation_threads OWNER TO aichm_conversation_owner;
ALTER TABLE aichm_private.conversation_messages OWNER TO aichm_conversation_owner;
ALTER TABLE aichm_private.conversation_events OWNER TO aichm_conversation_owner;
ALTER TABLE aichm_private.conversation_outbox OWNER TO aichm_conversation_owner;
ALTER TABLE aichm_private.conversation_outbox_attempts OWNER TO aichm_conversation_owner;
ALTER TABLE aichm_private.conversation_delivery_receipts OWNER TO aichm_conversation_owner;
ALTER TABLE aichm_private.conversation_control_events OWNER TO aichm_conversation_owner;

REVOKE ALL ON TABLE
  aichm_private.conversation_threads,
  aichm_private.conversation_messages,
  aichm_private.conversation_events,
  aichm_private.conversation_outbox,
  aichm_private.conversation_outbox_attempts,
  aichm_private.conversation_delivery_receipts,
  aichm_private.conversation_control_events
FROM PUBLIC, anon, authenticated, service_role, aichm_crm_reader, aichm_conversation_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA aichm_private
FROM PUBLIC, anon, authenticated, service_role, aichm_crm_reader,
  aichm_conversation_runtime, aichm_conversation_owner;

CREATE OR REPLACE FUNCTION aichm_private.delivery_transition_allowed(
  p_current text,
  p_incoming text
) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $function$
  SELECT CASE p_current
    WHEN 'queued' THEN p_incoming IN ('sent','delivered','read','failed')
    WHEN 'sent' THEN p_incoming IN ('delivered','read','failed')
    WHEN 'delivered' THEN p_incoming='read'
    WHEN 'unknown' THEN p_incoming IN ('queued','sent','delivered','read','failed')
    ELSE false
  END
  OR p_current=p_incoming;
$function$;

CREATE OR REPLACE FUNCTION aichm_private.accept_provider_event(
  p_provider text,
  p_provider_event_key text,
  p_provider_thread_key text,
  p_event_idempotency_key text,
  p_event_fingerprint text,
  p_occurred_at timestamptz,
  p_kind text,
  p_provider_message_key text,
  p_message_idempotency_key text,
  p_message_fingerprint text,
  p_direction text,
  p_author text,
  p_message_type text,
  p_body text,
  p_media_ref text,
  p_delivery_state text,
  p_raw_provider_state text
) RETURNS TABLE(outcome text,thread_id uuid,event_id uuid,message_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_thread_id uuid;
  v_event_id uuid;
  v_message_id uuid;
  v_existing_fingerprint text;
  v_existing_thread_id uuid;
  v_existing_message_thread_id uuid;
  v_attempt_id uuid;
  v_outbox_id uuid;
  v_candidate_thread_id uuid;
  v_candidate_outbox_id uuid;
  v_attempt_number smallint;
  v_outbox_attempt_count smallint;
  v_is_current_attempt boolean;
  v_receipt_id uuid;
  v_current_state text;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_-]{0,39}$'
    OR p_provider_event_key IS NULL
    OR p_provider_event_key !~ '^hmac-sha256:v1:[0-9a-f]{64}$'
    OR p_provider_thread_key IS NULL
    OR p_provider_thread_key !~ '^hmac-sha256:v1:[0-9a-f]{64}$'
    OR p_event_idempotency_key IS NULL
    OR p_event_idempotency_key !~ '^event:v1:[0-9a-f]{64}$'
    OR p_event_idempotency_key<>'event:v1:'||split_part(p_provider_event_key,':',3)
    OR p_event_fingerprint IS NULL
    OR p_event_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_occurred_at IS NULL
    OR p_kind IS NULL
  THEN
    RAISE EXCEPTION 'invalid_conversation_event' USING ERRCODE='22023';
  END IF;

  INSERT INTO aichm_private.conversation_threads(provider,provider_thread_key)
  VALUES (p_provider,p_provider_thread_key)
  ON CONFLICT (provider,provider_thread_key) DO UPDATE
    SET updated_at=aichm_private.conversation_threads.updated_at
  RETURNING id INTO v_thread_id;

  IF p_kind='message' THEN
    IF p_provider_message_key IS NULL OR p_provider_message_key !~ '^hmac-sha256:v1:[0-9a-f]{64}$'
      OR p_message_idempotency_key IS NULL
      OR p_message_idempotency_key !~ '^message:v1:[0-9a-f]{64}$'
      OR p_message_idempotency_key<>'message:v1:'||split_part(p_provider_message_key,':',3)
      OR p_message_fingerprint IS NULL
      OR p_message_fingerprint !~ '^[0-9a-f]{64}$'
      OR p_delivery_state IS NOT NULL OR p_raw_provider_state IS NOT NULL
      OR NOT (
        (p_direction='inbound' AND p_author IN ('prospect','unknown'))
        OR (p_direction='outbound' AND p_author IN ('assistant','human_staff','system','unknown'))
      )
      OR p_direction IS NULL OR p_author IS NULL OR p_message_type IS NULL
      OR p_message_type NOT IN ('text','image','audio','video','document','interactive','location','unknown')
      OR (p_message_type='text' AND nullif(btrim(p_body),'') IS NULL)
      OR (p_body IS NOT NULL AND length(p_body)>12000)
      OR (p_media_ref IS NOT NULL AND p_media_ref !~ '^media:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    THEN
      RAISE EXCEPTION 'invalid_conversation_message' USING ERRCODE='22023';
    END IF;
  ELSIF p_kind='delivery' THEN
    IF p_provider_message_key IS NULL OR p_provider_message_key !~ '^hmac-sha256:v1:[0-9a-f]{64}$'
      OR p_delivery_state IS NULL
      OR p_delivery_state NOT IN ('queued','sent','delivered','read','failed','unknown')
      OR p_raw_provider_state IS NULL OR p_raw_provider_state !~ '^[A-Za-z0-9_.:-]{1,100}$'
      OR p_message_idempotency_key IS NOT NULL OR p_message_fingerprint IS NOT NULL
      OR p_direction IS NOT NULL OR p_author IS NOT NULL OR p_message_type IS NOT NULL
      OR p_body IS NOT NULL OR p_media_ref IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid_conversation_delivery_event' USING ERRCODE='22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_conversation_event_kind' USING ERRCODE='22023';
  END IF;

  INSERT INTO aichm_private.conversation_events(
    thread_id,provider,provider_event_key,idempotency_key,event_fingerprint,event_kind,occurred_at
  ) VALUES (
    v_thread_id,p_provider,p_provider_event_key,p_event_idempotency_key,p_event_fingerprint,p_kind,p_occurred_at
  )
  ON CONFLICT (provider,provider_event_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT e.id,e.event_fingerprint,e.message_id,e.thread_id
      INTO v_event_id,v_existing_fingerprint,v_message_id,v_existing_thread_id
    FROM aichm_private.conversation_events e
    WHERE e.provider=p_provider AND e.provider_event_key=p_provider_event_key;
    IF v_existing_fingerprint<>p_event_fingerprint OR v_existing_thread_id<>v_thread_id THEN
      RAISE EXCEPTION 'conversation_event_idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT 'duplicate_event'::text,v_thread_id,v_event_id,v_message_id;
    RETURN;
  END IF;

  IF p_kind='message' THEN
    INSERT INTO aichm_private.conversation_messages(
      thread_id,provider,provider_message_key,idempotency_key,message_fingerprint,
      direction,author,message_type,body,media_ref,delivery_state,occurred_at
    ) VALUES (
      v_thread_id,p_provider,p_provider_message_key,p_message_idempotency_key,p_message_fingerprint,
      p_direction,p_author,p_message_type,p_body,p_media_ref,
      CASE WHEN p_direction='outbound' THEN 'unknown' ELSE NULL END,p_occurred_at
    )
    ON CONFLICT (provider,provider_message_key) WHERE provider_message_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_message_id;

    IF v_message_id IS NULL THEN
      SELECT m.id,m.message_fingerprint,m.thread_id
        INTO v_message_id,v_existing_fingerprint,v_existing_message_thread_id
      FROM aichm_private.conversation_messages m
      WHERE m.provider=p_provider AND m.provider_message_key=p_provider_message_key;
      IF v_existing_fingerprint<>p_message_fingerprint
        OR v_existing_message_thread_id<>v_thread_id THEN
        RAISE EXCEPTION 'conversation_message_idempotency_conflict' USING ERRCODE='P0001';
      END IF;
    END IF;
    UPDATE aichm_private.conversation_events SET message_id=v_message_id WHERE id=v_event_id;
    RETURN QUERY SELECT 'accepted'::text,v_thread_id,v_event_id,v_message_id;
    RETURN;
  END IF;

  SELECT a.id,a.outbox_id,o.thread_id
    INTO v_attempt_id,v_outbox_id,v_candidate_thread_id
  FROM aichm_private.conversation_outbox_attempts a
  JOIN aichm_private.conversation_outbox o ON o.id=a.outbox_id
  WHERE a.provider=p_provider AND a.provider_message_key=p_provider_message_key
  ORDER BY a.attempt_number DESC
  LIMIT 1;

  IF v_attempt_id IS NULL THEN
    RETURN QUERY SELECT 'unmatched_receipt'::text,v_thread_id,v_event_id,NULL::uuid;
    RETURN;
  END IF;
  IF v_candidate_thread_id<>v_thread_id THEN
    RETURN QUERY SELECT 'unmatched_receipt'::text,v_thread_id,v_event_id,NULL::uuid;
    RETURN;
  END IF;
  PERFORM 1 FROM aichm_private.conversation_threads WHERE id=v_thread_id FOR UPDATE;
  PERFORM 1 FROM aichm_private.conversation_outbox WHERE id=v_outbox_id FOR UPDATE;
  SELECT a.delivery_state,a.attempt_number,o.attempt_count
    INTO v_current_state,v_attempt_number,v_outbox_attempt_count
  FROM aichm_private.conversation_outbox_attempts a
  JOIN aichm_private.conversation_outbox o ON o.id=a.outbox_id
  WHERE a.id=v_attempt_id AND o.id=v_outbox_id
  FOR UPDATE OF a;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unmatched_receipt'::text,v_thread_id,v_event_id,NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO aichm_private.conversation_delivery_receipts(
    event_id,attempt_id,provider,provider_receipt_key,raw_provider_state,normalized_state,occurred_at
  ) VALUES (
    v_event_id,v_attempt_id,p_provider,p_provider_event_key,p_raw_provider_state,p_delivery_state,p_occurred_at
  )
  ON CONFLICT (provider,provider_receipt_key) DO NOTHING
  RETURNING id INTO v_receipt_id;

  v_is_current_attempt:=v_attempt_number=v_outbox_attempt_count;
  IF v_receipt_id IS NOT NULL AND v_is_current_attempt
    AND aichm_private.delivery_transition_allowed(v_current_state,p_delivery_state)
  THEN
    UPDATE aichm_private.conversation_outbox_attempts
    SET delivery_state=p_delivery_state,
        state=CASE p_delivery_state
          WHEN 'sent' THEN 'sent' WHEN 'delivered' THEN 'delivered'
          WHEN 'read' THEN 'read' WHEN 'failed' THEN 'failed'
          WHEN 'unknown' THEN 'unknown' ELSE state END,
        finished_at=CASE WHEN p_delivery_state IN ('delivered','read','failed','unknown')
          THEN greatest(coalesce(finished_at,p_occurred_at),p_occurred_at) ELSE finished_at END
    WHERE id=v_attempt_id;
    UPDATE aichm_private.conversation_outbox o
    SET state=CASE p_delivery_state
          WHEN 'sent' THEN 'accepted'
          WHEN 'delivered' THEN 'delivered'
          WHEN 'read' THEN 'delivered'
          WHEN 'failed' THEN 'failed'
          WHEN 'unknown' THEN 'unknown'
          ELSE o.state
        END,
        lease_token=CASE WHEN p_delivery_state='queued' THEN o.lease_token ELSE NULL END,
        lease_expires_at=CASE WHEN p_delivery_state='queued' THEN o.lease_expires_at ELSE NULL END,
        updated_at=now()
    FROM aichm_private.conversation_outbox_attempts a
    WHERE a.id=v_attempt_id AND o.id=a.outbox_id;
    UPDATE aichm_private.conversation_messages m
    SET delivery_state=p_delivery_state
    FROM aichm_private.conversation_outbox_attempts a
    WHERE a.id=v_attempt_id AND m.id=(
      SELECT o.message_id FROM aichm_private.conversation_outbox o WHERE o.id=a.outbox_id
    );
  END IF;

  SELECT m.id INTO v_message_id
  FROM aichm_private.conversation_messages m
  WHERE m.provider=p_provider AND m.provider_message_key=p_provider_message_key;
  RETURN QUERY SELECT CASE WHEN v_receipt_id IS NULL THEN 'duplicate_receipt'::text
                           ELSE 'receipt_recorded'::text END,
    v_thread_id,v_event_id,v_message_id;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.link_conversation_thread(
  p_thread_id uuid,
  p_supabase_lead_id uuid,
  p_expected_control_version bigint,
  p_actor_ref text,
  p_request_id uuid,
  p_reason text
) RETURNS TABLE(outcome text,control_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_control aichm_private.conversation_control_events%ROWTYPE;
  v_next_version bigint;
BEGIN
  IF p_thread_id IS NULL OR p_supabase_lead_id IS NULL OR p_expected_control_version IS NULL
    OR p_actor_ref IS NULL OR p_actor_ref !~ '^replit_lms_user:[1-9][0-9]{0,9}$'
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500
    OR p_request_id IS NULL
  THEN RAISE EXCEPTION 'invalid_conversation_link_request' USING ERRCODE='22023'; END IF;
  -- The trusted Replit caller must verify the exact CRM/Supabase crosswalk and
  -- staff assignment before invoking this RPC. The FK remains the DB existence check.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  SELECT * INTO v_control FROM aichm_private.conversation_control_events
  WHERE request_id=p_request_id;
  IF FOUND THEN
    SELECT * INTO v_thread FROM aichm_private.conversation_threads WHERE id=p_thread_id;
    IF v_control.thread_id=p_thread_id AND v_control.action='lead_linked'
      AND v_control.actor_ref=p_actor_ref AND v_control.reason=p_reason
      AND v_control.prior_version=p_expected_control_version
      AND v_thread.mapping_status='mapped' AND v_thread.supabase_lead_id=p_supabase_lead_id
    THEN
      RETURN QUERY SELECT 'duplicate'::text,v_control.resulting_version; RETURN;
    END IF;
    RETURN QUERY SELECT 'request_id_conflict'::text,NULL::bigint; RETURN;
  END IF;

  SELECT * INTO v_thread FROM aichm_private.conversation_threads
  WHERE id=p_thread_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'thread_not_found'::text,NULL::bigint; RETURN; END IF;
  IF v_thread.control_version<>p_expected_control_version THEN
    RETURN QUERY SELECT 'version_conflict'::text,v_thread.control_version; RETURN;
  END IF;
  IF v_thread.mapping_status<>'unmapped' THEN
    RETURN QUERY SELECT 'mapping_not_unmapped'::text,v_thread.control_version; RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM aichm_private.conversation_threads other
    WHERE other.provider=v_thread.provider AND other.supabase_lead_id=p_supabase_lead_id
      AND other.mapping_status='mapped' AND other.id<>v_thread.id
  ) THEN
    RETURN QUERY SELECT 'canonical_thread_conflict'::text,v_thread.control_version; RETURN;
  END IF;

  v_next_version:=v_thread.control_version+1;
  UPDATE aichm_private.conversation_threads
  SET supabase_lead_id=p_supabase_lead_id,mapping_status='mapped',
      control_version=v_next_version,updated_at=now()
  WHERE id=p_thread_id;
  INSERT INTO aichm_private.conversation_control_events(
    thread_id,request_id,action,actor_ref,reason,prior_version,resulting_version,
    whatsapp_consent_granted,whatsapp_opted_out
  ) VALUES (p_thread_id,p_request_id,'lead_linked',p_actor_ref,p_reason,
    v_thread.control_version,v_next_version,NULL,NULL);
  RETURN QUERY SELECT 'linked'::text,v_next_version;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.enqueue_conversation_message(
  p_thread_id uuid,
  p_expected_control_version bigint,
  p_author text,
  p_actor_ref text,
  p_idempotency_key text,
  p_message_fingerprint text,
  p_message_type text,
  p_body text,
  p_media_ref text,
  p_whatsapp_send_allowed boolean DEFAULT false
) RETURNS TABLE(outcome text,outbox_id uuid,message_id uuid,control_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_message_id uuid;
  v_outbox_id uuid;
  v_existing_fingerprint text;
  v_mode text;
BEGIN
  IF p_thread_id IS NULL OR p_expected_control_version IS NULL
    OR p_author IS NULL OR p_author NOT IN ('assistant','human_staff')
    OR p_idempotency_key IS NULL
    OR p_idempotency_key !~ '^message:v1:[0-9a-f]{64}$'
    OR p_message_fingerprint IS NULL
    OR p_message_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_message_type IS NULL
    OR p_message_type NOT IN ('text','image','audio','video','document','interactive','location','unknown')
    OR (p_body IS NOT NULL AND length(p_body)>12000)
    OR (p_message_type='text' AND nullif(btrim(p_body),'') IS NULL)
    OR (p_media_ref IS NOT NULL AND p_media_ref !~ '^media:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (p_author='assistant' AND p_actor_ref IS NOT NULL)
    OR (p_author='human_staff' AND p_actor_ref IS NULL)
    OR (p_author='human_staff' AND p_actor_ref !~ '^replit_lms_user:[1-9][0-9]{0,9}$')
    OR p_whatsapp_send_allowed IS NULL
  THEN RAISE EXCEPTION 'invalid_conversation_outbound_request' USING ERRCODE='22023'; END IF;
  IF NOT p_whatsapp_send_allowed THEN
    RETURN QUERY SELECT 'whatsapp_send_not_authorized'::text,NULL::uuid,NULL::uuid,NULL::bigint; RETURN;
  END IF;

  SELECT * INTO v_thread FROM aichm_private.conversation_threads
  WHERE id=p_thread_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'thread_not_found'::text,NULL::uuid,NULL::uuid,NULL::bigint; RETURN; END IF;
  IF v_thread.mapping_status<>'mapped' OR v_thread.supabase_lead_id IS NULL THEN
    RETURN QUERY SELECT 'thread_mapping_unavailable'::text,NULL::uuid,NULL::uuid,v_thread.control_version; RETURN;
  END IF;
  IF v_thread.lifecycle<>'open' THEN
    RETURN QUERY SELECT 'conversation_closed'::text,NULL::uuid,NULL::uuid,v_thread.control_version; RETURN;
  END IF;
  IF v_thread.control_version<>p_expected_control_version THEN
    RETURN QUERY SELECT 'version_conflict'::text,NULL::uuid,NULL::uuid,v_thread.control_version; RETURN;
  END IF;
  v_mode:=CASE WHEN p_author='assistant' THEN 'ai' ELSE 'human' END;
  IF v_thread.mode<>v_mode THEN
    RETURN QUERY SELECT 'ownership_conflict'::text,NULL::uuid,NULL::uuid,v_thread.control_version; RETURN;
  END IF;

  INSERT INTO aichm_private.conversation_messages(
    thread_id,provider,idempotency_key,message_fingerprint,direction,author,
    message_type,body,media_ref,delivery_state,occurred_at
  ) VALUES (
    p_thread_id,v_thread.provider,p_idempotency_key,p_message_fingerprint,'outbound',p_author,
    p_message_type,p_body,p_media_ref,'queued',now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    SELECT m.id,m.message_fingerprint INTO v_message_id,v_existing_fingerprint
    FROM aichm_private.conversation_messages m WHERE m.idempotency_key=p_idempotency_key;
    IF v_existing_fingerprint<>p_message_fingerprint THEN
      RAISE EXCEPTION 'conversation_outbox_idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    SELECT o.id INTO v_outbox_id FROM aichm_private.conversation_outbox o WHERE o.message_id=v_message_id;
    IF v_outbox_id IS NOT NULL THEN
      RETURN QUERY SELECT 'duplicate'::text,v_outbox_id,v_message_id,v_thread.control_version; RETURN;
    END IF;
    RAISE EXCEPTION 'conversation_outbox_invariant_failed' USING ERRCODE='P0001';
  END IF;

  INSERT INTO aichm_private.conversation_outbox(
    thread_id,message_id,author,actor_ref,idempotency_key,expected_control_version
  ) VALUES (
    p_thread_id,v_message_id,p_author,p_actor_ref,p_idempotency_key,p_expected_control_version
  ) RETURNING id INTO v_outbox_id;
  RETURN QUERY SELECT 'queued'::text,v_outbox_id,v_message_id,v_thread.control_version;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.claim_next_conversation_outbound(
  p_whatsapp_send_allowed boolean,
  p_lease_seconds integer DEFAULT 60
) RETURNS TABLE(
  outbox_id uuid,attempt_id uuid,thread_id uuid,provider text,message_id uuid,
  expected_control_version bigint,lease_token uuid,lease_expires_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_outbox aichm_private.conversation_outbox%ROWTYPE;
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_attempt_id uuid;
  v_lease uuid;
  v_expires timestamptz;
  v_candidate_outbox_id uuid;
  v_candidate_thread_id uuid;
  v_expired record;
  v_expired_outbox aichm_private.conversation_outbox%ROWTYPE;
  v_expired_attempt_id uuid;
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 300 OR p_whatsapp_send_allowed IS NULL THEN
    RAISE EXCEPTION 'invalid_conversation_lease' USING ERRCODE='22023';
  END IF;

  FOR v_expired IN
    SELECT o.id,o.thread_id
    FROM aichm_private.conversation_outbox o
    WHERE o.state IN ('claimed','sending') AND o.lease_expires_at<=now()
    ORDER BY o.lease_expires_at,o.id
    LIMIT 100
  LOOP
    SELECT * INTO v_thread FROM aichm_private.conversation_threads
    WHERE id=v_expired.thread_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO v_expired_outbox FROM aichm_private.conversation_outbox
    WHERE id=v_expired.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR v_expired_outbox.state NOT IN ('claimed','sending')
      OR v_expired_outbox.lease_expires_at>now()
    THEN CONTINUE; END IF;
    SELECT a.id INTO v_expired_attempt_id
    FROM aichm_private.conversation_outbox_attempts a
    WHERE a.outbox_id=v_expired_outbox.id
      AND a.attempt_number=v_expired_outbox.attempt_count
    FOR UPDATE;
    IF v_expired_attempt_id IS NULL THEN
      RAISE EXCEPTION 'conversation_outbox_attempt_missing' USING ERRCODE='P0001';
    END IF;
    IF v_expired_outbox.state='claimed' THEN
      UPDATE aichm_private.conversation_outbox_attempts
      SET state='cancelled',finished_at=now()
      WHERE id=v_expired_attempt_id AND state='claimed';
      UPDATE aichm_private.conversation_outbox
      SET state=CASE WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'pending' END,
          lease_token=NULL,lease_expires_at=NULL,available_at=now(),updated_at=now()
      WHERE id=v_expired_outbox.id;
    ELSE
      UPDATE aichm_private.conversation_outbox_attempts
      SET state='unknown',delivery_state='unknown',finished_at=now()
      WHERE id=v_expired_attempt_id AND state='sending';
      UPDATE aichm_private.conversation_outbox
      SET state='unknown',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE id=v_expired_outbox.id;
      UPDATE aichm_private.conversation_messages m
      SET delivery_state='unknown'
      FROM aichm_private.conversation_outbox o
      WHERE o.id=v_expired_outbox.id AND m.id=o.message_id;
    END IF;
  END LOOP;
  UPDATE aichm_private.conversation_outbox
  SET state='failed',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
  WHERE state='pending' AND attempt_count>=max_attempts;

  SELECT o.id,o.thread_id INTO v_candidate_outbox_id,v_candidate_thread_id
  FROM aichm_private.conversation_outbox o
  WHERE o.state='pending' AND o.available_at<=now() AND o.attempt_count<o.max_attempts
  ORDER BY o.available_at,o.id
  LIMIT 1;
  IF v_candidate_outbox_id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_thread FROM aichm_private.conversation_threads
  WHERE id=v_candidate_thread_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_outbox FROM aichm_private.conversation_outbox
  WHERE id=v_candidate_outbox_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR v_outbox.state<>'pending' OR v_outbox.available_at>now()
    OR v_outbox.attempt_count>=v_outbox.max_attempts
    OR v_thread.mapping_status<>'mapped' OR v_thread.lifecycle<>'open'
    OR v_thread.control_version<>v_outbox.expected_control_version
    OR NOT p_whatsapp_send_allowed
    OR NOT ((v_outbox.author='assistant' AND v_thread.mode='ai')
      OR (v_outbox.author='human_staff' AND v_thread.mode='human'))
  THEN RETURN; END IF;

  v_lease:=gen_random_uuid();
  v_expires:=now()+make_interval(secs=>p_lease_seconds);
  UPDATE aichm_private.conversation_outbox o
  SET state='claimed',attempt_count=attempt_count+1,lease_token=v_lease,
      lease_expires_at=v_expires,updated_at=now()
  WHERE o.id=v_outbox.id
  RETURNING o.* INTO v_outbox;
  INSERT INTO aichm_private.conversation_outbox_attempts(
    outbox_id,attempt_number,provider,lease_token,lease_expires_at
  ) VALUES (
    v_outbox.id,v_outbox.attempt_count,v_thread.provider,v_lease,v_expires
  ) RETURNING id INTO v_attempt_id;

  RETURN QUERY SELECT v_outbox.id,v_attempt_id,v_outbox.thread_id,v_thread.provider,
    v_outbox.message_id,v_outbox.expected_control_version,v_lease,v_expires;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.authorize_conversation_outbound_attempt(
  p_outbox_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_whatsapp_send_allowed boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_outbox aichm_private.conversation_outbox%ROWTYPE;
  v_attempt aichm_private.conversation_outbox_attempts%ROWTYPE;
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_thread_id uuid;
  v_authorized boolean;
BEGIN
  SELECT o.thread_id INTO v_thread_id FROM aichm_private.conversation_outbox o
  WHERE o.id=p_outbox_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_thread FROM aichm_private.conversation_threads
  WHERE id=v_thread_id FOR UPDATE;
  SELECT * INTO v_outbox FROM aichm_private.conversation_outbox
  WHERE id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_attempt FROM aichm_private.conversation_outbox_attempts
  WHERE id=p_attempt_id AND outbox_id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_authorized:=v_outbox.state='claimed' AND v_attempt.state='claimed'
    AND v_outbox.lease_token=p_lease_token AND v_attempt.lease_token=p_lease_token
    AND v_outbox.lease_expires_at>now() AND v_attempt.lease_expires_at>now()
    AND v_outbox.expected_control_version=v_thread.control_version
    AND v_thread.lifecycle='open' AND v_thread.mapping_status='mapped'
    AND p_whatsapp_send_allowed
    AND ((v_outbox.author='assistant' AND v_thread.mode='ai')
      OR (v_outbox.author='human_staff' AND v_thread.mode='human'));
  IF NOT v_authorized THEN
    IF v_outbox.state='claimed' AND v_outbox.lease_token=p_lease_token THEN
      UPDATE aichm_private.conversation_outbox
      SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE id=p_outbox_id;
      UPDATE aichm_private.conversation_outbox_attempts
      SET state='cancelled',finished_at=now()
      WHERE id=p_attempt_id AND state='claimed';
    END IF;
    RETURN false;
  END IF;

  UPDATE aichm_private.conversation_outbox
  SET state='sending',updated_at=now()
  WHERE id=p_outbox_id;
  UPDATE aichm_private.conversation_outbox_attempts
  SET state='sending',started_at=now()
  WHERE id=p_attempt_id;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.record_conversation_send_result(
  p_outbox_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_result text,
  p_provider_message_key text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_attempt aichm_private.conversation_outbox_attempts%ROWTYPE;
  v_outbox aichm_private.conversation_outbox%ROWTYPE;
  v_thread_id uuid;
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_state text;
BEGIN
  IF p_outbox_id IS NULL OR p_attempt_id IS NULL OR p_lease_token IS NULL
    OR p_result IS NULL OR p_result NOT IN ('sent','failed','unknown')
    OR (p_provider_message_key IS NOT NULL AND p_provider_message_key !~ '^hmac-sha256:v1:[0-9a-f]{64}$')
    OR (p_result='sent' AND p_provider_message_key IS NULL)
  THEN RAISE EXCEPTION 'invalid_conversation_send_result' USING ERRCODE='22023'; END IF;
  SELECT o.thread_id INTO v_thread_id
  FROM aichm_private.conversation_outbox o
  JOIN aichm_private.conversation_outbox_attempts a ON a.outbox_id=o.id
  WHERE o.id=p_outbox_id AND a.id=p_attempt_id;
  IF NOT FOUND THEN RETURN 'lease_lost'; END IF;
  SELECT * INTO v_thread FROM aichm_private.conversation_threads
  WHERE id=v_thread_id FOR UPDATE;
  SELECT * INTO v_outbox FROM aichm_private.conversation_outbox
  WHERE id=p_outbox_id FOR UPDATE;
  SELECT * INTO v_attempt FROM aichm_private.conversation_outbox_attempts
  WHERE id=p_attempt_id AND outbox_id=p_outbox_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.state<>'sending' OR v_attempt.lease_token<>p_lease_token THEN
    RETURN 'lease_lost';
  END IF;
  v_state:=CASE p_result WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' ELSE 'unknown' END;
  UPDATE aichm_private.conversation_outbox_attempts
  SET provider_message_key=p_provider_message_key,state=v_state,delivery_state=v_state,
      finished_at=now()
  WHERE id=p_attempt_id;
  UPDATE aichm_private.conversation_messages m
  SET provider_message_key=p_provider_message_key,delivery_state=v_state
  FROM aichm_private.conversation_outbox o
  WHERE o.id=p_outbox_id AND m.id=o.message_id;
  UPDATE aichm_private.conversation_outbox
  SET state=CASE p_result WHEN 'sent' THEN 'accepted' WHEN 'failed' THEN 'failed' ELSE 'unknown' END,
      lease_token=NULL,lease_expires_at=NULL,updated_at=now()
  WHERE id=p_outbox_id;
  RETURN p_result;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.transition_conversation_control(
  p_thread_id uuid,
  p_expected_control_version bigint,
  p_action text,
  p_actor_ref text,
  p_request_id uuid,
  p_reason text,
  p_whatsapp_consent_granted boolean DEFAULT false,
  p_whatsapp_opted_out boolean DEFAULT true
) RETURNS TABLE(outcome text,control_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_control aichm_private.conversation_control_events%ROWTYPE;
  v_new_mode text;
  v_version bigint;
BEGIN
  IF p_thread_id IS NULL OR p_expected_control_version IS NULL
    OR p_action IS NULL OR p_action NOT IN ('takeover','resume')
    OR p_actor_ref IS NULL OR p_actor_ref !~ '^replit_lms_user:[1-9][0-9]{0,9}$'
    OR p_request_id IS NULL
    OR (p_reason IS NOT NULL AND length(btrim(p_reason)) NOT BETWEEN 3 AND 500)
    OR (p_action='resume' AND (p_whatsapp_consent_granted IS NULL OR p_whatsapp_opted_out IS NULL))
  THEN RAISE EXCEPTION 'invalid_conversation_control_request' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  SELECT * INTO v_control FROM aichm_private.conversation_control_events
  WHERE request_id=p_request_id;
  IF FOUND THEN
    IF v_control.thread_id=p_thread_id AND v_control.action=p_action
      AND v_control.actor_ref=p_actor_ref AND v_control.reason IS NOT DISTINCT FROM p_reason
      AND v_control.prior_version=p_expected_control_version
      AND v_control.whatsapp_consent_granted IS NOT DISTINCT FROM
        CASE WHEN p_action='resume' THEN p_whatsapp_consent_granted ELSE NULL END
      AND v_control.whatsapp_opted_out IS NOT DISTINCT FROM
        CASE WHEN p_action='resume' THEN p_whatsapp_opted_out ELSE NULL END
    THEN
      RETURN QUERY SELECT 'duplicate'::text,v_control.resulting_version; RETURN;
    END IF;
    RETURN QUERY SELECT 'request_id_conflict'::text,NULL::bigint; RETURN;
  END IF;
  SELECT * INTO v_thread FROM aichm_private.conversation_threads
  WHERE id=p_thread_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'thread_not_found'::text,NULL::bigint; RETURN; END IF;
  IF v_thread.control_version<>p_expected_control_version THEN
    RETURN QUERY SELECT 'version_conflict'::text,v_thread.control_version; RETURN;
  END IF;
  IF v_thread.lifecycle<>'open' THEN
    RETURN QUERY SELECT 'conversation_closed'::text,v_thread.control_version; RETURN;
  END IF;
  IF p_action='takeover' THEN
    IF v_thread.mode='human' THEN RETURN QUERY SELECT 'already_human_owned'::text,v_thread.control_version; RETURN; END IF;
    v_new_mode:='human';
  ELSE
    IF v_thread.mode<>'human' THEN RETURN QUERY SELECT 'not_human_owned'::text,v_thread.control_version; RETURN; END IF;
    IF p_whatsapp_opted_out THEN
      RETURN QUERY SELECT 'whatsapp_opted_out'::text,v_thread.control_version; RETURN;
    END IF;
    IF NOT p_whatsapp_consent_granted THEN
      RETURN QUERY SELECT 'whatsapp_consent_not_granted'::text,v_thread.control_version; RETURN;
    END IF;
    v_new_mode:='ai';
  END IF;

  v_version:=v_thread.control_version+1;
  UPDATE aichm_private.conversation_threads
  SET mode=v_new_mode,control_version=v_version,updated_at=now()
  WHERE id=p_thread_id;
  INSERT INTO aichm_private.conversation_control_events(
    thread_id,request_id,action,actor_ref,reason,prior_version,resulting_version,
    whatsapp_consent_granted,whatsapp_opted_out
  ) VALUES (p_thread_id,p_request_id,p_action,p_actor_ref,p_reason,
    v_thread.control_version,v_version,
    CASE WHEN p_action='resume' THEN p_whatsapp_consent_granted ELSE NULL END,
    CASE WHEN p_action='resume' THEN p_whatsapp_opted_out ELSE NULL END);

  IF p_action='takeover' THEN
    UPDATE aichm_private.conversation_outbox_attempts a
    SET state='cancelled',finished_at=now()
    FROM aichm_private.conversation_outbox o
    WHERE a.outbox_id=o.id AND o.thread_id=p_thread_id AND o.author='assistant'
      AND o.state='claimed' AND a.state='claimed';
    UPDATE aichm_private.conversation_outbox
    SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE thread_id=p_thread_id AND author='assistant' AND state IN ('pending','claimed');
  END IF;
  RETURN QUERY SELECT 'changed'::text,v_version;
END
$function$;

ALTER FUNCTION aichm_private.delivery_transition_allowed(text,text) OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.accept_provider_event(text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,text,text,text,text)
  OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.link_conversation_thread(uuid,uuid,bigint,text,uuid,text)
  OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.enqueue_conversation_message(uuid,bigint,text,text,text,text,text,text,text,boolean)
  OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.claim_next_conversation_outbound(boolean,integer)
  OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.authorize_conversation_outbound_attempt(uuid,uuid,uuid,boolean)
  OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.record_conversation_send_result(uuid,uuid,uuid,text,text)
  OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.transition_conversation_control(uuid,bigint,text,text,uuid,text,boolean,boolean)
  OWNER TO aichm_conversation_owner;
REVOKE CREATE ON SCHEMA aichm_private FROM aichm_conversation_owner;

REVOKE ALL ON FUNCTION aichm_private.delivery_transition_allowed(text,text)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.accept_provider_event(text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.link_conversation_thread(uuid,uuid,bigint,text,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.enqueue_conversation_message(uuid,bigint,text,text,text,text,text,text,text,boolean)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.claim_next_conversation_outbound(boolean,integer)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.authorize_conversation_outbound_attempt(uuid,uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.record_conversation_send_result(uuid,uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.transition_conversation_control(uuid,bigint,text,text,uuid,text,boolean,boolean)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;

GRANT EXECUTE ON FUNCTION aichm_private.accept_provider_event(text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,text,text,text,text)
  TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.link_conversation_thread(uuid,uuid,bigint,text,uuid,text)
  TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.enqueue_conversation_message(uuid,bigint,text,text,text,text,text,text,text,boolean)
  TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.claim_next_conversation_outbound(boolean,integer)
  TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.authorize_conversation_outbound_attempt(uuid,uuid,uuid,boolean)
  TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.record_conversation_send_result(uuid,uuid,uuid,text,text)
  TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.transition_conversation_control(uuid,bigint,text,text,uuid,text,boolean,boolean)
  TO aichm_conversation_runtime;

-- Existing aichm_crm_conversations_for_replit_lead remains unchanged. This
-- migration does not backfill or dual-write legacy rows; CRM history cutover
-- needs a separate reviewed reader change with exact deduplication evidence.

COMMIT;
