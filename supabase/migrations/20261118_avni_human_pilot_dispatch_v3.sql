-- Draft only. Supports one authenticated, CRM-authorized human pilot message.
-- Do not apply to a live Supabase project without a separate schema review.
-- This migration does not configure an Evolution client or authorize a send by
-- itself. Replit must recheck actor, assignment, consent and consent_epoch
-- under its transaction before calling begin_human_pilot_send.

BEGIN;

DO $pilot_prerequisites$
BEGIN
  IF to_regclass('aichm_private.conversation_threads') IS NULL
     OR to_regclass('aichm_private.conversation_messages') IS NULL
     OR to_regclass('aichm_private.conversation_outbox') IS NULL
     OR to_regclass('aichm_private.conversation_outbox_attempts') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname='aichm_conversation_owner' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname='aichm_conversation_runtime' AND NOT rolcanlogin
          AND NOT rolsuper AND NOT rolbypassrls)
  THEN RAISE EXCEPTION 'AVNI_HUMAN_PILOT_PREREQUISITE_MISSING'; END IF;
END
$pilot_prerequisites$;

CREATE OR REPLACE FUNCTION aichm_private.read_human_pilot_thread(
  p_replit_lead_id uuid,
  p_expected_control_version bigint
) RETURNS TABLE(
  outcome text,
  thread_id uuid,
  provider text,
  mode text,
  lifecycle text,
  control_version bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_preflight record;
  v_provider text;
BEGIN
  SELECT * INTO v_preflight
  FROM aichm_private.preflight_conversation_for_replit_lead(
    p_replit_lead_id,p_expected_control_version
  );
  IF v_preflight.outcome<>'preflight_ready' OR v_preflight.thread_id IS NULL THEN
    RETURN QUERY SELECT v_preflight.outcome::text,NULL::uuid,NULL::text,
      v_preflight.mode::text,v_preflight.lifecycle::text,v_preflight.control_version::bigint;
    RETURN;
  END IF;
  SELECT t.provider INTO v_provider
  FROM aichm_private.conversation_threads t
  WHERE t.id=v_preflight.thread_id AND t.mapping_status='mapped';
  IF v_provider IS NULL THEN
    RETURN QUERY SELECT 'conversation_missing'::text,NULL::uuid,NULL::text,
      NULL::text,NULL::text,NULL::bigint;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'preflight_ready'::text,v_preflight.thread_id,v_provider::text,
    v_preflight.mode::text,v_preflight.lifecycle::text,v_preflight.control_version::bigint;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.find_human_pilot_outbound(
  p_idempotency_key text
) RETURNS TABLE(
  outbox_id uuid,
  message_id uuid,
  thread_id uuid,
  state text,
  control_version bigint,
  attempt_number smallint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^message:v1:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_human_pilot_lookup' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT o.id,o.message_id,o.thread_id,o.state,o.expected_control_version,
    COALESCE((SELECT max(a.attempt_number) FROM aichm_private.conversation_outbox_attempts a
      WHERE a.outbox_id=o.id),0)::smallint
  FROM aichm_private.conversation_outbox o
  WHERE o.idempotency_key=p_idempotency_key AND o.author='human_staff';
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.claim_human_pilot_outbound(
  p_outbox_id uuid,
  p_lease_seconds integer
) RETURNS TABLE(
  outbox_id uuid,
  message_id uuid,
  thread_id uuid,
  attempt_id uuid,
  lease_token uuid,
  control_version bigint,
  attempt_number smallint,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_thread_id uuid;
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_outbox aichm_private.conversation_outbox%ROWTYPE;
  v_attempt aichm_private.conversation_outbox_attempts%ROWTYPE;
  v_message aichm_private.conversation_messages%ROWTYPE;
  v_now timestamptz;
  v_lease_token uuid;
  v_lease_expires_at timestamptz;
  v_attempt_number smallint;
BEGIN
  IF p_outbox_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 60 THEN
    RAISE EXCEPTION 'invalid_human_pilot_claim' USING ERRCODE='22023';
  END IF;
  SELECT o.thread_id INTO v_thread_id FROM aichm_private.conversation_outbox o
    WHERE o.id=p_outbox_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_thread FROM aichm_private.conversation_threads t
    WHERE t.id=v_thread_id FOR UPDATE;
  SELECT * INTO v_outbox FROM aichm_private.conversation_outbox o
    WHERE o.id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_now:=clock_timestamp();

  -- A claim that expired before begin_send is safe to reclaim. A sending lease
  -- that expired is uncertain and is terminal: it must never be blindly retried.
  IF v_outbox.state='claimed' AND v_outbox.lease_expires_at<=v_now THEN
    SELECT * INTO v_attempt FROM aichm_private.conversation_outbox_attempts a
      WHERE a.outbox_id=v_outbox.id ORDER BY a.attempt_number DESC LIMIT 1 FOR UPDATE;
    v_now:=clock_timestamp();
    IF v_attempt.id IS NOT NULL AND v_attempt.state='claimed'
       AND v_attempt.lease_expires_at<=v_now THEN
      UPDATE aichm_private.conversation_outbox_attempts
        SET state='cancelled',delivery_state='cancelled',finished_at=v_now
        WHERE id=v_attempt.id;
      UPDATE aichm_private.conversation_messages
        SET delivery_state='queued'
        WHERE id=v_outbox.message_id AND delivery_state='queued';
      UPDATE aichm_private.conversation_outbox
        SET state='pending',lease_token=NULL,lease_expires_at=NULL,updated_at=v_now
        WHERE id=v_outbox.id;
      SELECT * INTO v_outbox FROM aichm_private.conversation_outbox o
        WHERE o.id=p_outbox_id FOR UPDATE;
    END IF;
  ELSIF v_outbox.state='sending' AND v_outbox.lease_expires_at<=v_now THEN
    SELECT * INTO v_attempt FROM aichm_private.conversation_outbox_attempts a
      WHERE a.outbox_id=v_outbox.id ORDER BY a.attempt_number DESC LIMIT 1 FOR UPDATE;
    v_now:=clock_timestamp();
    UPDATE aichm_private.conversation_outbox_attempts
      SET state='unknown',delivery_state='unknown',finished_at=v_now
      WHERE id=v_attempt.id AND state='sending';
    UPDATE aichm_private.conversation_messages
      SET delivery_state='unknown'
      WHERE id=v_outbox.message_id AND delivery_state IN ('queued','sent');
    UPDATE aichm_private.conversation_outbox
      SET state='unknown',lease_token=NULL,lease_expires_at=NULL,
          last_error_code='send_lease_expired_unknown',updated_at=v_now
      WHERE id=v_outbox.id;
    RETURN;
  END IF;

  IF v_outbox.author<>'human_staff' OR v_outbox.state<>'pending'
     OR v_outbox.attempt_count>=v_outbox.max_attempts
     OR v_outbox.available_at>v_now OR v_thread.mode<>'human'
     OR v_thread.lifecycle<>'open' OR v_thread.mapping_status<>'mapped'
     OR v_thread.supabase_lead_id IS NULL
     OR v_thread.control_version<>v_outbox.expected_control_version
  THEN RETURN; END IF;

  SELECT * INTO v_message FROM aichm_private.conversation_messages m
    WHERE m.id=v_outbox.message_id AND m.thread_id=v_thread.id FOR UPDATE;
  v_now:=clock_timestamp();
  IF NOT FOUND OR v_message.direction<>'outbound' OR v_message.author<>'human_staff'
     OR v_message.delivery_state<>'queued' THEN RETURN; END IF;

  v_attempt_number:=(v_outbox.attempt_count+1)::smallint;
  v_lease_token:=gen_random_uuid();
  v_lease_expires_at:=v_now+make_interval(secs=>p_lease_seconds);
  UPDATE aichm_private.conversation_outbox
    SET state='claimed',attempt_count=v_attempt_number,lease_token=v_lease_token,
        lease_expires_at=v_lease_expires_at,updated_at=v_now
    WHERE id=v_outbox.id;
  INSERT INTO aichm_private.conversation_outbox_attempts(
    outbox_id,attempt_number,provider,state,delivery_state,lease_token,
    lease_expires_at,started_at
  ) VALUES (
    v_outbox.id,v_attempt_number,v_thread.provider,'claimed','queued',
    v_lease_token,v_lease_expires_at,NULL
  ) RETURNING id INTO v_attempt.id;
  RETURN QUERY SELECT v_outbox.id,v_outbox.message_id,v_thread.id,v_attempt.id,
    v_lease_token,v_thread.control_version,v_attempt_number,v_lease_expires_at;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.begin_human_pilot_send(
  p_outbox_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_thread_id uuid,
  p_expected_control_version bigint,
  p_actor_ref text,
  p_payload_hash text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_thread aichm_private.conversation_threads%ROWTYPE;
  v_outbox aichm_private.conversation_outbox%ROWTYPE;
  v_attempt aichm_private.conversation_outbox_attempts%ROWTYPE;
  v_message aichm_private.conversation_messages%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_outbox_id IS NULL OR p_attempt_id IS NULL OR p_lease_token IS NULL
     OR p_thread_id IS NULL OR p_expected_control_version IS NULL
     OR p_expected_control_version<0
     OR p_actor_ref IS NULL OR p_actor_ref !~ '^replit_lms_user:[1-9][0-9]{0,9}$'
     OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid_human_pilot_begin' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_thread FROM aichm_private.conversation_threads t
    WHERE t.id=p_thread_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'denied'; END IF;
  SELECT * INTO v_outbox FROM aichm_private.conversation_outbox o
    WHERE o.id=p_outbox_id AND o.thread_id=v_thread.id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'denied'; END IF;
  SELECT * INTO v_attempt FROM aichm_private.conversation_outbox_attempts a
    WHERE a.id=p_attempt_id AND a.outbox_id=v_outbox.id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'denied'; END IF;
  SELECT * INTO v_message FROM aichm_private.conversation_messages m
    WHERE m.id=v_outbox.message_id AND m.thread_id=v_thread.id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'denied'; END IF;
  v_now:=clock_timestamp();

  IF v_attempt.state='sending' AND v_attempt.lease_token=p_lease_token THEN
    RETURN 'already_begun';
  END IF;
  IF v_outbox.author<>'human_staff' OR v_outbox.actor_ref<>p_actor_ref
     OR v_message.author<>'human_staff' OR v_message.direction<>'outbound'
     OR v_message.delivery_state<>'queued'
     OR v_thread.mode<>'human' OR v_thread.lifecycle<>'open'
     OR v_thread.mapping_status<>'mapped' OR v_thread.supabase_lead_id IS NULL
     OR v_thread.control_version<>p_expected_control_version
     OR v_outbox.expected_control_version<>p_expected_control_version
     OR v_message.message_fingerprint<>p_payload_hash
     OR v_outbox.state<>'claimed' OR v_attempt.state<>'claimed'
     OR v_outbox.lease_token<>p_lease_token OR v_attempt.lease_token<>p_lease_token
     OR v_outbox.lease_expires_at<=v_now OR v_attempt.lease_expires_at<=v_now
  THEN
    UPDATE aichm_private.conversation_outbox_attempts
      SET state='cancelled',delivery_state='cancelled',finished_at=v_now
      WHERE id=v_attempt.id AND state='claimed';
    UPDATE aichm_private.conversation_messages
      SET delivery_state='cancelled'
      WHERE id=v_message.id AND delivery_state='queued';
    UPDATE aichm_private.conversation_outbox
      SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,
          last_error_code='pilot_begin_fenced',updated_at=v_now
      WHERE id=v_outbox.id AND state='claimed';
    RETURN 'denied';
  END IF;
  UPDATE aichm_private.conversation_outbox_attempts
    SET state='sending',started_at=v_now
    WHERE id=v_attempt.id;
  UPDATE aichm_private.conversation_messages
    SET delivery_state='queued'
    WHERE id=v_message.id;
  UPDATE aichm_private.conversation_outbox
    SET state='sending',lease_expires_at=v_now+interval '30 seconds',updated_at=v_now
    WHERE id=v_outbox.id;
  UPDATE aichm_private.conversation_outbox_attempts
    SET lease_expires_at=v_now+interval '30 seconds'
    WHERE id=v_attempt.id;
  RETURN 'begun';
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.record_human_pilot_send_result(
  p_outbox_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_result text,
  p_provider_message_aliases text[]
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_message_id uuid;
  v_provider text;
  v_existing_provider_key text;
  v_late_match boolean;
  v_result text;
BEGIN
  IF p_result IS NULL OR p_result NOT IN ('sent','failed','unknown')
     OR p_provider_message_aliases IS NULL
     OR cardinality(p_provider_message_aliases)>16
     OR (p_result='sent' AND cardinality(p_provider_message_aliases)=0)
     OR (p_result<>'sent' AND cardinality(p_provider_message_aliases)<>0)
     OR EXISTS (SELECT 1 FROM unnest(p_provider_message_aliases) a
        WHERE a IS NULL OR a !~ '^hmac-sha256:v2:[a-z0-9][a-z0-9_-]{0,31}:[0-9a-f]{64}$')
     OR cardinality(ARRAY(
       SELECT DISTINCT a FROM unnest(p_provider_message_aliases) a
     ))<>cardinality(p_provider_message_aliases)
  THEN RAISE EXCEPTION 'invalid_human_pilot_result' USING ERRCODE='22023'; END IF;
  SELECT o.message_id,t.provider INTO v_message_id,v_provider
    FROM aichm_private.conversation_outbox o
    JOIN aichm_private.conversation_threads t ON t.id=o.thread_id
    WHERE o.id=p_outbox_id AND o.author='human_staff';
  IF NOT FOUND THEN RETURN 'lease_lost'; END IF;
  v_result:=aichm_private.record_conversation_send_result(
    p_outbox_id,p_attempt_id,p_lease_token,p_result,
    CASE WHEN p_result='sent' THEN p_provider_message_aliases[1] ELSE NULL END
  );
  IF v_result='lease_lost' AND p_result='sent' THEN
    -- A response arriving after the sending lease expired is correlated for
    -- receipts but remains UNKNOWN; this never turns into a retry or a status
    -- regression.
    SELECT a.provider_message_key INTO v_existing_provider_key
      FROM aichm_private.conversation_outbox_attempts a
      JOIN aichm_private.conversation_outbox o ON o.id=a.outbox_id
      WHERE a.id=p_attempt_id AND a.outbox_id=p_outbox_id
        AND o.state='unknown' AND a.state='unknown'
        AND a.lease_token=p_lease_token
      FOR UPDATE OF a;
    v_late_match:=FOUND;
    IF v_late_match AND (v_existing_provider_key IS NULL
      OR v_existing_provider_key=p_provider_message_aliases[1]) THEN
      UPDATE aichm_private.conversation_outbox_attempts
        SET provider_message_key=p_provider_message_aliases[1]
        WHERE id=p_attempt_id AND provider_message_key IS NULL;
      UPDATE aichm_private.conversation_messages m
        SET provider_message_key=p_provider_message_aliases[1]
        WHERE m.id=v_message_id
          AND (m.provider_message_key IS NULL OR m.provider_message_key=p_provider_message_aliases[1])
          AND m.delivery_state='unknown';
      PERFORM aichm_private.bind_provider_reference_aliases(
        v_provider,'message',p_provider_message_aliases,v_message_id
      );
      RETURN 'unknown';
    END IF;
    IF v_late_match THEN
      RAISE EXCEPTION 'human_pilot_late_provider_reference_conflict' USING ERRCODE='P0001';
    END IF;
  END IF;
  IF v_result='sent' THEN
    PERFORM aichm_private.bind_provider_reference_aliases(
      v_provider,'message',p_provider_message_aliases,v_message_id
    );
  END IF;
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION aichm_private.cancel_stale_human_pilot_outbound()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_outbox aichm_private.conversation_outbox%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF NEW.control_version=OLD.control_version AND NEW.mode=OLD.mode THEN RETURN NEW; END IF;
  v_now:=clock_timestamp();
  FOR v_outbox IN
    SELECT o.* FROM aichm_private.conversation_outbox o
    WHERE o.thread_id=NEW.id AND o.state IN ('pending','claimed')
      AND ((NEW.mode='ai' AND o.author='human_staff')
        OR (NEW.mode='human' AND o.author='assistant'))
    ORDER BY o.id FOR UPDATE
  LOOP
    UPDATE aichm_private.conversation_outbox_attempts a
      SET state='cancelled',delivery_state='cancelled',finished_at=v_now
      WHERE a.outbox_id=v_outbox.id AND a.state='claimed';
    UPDATE aichm_private.conversation_messages m
      SET delivery_state='cancelled'
      WHERE m.id=v_outbox.message_id AND m.delivery_state='queued';
    UPDATE aichm_private.conversation_outbox o
      SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,
          last_error_code='control_version_changed',updated_at=v_now
      WHERE o.id=v_outbox.id;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER avni_cancel_stale_human_pilot_outbound
AFTER UPDATE OF mode,control_version ON aichm_private.conversation_threads
FOR EACH ROW EXECUTE FUNCTION aichm_private.cancel_stale_human_pilot_outbound();

ALTER FUNCTION aichm_private.cancel_stale_human_pilot_outbound() OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.find_human_pilot_outbound(text) OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.read_human_pilot_thread(uuid,bigint) OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.claim_human_pilot_outbound(uuid,integer) OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.begin_human_pilot_send(uuid,uuid,uuid,uuid,bigint,text,text)
  OWNER TO aichm_conversation_owner;
ALTER FUNCTION aichm_private.record_human_pilot_send_result(uuid,uuid,uuid,text,text[])
  OWNER TO aichm_conversation_owner;
REVOKE ALL ON FUNCTION aichm_private.find_human_pilot_outbound(text)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.cancel_stale_human_pilot_outbound()
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.read_human_pilot_thread(uuid,bigint)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.claim_human_pilot_outbound(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.begin_human_pilot_send(uuid,uuid,uuid,uuid,bigint,text,text)
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
REVOKE ALL ON FUNCTION aichm_private.record_human_pilot_send_result(uuid,uuid,uuid,text,text[])
  FROM PUBLIC,anon,authenticated,service_role,aichm_crm_reader,aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.find_human_pilot_outbound(text)
  TO aichm_conversation_runtime,aichm_crm_reader;
GRANT EXECUTE ON FUNCTION aichm_private.read_human_pilot_thread(uuid,bigint)
  TO aichm_conversation_runtime,aichm_crm_reader;
GRANT EXECUTE ON FUNCTION aichm_private.claim_human_pilot_outbound(uuid,integer) TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.begin_human_pilot_send(uuid,uuid,uuid,uuid,bigint,text,text)
  TO aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.record_human_pilot_send_result(uuid,uuid,uuid,text,text[])
  TO aichm_conversation_runtime;

COMMIT;
