-- Canonical per-lead CRM assignment and immutable assignment history.
-- This file is additive and is not applied at application startup.
BEGIN;

CREATE TABLE IF NOT EXISTS admissions_lead_assignments (
  lead_id uuid PRIMARY KEY REFERENCES admissions_leads(id) ON DELETE RESTRICT,
  assignee_user_id integer REFERENCES lms_users(id) ON DELETE RESTRICT,
  assigned_by integer NOT NULL REFERENCES lms_users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT admissions_lead_assignments_version_ck CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS admissions_lead_assignments_assignee_idx
  ON admissions_lead_assignments(assignee_user_id,lead_id);

CREATE TABLE IF NOT EXISTS admissions_lead_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES admissions_leads(id) ON DELETE RESTRICT,
  previous_assignee_user_id integer REFERENCES lms_users(id) ON DELETE RESTRICT,
  new_assignee_user_id integer REFERENCES lms_users(id) ON DELETE RESTRICT,
  actor_user_id integer NOT NULL REFERENCES lms_users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  source text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  assignment_version integer NOT NULL,
  CONSTRAINT admissions_lead_assignment_history_reason_ck
    CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT admissions_lead_assignment_history_source_ck CHECK (source IN ('admin_ui')),
  CONSTRAINT admissions_lead_assignment_history_version_ck CHECK (assignment_version > 0),
  CONSTRAINT admissions_lead_assignment_history_changed_ck
    CHECK (previous_assignee_user_id IS DISTINCT FROM new_assignee_user_id)
);
CREATE INDEX IF NOT EXISTS admissions_lead_assignment_history_lead_time_idx
  ON admissions_lead_assignment_history(lead_id,changed_at);
CREATE INDEX IF NOT EXISTS admissions_lead_assignment_history_assignee_time_idx
  ON admissions_lead_assignment_history(new_assignee_user_id,changed_at);
CREATE UNIQUE INDEX IF NOT EXISTS admissions_lead_assignment_history_lead_version_uidx
  ON admissions_lead_assignment_history(lead_id,assignment_version);

CREATE OR REPLACE FUNCTION public.aichm_validate_lead_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id=u.id
    WHERE u.id=NEW.assigned_by AND u.is_active AND r.role::text='admin'
  ) THEN
    RAISE EXCEPTION 'CRM assignment actor must be an active administrator'
      USING ERRCODE='23514';
  END IF;
  IF NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id=u.id
    WHERE u.id=NEW.assignee_user_id AND u.is_active AND r.role::text='admissions'
      AND NOT EXISTS (
        SELECT 1 FROM public.lms_user_roles admin_role
        WHERE admin_role.user_id=u.id AND admin_role.role::text='admin'
      )
  ) THEN
    RAISE EXCEPTION 'CRM assignee must be an active admissions user'
      USING ERRCODE='23514';
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
    JOIN public.lms_user_roles r ON r.user_id=u.id
    WHERE u.id=NEW.actor_user_id AND u.is_active AND r.role::text='admin'
  ) THEN
    RAISE EXCEPTION 'CRM assignment history actor must be an active administrator'
      USING ERRCODE='23514';
  END IF;
  IF NEW.new_assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lms_users u
    JOIN public.lms_user_roles r ON r.user_id=u.id
    WHERE u.id=NEW.new_assignee_user_id AND u.is_active AND r.role::text='admissions'
      AND NOT EXISTS (
        SELECT 1 FROM public.lms_user_roles admin_role
        WHERE admin_role.user_id=u.id AND admin_role.role::text='admin'
      )
  ) THEN
    RAISE EXCEPTION 'CRM history target must be an active admissions user'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admissions_lead_assignments a
    WHERE a.lead_id=NEW.lead_id
      AND a.assignee_user_id IS NOT DISTINCT FROM NEW.new_assignee_user_id
      AND a.version=NEW.assignment_version
  ) THEN
    RAISE EXCEPTION 'CRM assignment history must match the committed assignment version'
      USING ERRCODE='23514';
  END IF;
  IF NEW.assignment_version=1 THEN
    IF NEW.previous_assignee_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'The first CRM assignment history event must start unassigned'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.admissions_lead_assignment_history previous_event
      WHERE previous_event.lead_id=NEW.lead_id
        AND previous_event.assignment_version=NEW.assignment_version-1
        AND previous_event.new_assignee_user_id IS NOT DISTINCT FROM NEW.previous_assignee_user_id
    ) THEN
      RAISE EXCEPTION 'CRM assignment history must continue the prior assignment version'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.aichm_reject_lead_assignment_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'CRM assignment history is append-only'
    USING ERRCODE='42501';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='admissions_lead_assignments_validate_trg'
      AND tgrelid='public.admissions_lead_assignments'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER admissions_lead_assignments_validate_trg
      BEFORE INSERT OR UPDATE ON public.admissions_lead_assignments
      FOR EACH ROW EXECUTE FUNCTION public.aichm_validate_lead_assignment();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='admissions_lead_assignment_history_validate_trg'
      AND tgrelid='public.admissions_lead_assignment_history'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER admissions_lead_assignment_history_validate_trg
      BEFORE INSERT ON public.admissions_lead_assignment_history
      FOR EACH ROW EXECUTE FUNCTION public.aichm_validate_lead_assignment_history();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='admissions_lead_assignment_history_immutable_trg'
      AND tgrelid='public.admissions_lead_assignment_history'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER admissions_lead_assignment_history_immutable_trg
      BEFORE UPDATE OR DELETE ON public.admissions_lead_assignment_history
      FOR EACH ROW EXECUTE FUNCTION public.aichm_reject_lead_assignment_history_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='admissions_lead_assignment_history_no_truncate_trg'
      AND tgrelid='public.admissions_lead_assignment_history'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER admissions_lead_assignment_history_no_truncate_trg
      BEFORE TRUNCATE ON public.admissions_lead_assignment_history
      FOR EACH STATEMENT EXECUTE FUNCTION public.aichm_reject_lead_assignment_history_mutation();
  END IF;
END;
$$;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE admissions_lead_assignment_history FROM PUBLIC;
COMMIT;
