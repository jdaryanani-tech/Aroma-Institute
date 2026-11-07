import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyAvniIntegrationSecret } from "./avni";

test("AVNI secret comparison fails closed and compares authenticated values", () => {
  assert.equal(verifyAvniIntegrationSecret("same-secret", "same-secret"), true);
  assert.equal(verifyAvniIntegrationSecret("wrong", "same-secret"), false);
  assert.equal(verifyAvniIntegrationSecret("", undefined), false);
  assert.equal(verifyAvniIntegrationSecret("x".repeat(1025), "x".repeat(1025)), false);
});

test("Replit migration and importer do not create or write conversation transcripts or course knowledge", () => {
  const migrationPath = fileURLToPath(new URL("../../migrations/0013_replit_operational_reconciliation.sql", import.meta.url));
  const runnerPath = fileURLToPath(new URL("../db/supabase-legacy-import-runner.ts", import.meta.url));
  const routesPath = fileURLToPath(new URL("./avni.ts", import.meta.url));
  const crmReadPath = fileURLToPath(new URL("../crm/read.ts", import.meta.url));
  const supabaseMigrationPath = fileURLToPath(new URL("../../supabase/migrations/20261107_aichm_two_database_contract.sql", import.meta.url));
  const migration = readFileSync(migrationPath, "utf8");
  const runner = readFileSync(runnerPath, "utf8");
  const routes = readFileSync(routesPath, "utf8");
  const crmRead = readFileSync(crmReadPath, "utf8");
  const supabaseMigration = readFileSync(supabaseMigrationPath, "utf8");
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS admissions_conversation_messages/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS lms_course_knowledge/i);
  assert.doesNotMatch(runner, /INSERT INTO admissions_conversation_messages/i);
  assert.doesNotMatch(runner, /INSERT INTO lms_course_knowledge/i);
  assert.doesNotMatch(routes, /admissionsConversationMessages/);
  assert.match(routes, /status\(410\)/);
  assert.doesNotMatch(crmRead, /FROM admissions_conversation_messages/);
  assert.match(crmRead, /readSupabaseConversationPage/);
  assert.match(runner, /conversationsPreservedInSupabase/);
  assert.match(runner, /courseKnowledgePreservedInSupabase/);
  assert.match(supabaseMigration, /ADD COLUMN IF NOT EXISTS replit_lead_id uuid/i);
  assert.match(supabaseMigration, /aichm_private\.aichm_crm_conversations_for_replit_lead/);
  assert.match(supabaseMigration, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM aichm_crm_reader/i);
  assert.match(supabaseMigration, /REVOKE ALL ON SCHEMA aichm_private FROM PUBLIC, anon, authenticated, service_role/i);
});
