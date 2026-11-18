-- Draft only: strengthen the future AVNI dispatch authorization ledger.
-- Do not apply to Production as part of this source-only change.
-- The ledger remains incapable of authorizing an actual provider call.
BEGIN;

ALTER TABLE public.admissions_conversation_dispatch_grants
  ADD COLUMN IF NOT EXISTS actor_user_id integer
    REFERENCES public.lms_users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS actor_access_level text,
  ADD COLUMN IF NOT EXISTS assignment_assignee_user_id integer
    REFERENCES public.lms_users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS assignment_version integer;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname='admissions_dispatch_grant_actor_scope_ck'
      AND conrelid='public.admissions_conversation_dispatch_grants'::regclass
  ) THEN
    ALTER TABLE public.admissions_conversation_dispatch_grants
      ADD CONSTRAINT admissions_dispatch_grant_actor_scope_ck CHECK (
        (actor_user_id IS NULL AND actor_access_level IS NULL
          AND assignment_assignee_user_id IS NULL AND assignment_version IS NULL)
        OR (actor_user_id IS NOT NULL
          AND actor_access_level IN ('admin','admissions')
          AND assignment_version IS NOT NULL AND assignment_version >= 0
          AND (assignment_version>0 OR assignment_assignee_user_id IS NULL))
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname='admissions_contact_consent_epoch_nonnegative_ck'
      AND conrelid='public.admissions_lead_contact_preferences'::regclass
  ) THEN
    ALTER TABLE public.admissions_lead_contact_preferences
      ADD CONSTRAINT admissions_contact_consent_epoch_nonnegative_ck
      CHECK (consent_epoch >= 0);
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS admissions_dispatch_grants_actor_idx
  ON public.admissions_conversation_dispatch_grants(actor_user_id, state, expires_at);

CREATE OR REPLACE FUNCTION public.enforce_admissions_consent_epoch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  old_effective text;
  new_effective text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.consent_epoch := CASE
      WHEN NEW.consent_status <> 'not_provided' OR NEW.opted_out_at IS NOT NULL THEN 1
      ELSE 0
    END;
    RETURN NEW;
  END IF;

  old_effective := CASE
    WHEN OLD.consent_status = 'opted_out' OR OLD.opted_out_at IS NOT NULL THEN 'opted_out'
    WHEN OLD.consent_status = 'granted' THEN 'granted'
    ELSE 'not_granted'
  END;
  new_effective := CASE
    WHEN NEW.consent_status = 'opted_out' OR NEW.opted_out_at IS NOT NULL THEN 'opted_out'
    WHEN NEW.consent_status = 'granted' THEN 'granted'
    ELSE 'not_granted'
  END;

  -- The database, not a caller-supplied value, owns this monotonic epoch.
  IF old_effective IS DISTINCT FROM new_effective
    OR OLD.consent_recorded_at IS DISTINCT FROM NEW.consent_recorded_at
    OR OLD.consent_source IS DISTINCT FROM NEW.consent_source
    OR OLD.consent_text IS DISTINCT FROM NEW.consent_text
    OR OLD.consent_version IS DISTINCT FROM NEW.consent_version
    OR OLD.opt_out_source IS DISTINCT FROM NEW.opt_out_source
  THEN
    NEW.consent_epoch := OLD.consent_epoch + 1;
    UPDATE public.admissions_conversation_dispatch_grants
    SET state='revoked',
        safe_outcome='send_denied',
        completed_at=clock_timestamp()
    WHERE lead_id=NEW.lead_id AND state='issued';
  ELSE
    NEW.consent_epoch := OLD.consent_epoch;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS admissions_consent_epoch_guard
  ON public.admissions_lead_contact_preferences;
CREATE TRIGGER admissions_consent_epoch_guard
BEFORE INSERT OR UPDATE ON public.admissions_lead_contact_preferences
FOR EACH ROW EXECUTE FUNCTION public.enforce_admissions_consent_epoch();

REVOKE ALL ON FUNCTION public.enforce_admissions_consent_epoch() FROM PUBLIC;

DO $acl$
DECLARE
  runtime_oid oid;
  login_oid oid;
  owner_oid oid;
  role_name text;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='aichm_app_runtime';
  SELECT oid INTO login_oid FROM pg_catalog.pg_roles WHERE rolname='aichm_app_login';
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname='aichm_crm_owner';
  IF runtime_oid IS NULL OR login_oid IS NULL OR owner_oid IS NULL THEN
    RAISE EXCEPTION 'required application runtime roles are not provisioned';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=runtime_oid
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolinherit OR rolbypassrls OR rolreplication))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=login_oid
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR NOT rolinherit OR rolbypassrls OR rolreplication))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=owner_oid
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolinherit OR rolbypassrls OR rolreplication))
  THEN
    RAISE EXCEPTION 'application runtime role attributes are unsafe';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members
      WHERE roleid=runtime_oid) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members
       WHERE roleid=runtime_oid AND member=login_oid AND NOT admin_option
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members
       WHERE member=runtime_oid
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members
       WHERE member=login_oid AND roleid<>runtime_oid
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members
       WHERE roleid=login_oid
     )
  THEN
    RAISE EXCEPTION 'application runtime role membership is not least privilege';
  END IF;

  ALTER TABLE public.admissions_conversation_dispatch_grants OWNER TO aichm_crm_owner;
  REVOKE ALL ON TABLE public.admissions_conversation_dispatch_grants FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY[
    'anon','authenticated','service_role','aichm_crm_reader',
    'aichm_crm_owner','aichm_crm_migrator'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.admissions_conversation_dispatch_grants FROM %I',
        role_name
      );
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.admissions_conversation_dispatch_grants FROM aichm_app_runtime;
  GRANT SELECT, INSERT, UPDATE
    ON TABLE public.admissions_conversation_dispatch_grants TO aichm_app_runtime;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))
    ) acl
    WHERE c.oid='public.admissions_conversation_dispatch_grants'::regclass
      AND acl.grantee NOT IN (owner_oid,runtime_oid)
  ) THEN
    RAISE EXCEPTION 'dispatch grant table has an unexpected direct ACL';
  END IF;
  IF NOT has_table_privilege('aichm_app_runtime',
      'public.admissions_conversation_dispatch_grants','SELECT')
     OR NOT has_table_privilege('aichm_app_runtime',
      'public.admissions_conversation_dispatch_grants','INSERT')
     OR NOT has_table_privilege('aichm_app_runtime',
      'public.admissions_conversation_dispatch_grants','UPDATE')
     OR has_table_privilege('aichm_app_runtime',
      'public.admissions_conversation_dispatch_grants','DELETE')
     OR has_table_privilege('aichm_app_runtime',
      'public.admissions_conversation_dispatch_grants','TRUNCATE')
     OR has_table_privilege('aichm_app_runtime',
      'public.admissions_conversation_dispatch_grants','REFERENCES')
     OR has_table_privilege('aichm_app_runtime',
      'public.admissions_conversation_dispatch_grants','TRIGGER')
  THEN
    RAISE EXCEPTION 'dispatch grant runtime privileges are not least privilege';
  END IF;
END
$acl$;

COMMIT;
