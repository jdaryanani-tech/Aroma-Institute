-- Require every canonical assignment change to have its matching immutable
-- history event in the same transaction. This is additive to migration 0014.
BEGIN;

CREATE OR REPLACE FUNCTION public.aichm_validate_lead_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CRM assignments cannot be deleted; unassign with a history event'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id = u.id
    WHERE u.id = NEW.assigned_by AND u.is_active AND r.role::text = 'admin'
  ) THEN
    RAISE EXCEPTION 'CRM assignment actor must be an active administrator'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id = u.id
    WHERE u.id = NEW.assignee_user_id AND u.is_active AND r.role::text = 'admissions'
      AND NOT EXISTS (
        SELECT 1 FROM public.lms_user_roles admin_role
        WHERE admin_role.user_id = u.id AND admin_role.role::text = 'admin'
      )
  ) THEN
    RAISE EXCEPTION 'CRM assignee must be an active admissions user'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'The first CRM assignment version must be 1'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'CRM assignment version must increase by exactly one'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.assignee_user_id IS NOT DISTINCT FROM OLD.assignee_user_id THEN
      RAISE EXCEPTION 'CRM assignment changes must change the assignee state'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.aichm_validate_lead_assignment_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id = u.id
    WHERE u.id = NEW.actor_user_id AND u.is_active AND r.role::text = 'admin'
  ) THEN
    RAISE EXCEPTION 'CRM assignment history actor must be an active administrator'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.new_assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id = u.id
    WHERE u.id = NEW.new_assignee_user_id AND u.is_active AND r.role::text = 'admissions'
      AND NOT EXISTS (
        SELECT 1 FROM public.lms_user_roles admin_role
        WHERE admin_role.user_id = u.id AND admin_role.role::text = 'admin'
      )
  ) THEN
    RAISE EXCEPTION 'CRM history target must be an active admissions user'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admissions_lead_assignments a
    WHERE a.lead_id = NEW.lead_id
      AND a.assignee_user_id IS NOT DISTINCT FROM NEW.new_assignee_user_id
      AND a.assigned_by = NEW.actor_user_id
      AND a.version = NEW.assignment_version
  ) THEN
    RAISE EXCEPTION 'CRM assignment history must match the committed assignment version and actor'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.assignment_version = 1 THEN
    IF NEW.previous_assignee_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'The first CRM assignment history event must start unassigned'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.admissions_lead_assignment_history previous_event
    WHERE previous_event.lead_id = NEW.lead_id
      AND previous_event.assignment_version = NEW.assignment_version - 1
      AND previous_event.new_assignee_user_id IS NOT DISTINCT FROM NEW.previous_assignee_user_id
  ) THEN
    RAISE EXCEPTION 'CRM assignment history must continue the prior assignment version'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.aichm_require_assignment_history_for_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_previous integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_previous := NULL;
  ELSE
    expected_previous := OLD.assignee_user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admissions_lead_assignment_history h
    WHERE h.lead_id = NEW.lead_id
      AND h.assignment_version = NEW.version
      AND h.previous_assignee_user_id IS NOT DISTINCT FROM expected_previous
      AND h.new_assignee_user_id IS NOT DISTINCT FROM NEW.assignee_user_id
      AND h.actor_user_id = NEW.assigned_by
  ) THEN
    RAISE EXCEPTION 'CRM assignment change requires a matching history event in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.aichm_reject_lead_assignment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'CRM assignments cannot be deleted or truncated'
    USING ERRCODE = '42501';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'admissions_lead_assignments_history_required_trg'
      AND tgrelid = 'public.admissions_lead_assignments'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE CONSTRAINT TRIGGER admissions_lead_assignments_history_required_trg
      AFTER INSERT OR UPDATE ON public.admissions_lead_assignments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.aichm_require_assignment_history_for_change();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'admissions_lead_assignments_no_delete_trg'
      AND tgrelid = 'public.admissions_lead_assignments'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER admissions_lead_assignments_no_delete_trg
      BEFORE DELETE ON public.admissions_lead_assignments
      FOR EACH ROW EXECUTE FUNCTION public.aichm_reject_lead_assignment_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'admissions_lead_assignments_no_truncate_trg'
      AND tgrelid = 'public.admissions_lead_assignments'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER admissions_lead_assignments_no_truncate_trg
      BEFORE TRUNCATE ON public.admissions_lead_assignments
      FOR EACH STATEMENT EXECUTE FUNCTION public.aichm_reject_lead_assignment_mutation();
  END IF;
END;
$$;

COMMIT;
