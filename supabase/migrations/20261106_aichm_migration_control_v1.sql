-- AICHM private migration-control objects. Applied before the application
-- schema migration. No public schema objects or data are changed.
CREATE SCHEMA IF NOT EXISTS aichm AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS aichm.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  migration_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS aichm.migration_checkpoints (
  run_id text NOT NULL,
  table_name text NOT NULL,
  batch_number integer NOT NULL CHECK (batch_number > 0),
  last_key jsonb NOT NULL,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  target_checksum text NOT NULL CHECK (target_checksum ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, table_name)
);

CREATE TABLE IF NOT EXISTS aichm.migration_crosswalk (
  source_schema text NOT NULL,
  source_table text NOT NULL,
  source_key jsonb NOT NULL,
  target_schema text NOT NULL,
  target_table text NOT NULL,
  target_key jsonb NOT NULL,
  decision text NOT NULL CHECK (
    decision IN ('create-distinct', 'link-existing-public-lead', 'preserve-custom-auth')
  ),
  target_public_lead_id text,
  reviewer text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  PRIMARY KEY (source_schema, source_table, source_key),
  CHECK (
    decision <> 'link-existing-public-lead'
    OR target_public_lead_id IS NOT NULL
  )
);

ALTER TABLE aichm.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.migration_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.migration_crosswalk ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA aichm FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA aichm FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA aichm FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA aichm FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA aichm
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA aichm
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO aichm.schema_migrations (version, migration_name)
VALUES ('aichm-migration-control-v1', 'private-migration-control-tables-only')
ON CONFLICT (version) DO NOTHING;
