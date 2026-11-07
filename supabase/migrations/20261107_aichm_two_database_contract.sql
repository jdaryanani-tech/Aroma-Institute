-- Workspace preparation only. This migration has NOT been applied.
-- Replit admissions_leads.id is the canonical business identity. Supabase
-- public.leads remains the conversation index and stores only that cross-link.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS replit_lead_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS public_leads_replit_lead_id_uq
  ON public.leads (replit_lead_id)
  WHERE replit_lead_id IS NOT NULL;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS message_provider_message_id text,
  ADD COLUMN IF NOT EXISTS message_delivery_state text,
  ADD COLUMN IF NOT EXISTS ai_response_provider_message_id text,
  ADD COLUMN IF NOT EXISTS ai_response_delivery_state text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_message_delivery_state_ck'
    AND conrelid = 'public.conversations'::regclass) THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_message_delivery_state_ck
      CHECK (message_delivery_state IS NULL OR message_delivery_state IN ('received','pending','sent','failed','unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_delivery_state_ck'
    AND conrelid = 'public.conversations'::regclass) THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_ai_delivery_state_ck
      CHECK (ai_response_delivery_state IS NULL OR ai_response_delivery_state IN ('received','pending','sent','failed','unknown'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS public_conversations_provider_message_id_uq
  ON public.conversations (message_provider_message_id)
  WHERE message_provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS public_conversations_ai_provider_message_id_uq
  ON public.conversations (ai_response_provider_message_id)
  WHERE ai_response_provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.conversation_memory (
  replit_lead_id uuid PRIMARY KEY,
  supabase_lead_id uuid NOT NULL UNIQUE REFERENCES public.leads(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  memory jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_memory_object_ck CHECK (jsonb_typeof(memory) = 'object')
);

CREATE TABLE IF NOT EXISTS public.ai_interaction_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replit_lead_id uuid NOT NULL,
  supabase_lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  request_id text,
  model_name text,
  interaction_type text NOT NULL,
  input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_interaction_logs_type_ck CHECK (length(interaction_type) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS ai_interaction_logs_lead_time_idx
  ON public.ai_interaction_logs (replit_lead_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ai_interaction_logs_request_id_uq
  ON public.ai_interaction_logs (request_id)
  WHERE request_id IS NOT NULL;

ALTER TABLE public.conversation_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_interaction_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.conversation_memory, public.ai_interaction_logs
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.conversation_memory, public.ai_interaction_logs
  TO service_role;

-- This dedicated role can execute two bounded server-side readers only. It
-- receives no direct SELECT/INSERT/UPDATE/DELETE privilege on public tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aichm_crm_reader') THEN
    CREATE ROLE aichm_crm_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE aichm_crm_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO aichm_crm_reader;
CREATE SCHEMA IF NOT EXISTS aichm_private;
-- Keep this schema out of the Supabase project's PostgREST exposed-schema list.
REVOKE ALL ON SCHEMA aichm_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA aichm_private TO aichm_crm_reader, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM aichm_crm_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM aichm_crm_reader;
ALTER ROLE aichm_crm_reader SET default_transaction_read_only = on;
ALTER ROLE aichm_crm_reader SET search_path = pg_catalog;

CREATE OR REPLACE FUNCTION aichm_private.aichm_crm_conversations_for_replit_lead(
  p_replit_lead_id uuid,
  p_before_at timestamptz DEFAULT NULL,
  p_before_conversation_id uuid DEFAULT NULL,
  p_before_side text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  source_conversation_id uuid,
  message_side text,
  direction text,
  message_type text,
  body text,
  delivery_state text,
  provider_message_id text,
  occurred_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH mapped AS (
    SELECT l.id
    FROM public.leads AS l
    WHERE l.replit_lead_id = p_replit_lead_id
  ),
  entries AS (
    SELECT c.id, 'message'::text AS side,
      CASE WHEN lower(coalesce(c.direction, '')) IN ('inbound','incoming','user')
        THEN 'inbound' WHEN lower(coalesce(c.direction, '')) IN ('outbound','outgoing','assistant')
        THEN 'outbound' ELSE 'unknown' END AS message_direction,
      coalesce(c.message_type, 'text') AS entry_type,
      c.message AS entry_body, c.message_delivery_state AS entry_delivery_state,
      c.message_provider_message_id AS entry_provider_message_id, c.created_at AS entry_at
    FROM public.conversations AS c
    JOIN mapped AS m ON m.id = c.lead_id
    WHERE nullif(btrim(c.message), '') IS NOT NULL
    UNION ALL
    SELECT c.id, 'ai_response'::text,
      'outbound'::text, coalesce(c.message_type, 'text'),
      c.ai_response, c.ai_response_delivery_state,
      c.ai_response_provider_message_id, c.created_at
    FROM public.conversations AS c
    JOIN mapped AS m ON m.id = c.lead_id
    WHERE nullif(btrim(c.ai_response), '') IS NOT NULL
  )
  SELECT e.id, e.side, e.message_direction, e.entry_type, e.entry_body,
    e.entry_delivery_state, e.entry_provider_message_id, e.entry_at
  FROM entries AS e
  WHERE p_before_at IS NULL
    OR (e.entry_at, e.id, e.side) < (p_before_at, p_before_conversation_id, p_before_side)
  ORDER BY e.entry_at DESC, e.id DESC, e.side DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100);
$function$;

CREATE OR REPLACE FUNCTION aichm_private.aichm_crm_verify_confirmation(
  p_replit_lead_id uuid,
  p_conversation_id uuid,
  p_expected_type text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.leads AS l
    JOIN public.conversations AS c ON c.lead_id = l.id
    WHERE l.replit_lead_id = p_replit_lead_id
      AND c.id = p_conversation_id
      AND lower(coalesce(c.direction, '')) IN ('inbound','incoming','user')
      AND c.message_type = p_expected_type
      AND nullif(btrim(c.message), '') IS NOT NULL
  );
$function$;

REVOKE ALL ON FUNCTION aichm_private.aichm_crm_conversations_for_replit_lead(uuid,timestamptz,uuid,text,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION aichm_private.aichm_crm_verify_confirmation(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION aichm_private.aichm_crm_conversations_for_replit_lead(uuid,timestamptz,uuid,text,integer)
  TO aichm_crm_reader, service_role;
GRANT EXECUTE ON FUNCTION aichm_private.aichm_crm_verify_confirmation(uuid,uuid,text)
  TO aichm_crm_reader, service_role;
