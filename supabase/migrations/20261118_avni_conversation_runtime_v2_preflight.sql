-- Draft, read-only authorization preflight for the trusted Replit server.
-- Do not apply to a live Supabase project without separate review.
-- This migration creates no provider route, sender, or send authorization.

BEGIN;

DO $preflight_prerequisites$
BEGIN
  IF to_regclass('public.leads') IS NULL
     OR to_regclass('aichm_private.conversation_threads') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='aichm_conversation_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='aichm_crm_reader')
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='leads'
         AND column_name IN ('id','replit_lead_id')
       GROUP BY table_name
       HAVING count(*)=2
     )
  THEN
    RAISE EXCEPTION 'AVNI_CONVERSATION_PREFLIGHT_PREREQUISITE_MISSING';
  END IF;
END
$preflight_prerequisites$;

-- The NOLOGIN conversation owner can read only the two crosswalk columns.
-- If public.leads has RLS enabled, this policy limits its SECURITY DEFINER
-- lookup to rows with a Replit crosswalk. The role has no login or membership.
GRANT USAGE ON SCHEMA public TO aichm_conversation_owner;
GRANT SELECT (id,replit_lead_id) ON public.leads TO aichm_conversation_owner;
DO $preflight_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='leads'
      AND p.polname='avni_conversation_owner_crosswalk_select'
  ) THEN
    CREATE POLICY avni_conversation_owner_crosswalk_select ON public.leads
      FOR SELECT TO aichm_conversation_owner
      USING (replit_lead_id IS NOT NULL);
  END IF;
END
$preflight_policy$;

CREATE OR REPLACE FUNCTION aichm_private.preflight_conversation_for_replit_lead(
  p_replit_lead_id uuid,
  p_expected_control_version bigint
) RETURNS TABLE(
  outcome text,
  thread_id uuid,
  mode text,
  lifecycle text,
  control_version bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, aichm_private, pg_temp
AS $function$
DECLARE
  v_crosswalk_count integer;
  v_supabase_lead_id uuid;
  v_thread_count integer;
  v_thread aichm_private.conversation_threads%ROWTYPE;
BEGIN
  IF p_replit_lead_id IS NULL OR p_expected_control_version IS NULL
     OR p_expected_control_version<0 THEN
    RETURN QUERY SELECT 'invalid_request'::text,NULL::uuid,NULL::text,NULL::text,NULL::bigint;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_crosswalk_count
  FROM public.leads l
  WHERE l.replit_lead_id=p_replit_lead_id;
  IF v_crosswalk_count=0 THEN
    RETURN QUERY SELECT 'crosswalk_missing'::text,NULL::uuid,NULL::text,NULL::text,NULL::bigint;
    RETURN;
  END IF;
  IF v_crosswalk_count<>1 THEN
    RETURN QUERY SELECT 'crosswalk_ambiguous'::text,NULL::uuid,NULL::text,NULL::text,NULL::bigint;
    RETURN;
  END IF;

  SELECT l.id INTO v_supabase_lead_id
  FROM public.leads l
  WHERE l.replit_lead_id=p_replit_lead_id
  LIMIT 1;

  SELECT count(*)::integer INTO v_thread_count
  FROM aichm_private.conversation_threads t
  WHERE t.supabase_lead_id=v_supabase_lead_id AND t.mapping_status='mapped';
  IF v_thread_count=0 THEN
    RETURN QUERY SELECT 'conversation_missing'::text,NULL::uuid,NULL::text,NULL::text,NULL::bigint;
    RETURN;
  END IF;
  IF v_thread_count<>1 THEN
    RETURN QUERY SELECT 'conversation_ambiguous'::text,NULL::uuid,NULL::text,NULL::text,NULL::bigint;
    RETURN;
  END IF;

  SELECT t.* INTO v_thread
  FROM aichm_private.conversation_threads t
  WHERE t.supabase_lead_id=v_supabase_lead_id AND t.mapping_status='mapped'
  LIMIT 1;
  IF v_thread.lifecycle<>'open' THEN
    RETURN QUERY SELECT 'conversation_closed'::text,NULL::uuid,v_thread.mode,
      v_thread.lifecycle,v_thread.control_version;
    RETURN;
  END IF;
  IF v_thread.control_version<>p_expected_control_version THEN
    RETURN QUERY SELECT 'stale_control_version'::text,NULL::uuid,v_thread.mode,
      v_thread.lifecycle,v_thread.control_version;
    RETURN;
  END IF;

  -- The internal thread UUID is returned only to the server-side reader.
  -- The Replit adapter must strip it from every client-facing result and must
  -- never treat this preflight as permission to enqueue or send.
  RETURN QUERY SELECT 'preflight_ready'::text,v_thread.id,v_thread.mode,
    v_thread.lifecycle,v_thread.control_version;
END
$function$;

ALTER FUNCTION aichm_private.preflight_conversation_for_replit_lead(uuid,bigint)
  OWNER TO aichm_conversation_owner;
REVOKE ALL ON FUNCTION aichm_private.preflight_conversation_for_replit_lead(uuid,bigint)
  FROM PUBLIC,anon,authenticated,service_role,aichm_conversation_runtime;
GRANT EXECUTE ON FUNCTION aichm_private.preflight_conversation_for_replit_lead(uuid,bigint)
  TO aichm_crm_reader;

COMMIT;
