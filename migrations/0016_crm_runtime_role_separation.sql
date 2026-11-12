BEGIN;

-- Group roles only. If an operator pre-provisions them to verify a candidate
-- app login before migration, validate rather than rewrite their attributes.
-- Login credentials are provisioned separately and never embedded here.
DO $$
DECLARE
  role_name text;
  existing_role record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'aichm_crm_owner', 'aichm_app_runtime', 'aichm_crm_migrator'
  ] LOOP
    SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls
      INTO existing_role FROM pg_roles WHERE rolname=role_name;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
        role_name
      );
    ELSIF existing_role.rolcanlogin OR existing_role.rolsuper OR existing_role.rolcreatedb
       OR existing_role.rolcreaterole OR existing_role.rolinherit OR existing_role.rolbypassrls THEN
      RAISE EXCEPTION 'CRM group role has unsafe attributes';
    END IF;
  END LOOP;
END
$$;

GRANT aichm_crm_owner TO aichm_crm_migrator;
GRANT USAGE ON SCHEMA public TO aichm_crm_owner, aichm_app_runtime, aichm_crm_migrator;
REVOKE CREATE ON SCHEMA public FROM aichm_app_runtime;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO aichm_app_runtime', current_database());
END
$$;

DO $$
BEGIN
  IF to_regclass('public.admissions_lead_assignments') IS NULL
     OR to_regclass('public.admissions_lead_assignment_history') IS NULL
     OR to_regclass('public.admissions_leads') IS NULL
     OR to_regclass('public.lms_users') IS NULL
     OR to_regclass('public.lms_user_roles') IS NULL THEN
    RAISE EXCEPTION 'CRM role separation prerequisites are missing';
  END IF;
  IF pg_has_role('aichm_app_runtime', 'aichm_crm_owner', 'MEMBER')
     OR pg_has_role('aichm_app_runtime', 'aichm_crm_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'application role must not belong to owner or migrator';
  END IF;
END
$$;

-- The non-login owner executes the SECURITY DEFINER assignment transaction.
-- UPDATE is required here for row locks; the application role does not receive
-- UPDATE on user roles and cannot assume this owner role.
GRANT SELECT, UPDATE ON TABLE public.admissions_leads, public.lms_users, public.lms_user_roles
  TO aichm_crm_owner;
ALTER TABLE public.admissions_lead_assignments OWNER TO aichm_crm_owner;
ALTER TABLE public.admissions_lead_assignment_history OWNER TO aichm_crm_owner;
ALTER FUNCTION public.aichm_validate_lead_assignment() OWNER TO aichm_crm_owner;
ALTER FUNCTION public.aichm_validate_lead_assignment_history() OWNER TO aichm_crm_owner;
ALTER FUNCTION public.aichm_reject_lead_assignment_history_mutation() OWNER TO aichm_crm_owner;
ALTER FUNCTION public.aichm_require_assignment_history_for_change() OWNER TO aichm_crm_owner;
ALTER FUNCTION public.aichm_reject_lead_assignment_mutation() OWNER TO aichm_crm_owner;

REVOKE ALL ON TABLE public.admissions_lead_assignments,
  public.admissions_lead_assignment_history FROM PUBLIC, aichm_app_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM aichm_app_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM aichm_app_runtime;

-- Apply only the operations found in the shared-pool source inventory. Missing
-- optional feature tables are skipped; their grants are added by a later
-- reviewed migration if that feature is installed.
DO $$
DECLARE
  required_table record;
  sequence_name text;
BEGIN
  FOR required_table IN
    SELECT * FROM (VALUES
      ('admissions_lead_assignments','SELECT'),
      ('admissions_lead_assignment_history','SELECT'),
      ('sessions','SELECT, INSERT, UPDATE, DELETE'),
      ('inquiries','SELECT, INSERT, UPDATE'),
      ('counselling_delivery_attempts','SELECT, INSERT, UPDATE'),
      ('admissions_leads','SELECT, INSERT, UPDATE'),
      ('admissions_crm_profiles','SELECT, INSERT, UPDATE'),
      ('admissions_crm_activities','SELECT, INSERT'),
      ('admissions_lead_contact_preferences','SELECT, INSERT, UPDATE'),
      ('admissions_registration_outbox','SELECT, INSERT, UPDATE'),
      ('admissions_vsl_playbacks','SELECT, INSERT, UPDATE'),
      ('admissions_vsl_events','SELECT, INSERT'),
      ('admissions_capture_limits','SELECT, INSERT, UPDATE'),
      ('admissions_marketing_consent_events','SELECT, INSERT, UPDATE'),
      ('admissions_lead_touchpoints','SELECT, INSERT'),
      ('admissions_meta_lead_links','SELECT, INSERT'),
      ('admissions_meta_event_outbox','SELECT, INSERT, UPDATE'),
      ('admissions_legacy_lead_links','SELECT'),
      ('lms_users','SELECT, INSERT, UPDATE'),
      ('lms_user_roles','SELECT, INSERT'),
      ('lms_courses','SELECT, INSERT, UPDATE'),
      ('lms_enrollments','SELECT, INSERT, UPDATE'),
      ('lms_modules','SELECT, INSERT, UPDATE'),
      ('lms_chapters','SELECT, INSERT, UPDATE'),
      ('lms_lessons','SELECT, INSERT, UPDATE'),
      ('lms_resources','SELECT, INSERT'),
      ('lms_invitation_codes','SELECT, INSERT, UPDATE'),
      ('lms_invitation_redemptions','INSERT'),
      ('lms_lesson_progress','SELECT, INSERT, UPDATE'),
      ('lms_trainer_assignments','SELECT, INSERT, DELETE'),
      ('lms_assessments','SELECT, INSERT, UPDATE'),
      ('lms_assessment_versions','SELECT, INSERT'),
      ('lms_assessment_questions','SELECT, INSERT'),
      ('lms_assessment_options','SELECT, INSERT'),
      ('lms_assessment_attempts','SELECT, INSERT'),
      ('lms_live_sessions','SELECT, INSERT, UPDATE'),
      ('lms_certificates','SELECT, INSERT, UPDATE'),
      ('lms_notifications','SELECT, INSERT, UPDATE'),
      ('lms_audit_logs','SELECT, INSERT'),
      ('lms_password_setup_tokens','SELECT, INSERT, UPDATE, DELETE'),
      ('lms_auth_rate_limits','SELECT, INSERT, UPDATE, DELETE'),
      ('calendar_resources','SELECT, INSERT'),
      ('calendar_batches','SELECT, INSERT'),
      ('calendar_batch_students','SELECT, INSERT'),
      ('calendar_events','SELECT, INSERT, UPDATE'),
      ('calendar_integration_requests','SELECT, INSERT'),
      ('calendar_event_attendees','SELECT, INSERT, DELETE'),
      ('staff_availability','SELECT, INSERT'),
      ('availability_exceptions','SELECT, INSERT'),
      ('notification_preferences','SELECT, INSERT, UPDATE'),
      ('push_subscriptions','SELECT, INSERT, UPDATE'),
      ('calendar_reminder_jobs','SELECT, INSERT, UPDATE'),
      ('notification_delivery_logs','SELECT, INSERT'),
      ('calendar_activity','INSERT')
    ) AS grants(table_name, privileges)
  LOOP
    IF to_regclass(format('public.%I', required_table.table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT %s ON TABLE public.%I TO aichm_app_runtime',
        required_table.privileges,
        required_table.table_name
      );
      IF position('INSERT' IN required_table.privileges) > 0 THEN
        IF EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid=to_regclass(format('public.%I', required_table.table_name))
            AND attname='id' AND attnum>0 AND NOT attisdropped
        ) THEN
          sequence_name := pg_get_serial_sequence(
            format('public.%I', required_table.table_name),
            'id'
          );
          IF sequence_name IS NOT NULL THEN
            EXECUTE format('GRANT USAGE ON SEQUENCE %s TO aichm_app_runtime', sequence_name::regclass);
          END IF;
        END IF;
      END IF;
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.aichm_assign_crm_lead(
  p_lead_id uuid,
  p_actor_user_id integer,
  p_assignee_user_id integer,
  p_reason text,
  p_request_id uuid,
  p_expected_version integer
)
RETURNS TABLE (
  result_lead_id uuid,
  result_assignee_user_id integer,
  result_version integer,
  result_request_id uuid,
  result_changed_at timestamptz,
  result_replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  prior_event public.admissions_lead_assignment_history%ROWTYPE;
  current_assignment public.admissions_lead_assignments%ROWTYPE;
  new_version integer;
  event_time timestamptz;
BEGIN
  IF p_lead_id IS NULL OR p_actor_user_id IS NULL OR p_request_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_reason IS NULL OR p_reason IS DISTINCT FROM btrim(p_reason)
     OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'invalid assignment request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(1095326536, hashtext(p_request_id::text));

  PERFORM 1
  FROM public.lms_users actor
  JOIN public.lms_user_roles actor_role ON actor_role.user_id = actor.id
  WHERE actor.id = p_actor_user_id
    AND actor.is_active IS TRUE
    AND actor_role.role::text = 'admin'
  FOR SHARE OF actor, actor_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment actor is not an active administrator' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO prior_event
  FROM public.admissions_lead_assignment_history h
  WHERE h.request_id = p_request_id;
  IF FOUND THEN
    IF prior_event.lead_id IS DISTINCT FROM p_lead_id
       OR prior_event.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR prior_event.new_assignee_user_id IS DISTINCT FROM p_assignee_user_id
       OR prior_event.reason IS DISTINCT FROM p_reason
       OR prior_event.assignment_version IS DISTINCT FROM p_expected_version + 1 THEN
      RAISE EXCEPTION 'request id already used for another assignment' USING ERRCODE = 'P0003';
    END IF;
    RETURN QUERY SELECT
      prior_event.lead_id,
      prior_event.new_assignee_user_id,
      prior_event.assignment_version,
      prior_event.request_id,
      prior_event.changed_at,
      true;
    RETURN;
  END IF;

  IF p_assignee_user_id IS NOT NULL THEN
    PERFORM 1
    FROM public.lms_users target
    JOIN public.lms_user_roles target_role ON target_role.user_id = target.id
    WHERE target.id = p_assignee_user_id
      AND target.is_active IS TRUE
      AND target_role.role::text = 'admissions'
      AND NOT EXISTS (
        SELECT 1 FROM public.lms_user_roles admin_role
        WHERE admin_role.user_id = target.id AND admin_role.role::text = 'admin'
      )
    FOR SHARE OF target, target_role;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assignment target is not an active admissions user' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM 1 FROM public.admissions_leads lead
  WHERE lead.id = p_lead_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM lead not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO current_assignment
  FROM public.admissions_lead_assignments assignment
  WHERE assignment.lead_id = p_lead_id
  FOR UPDATE;
  new_version := COALESCE(current_assignment.version, 0) + 1;
  IF COALESCE(current_assignment.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION 'assignment version conflict' USING ERRCODE = 'P0003';
  END IF;
  IF current_assignment.lead_id IS NOT NULL
     AND current_assignment.assignee_user_id IS NOT DISTINCT FROM p_assignee_user_id THEN
    RAISE EXCEPTION 'assignment state is unchanged' USING ERRCODE = 'P0004';
  END IF;

  IF current_assignment.lead_id IS NULL THEN
    INSERT INTO public.admissions_lead_assignments(
      lead_id, assignee_user_id, assigned_by, version
    ) VALUES (p_lead_id, p_assignee_user_id, p_actor_user_id, 1);
  ELSE
    UPDATE public.admissions_lead_assignments
    SET assignee_user_id = p_assignee_user_id,
        assigned_by = p_actor_user_id,
        updated_at = now(),
        version = version + 1
    WHERE lead_id = p_lead_id AND version = p_expected_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assignment version conflict' USING ERRCODE = 'P0003';
    END IF;
  END IF;

  INSERT INTO public.admissions_lead_assignment_history(
    lead_id, previous_assignee_user_id, new_assignee_user_id, actor_user_id,
    reason, source, request_id, assignment_version
  ) VALUES (
    p_lead_id,
    CASE WHEN current_assignment.lead_id IS NULL THEN NULL ELSE current_assignment.assignee_user_id END,
    p_assignee_user_id,
    p_actor_user_id,
    p_reason,
    'admin_ui',
    p_request_id,
    new_version
  ) RETURNING changed_at INTO event_time;

  RETURN QUERY SELECT p_lead_id, p_assignee_user_id, new_version, p_request_id, event_time, false;
END
$function$;

ALTER FUNCTION public.aichm_assign_crm_lead(uuid, integer, integer, text, uuid, integer)
  OWNER TO aichm_crm_owner;
REVOKE ALL ON FUNCTION public.aichm_assign_crm_lead(uuid, integer, integer, text, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aichm_assign_crm_lead(uuid, integer, integer, text, uuid, integer)
  TO aichm_app_runtime;

REVOKE ALL ON FUNCTION public.aichm_validate_lead_assignment() FROM PUBLIC, aichm_app_runtime;
REVOKE ALL ON FUNCTION public.aichm_validate_lead_assignment_history() FROM PUBLIC, aichm_app_runtime;
REVOKE ALL ON FUNCTION public.aichm_reject_lead_assignment_history_mutation() FROM PUBLIC, aichm_app_runtime;
REVOKE ALL ON FUNCTION public.aichm_require_assignment_history_for_change() FROM PUBLIC, aichm_app_runtime;
REVOKE ALL ON FUNCTION public.aichm_reject_lead_assignment_mutation() FROM PUBLIC, aichm_app_runtime;

REVOKE CREATE ON SCHEMA public FROM aichm_app_runtime;

COMMIT;
