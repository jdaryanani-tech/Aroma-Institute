-- Add redacted, allowlisted phone identity diagnostics to Meta lead links.
-- Existing rows remain NULL; this migration never updates application records.
BEGIN;

DO $$
DECLARE
  existing_diagnostic_columns integer;
BEGIN
  IF to_regclass('public.admissions_meta_lead_links') IS NULL THEN
    RAISE EXCEPTION 'Meta lead-link table is required before phone diagnostics';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM aichm_crm_forward_meta.schema_migrations
    WHERE migration_id = '0017_meta_lead_ads_schema'
  ) THEN
    RAISE EXCEPTION 'Meta lead schema migration must be recorded first';
  END IF;
  IF (
    SELECT r.rolname
    FROM pg_class c
    JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid='public.admissions_meta_lead_links'::regclass
  ) <> 'aichm_crm_owner' THEN
    RAISE EXCEPTION 'Meta lead-link owner is not the CRM owner role';
  END IF;
  IF NOT pg_has_role(current_user, 'aichm_crm_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'Migration runner is not a member of the CRM owner role';
  END IF;
  IF NOT has_table_privilege('aichm_app_runtime', 'public.admissions_meta_lead_links', 'SELECT')
     OR NOT has_table_privilege('aichm_app_runtime', 'public.admissions_meta_lead_links', 'INSERT')
     OR has_table_privilege('aichm_app_runtime', 'public.admissions_meta_lead_links', 'UPDATE')
     OR has_table_privilege('aichm_app_runtime', 'public.admissions_meta_lead_links', 'DELETE')
     OR has_table_privilege('aichm_app_runtime', 'public.admissions_meta_lead_links', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Meta lead-link runtime privileges do not match the reviewed matrix';
  END IF;

  SELECT count(*) INTO existing_diagnostic_columns
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name='admissions_meta_lead_links'
    AND column_name=ANY(ARRAY[
      'phone_number_field_state',
      'mobile_phone_field_state',
      'whatsapp_number_field_state',
      'phone_normalization_outcome',
      'phone_selected_field',
      'phone_fallback_attempted',
      'phone_invalid_higher_priority_blocked_fallback'
    ]::text[]);
  IF existing_diagnostic_columns <> 0 OR EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid='public.admissions_meta_lead_links'::regclass
      AND conname='admissions_meta_lead_links_phone_diag_ck'
  ) THEN
    RAISE EXCEPTION 'Phone identity diagnostic schema already exists or is partial';
  END IF;
END
$$;

ALTER TABLE public.admissions_meta_lead_links
  ADD COLUMN phone_number_field_state text,
  ADD COLUMN mobile_phone_field_state text,
  ADD COLUMN whatsapp_number_field_state text,
  ADD COLUMN phone_normalization_outcome text,
  ADD COLUMN phone_selected_field text,
  ADD COLUMN phone_fallback_attempted boolean,
  ADD COLUMN phone_invalid_higher_priority_blocked_fallback boolean,
  ADD CONSTRAINT admissions_meta_lead_links_phone_diag_ck CHECK (
    (
      phone_number_field_state IS NULL
      AND mobile_phone_field_state IS NULL
      AND whatsapp_number_field_state IS NULL
      AND phone_normalization_outcome IS NULL
      AND phone_selected_field IS NULL
      AND phone_fallback_attempted IS NULL
      AND phone_invalid_higher_priority_blocked_fallback IS NULL
    )
    OR
    (
      phone_number_field_state IS NOT NULL
      AND mobile_phone_field_state IS NOT NULL
      AND whatsapp_number_field_state IS NOT NULL
      AND phone_normalization_outcome IS NOT NULL
      AND phone_fallback_attempted IS NOT NULL
      AND phone_invalid_higher_priority_blocked_fallback IS NOT NULL
      AND phone_number_field_state IN ('missing','blank','populated')
      AND mobile_phone_field_state IN ('missing','blank','populated')
      AND whatsapp_number_field_state IN ('missing','blank','populated')
      AND phone_normalization_outcome IN (
        'valid','no_phone_field','phone_fields_blank',
        'invalid_characters','invalid_length','invalid_mobile_prefix'
      )
      AND (phone_selected_field IS NULL OR phone_selected_field IN (
        'phone_number','mobile_phone','whatsapp_number'
      ))
      AND phone_fallback_attempted IS NOT NULL
      AND phone_invalid_higher_priority_blocked_fallback IS NOT NULL
    )
  );

COMMIT;
