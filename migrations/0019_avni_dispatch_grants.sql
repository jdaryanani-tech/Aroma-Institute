-- Draft only: consent/dispatch protocol support for future AVNI sending.
-- Do not apply to Production or Supabase as part of this source change.
-- Real sends remain disabled; this stores authorization state only.
BEGIN;

ALTER TABLE admissions_lead_contact_preferences
  ADD COLUMN IF NOT EXISTS consent_epoch bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS admissions_conversation_dispatch_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES admissions_leads(id) ON DELETE RESTRICT,
  supabase_thread_id uuid NOT NULL,
  supabase_outbox_id uuid NOT NULL,
  supabase_message_id uuid NOT NULL,
  supabase_attempt_id uuid NOT NULL UNIQUE,
  message_idempotency_key text NOT NULL,
  grant_idempotency_key text NOT NULL UNIQUE,
  consent_epoch bigint NOT NULL,
  control_version bigint NOT NULL,
  attempt_number integer NOT NULL,
  lease_token_hash text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'issued',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  completed_at timestamptz,
  safe_outcome text,
  CONSTRAINT admissions_dispatch_grant_consent_epoch_ck CHECK (consent_epoch>=0),
  CONSTRAINT admissions_dispatch_grant_control_version_ck CHECK (control_version>=0),
  CONSTRAINT admissions_dispatch_grant_attempt_number_ck CHECK (attempt_number BETWEEN 1 AND 8),
  CONSTRAINT admissions_dispatch_grant_lease_hash_ck CHECK (lease_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admissions_dispatch_grant_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT admissions_dispatch_grant_author_ck CHECK (message_idempotency_key ~ '^message:v1:[0-9a-f]{64}$'),
  CONSTRAINT admissions_dispatch_grant_key_ck CHECK (grant_idempotency_key ~ '^dispatch:v1:[0-9a-f]{64}$'),
  CONSTRAINT admissions_dispatch_grant_state_ck CHECK (
    state IN ('issued','in_flight','accepted','failed','unknown','revoked','expired','aborted')
  ),
  CONSTRAINT admissions_dispatch_grant_outcome_ck CHECK (
    safe_outcome IS NULL OR safe_outcome IN (
      'provider_accepted','definite_failure','ambiguous_result','send_denied','authorization_expired'
    )
  ),
  CONSTRAINT admissions_dispatch_grant_expiry_ck CHECK (
    expires_at>created_at AND expires_at<=created_at+interval '60 seconds'
  )
);

CREATE INDEX IF NOT EXISTS admissions_conversation_dispatch_grants_lead_state_idx
  ON admissions_conversation_dispatch_grants(lead_id,state,expires_at);
CREATE INDEX IF NOT EXISTS admissions_conversation_dispatch_grants_expiry_idx
  ON admissions_conversation_dispatch_grants(state,expires_at);

REVOKE ALL ON TABLE admissions_conversation_dispatch_grants FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))
    ) acl
    WHERE c.oid='public.admissions_conversation_dispatch_grants'::regclass
      AND acl.grantee<>c.relowner
  ) THEN
    RAISE EXCEPTION 'new dispatch grant table has an unexpected direct ACL';
  END IF;
END
$acl$;

COMMIT;
