import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PoolClient } from "pg";
import {
  assertCrmMetaLeadAdsPrerequisites,
  assertCrmMetaLeadAdsSchemaAbsent,
  assertCrmMetaLeadAdsPostconditions,
  CRM_META_LEAD_ADS_INDEXES,
  CRM_META_LEAD_ADS_TABLES,
} from "./crm-meta-migration-postconditions";

function fakeClient(rows: unknown[]): Pick<PoolClient, "query"> {
  return {
    query: async () => ({ rows }),
  } as unknown as Pick<PoolClient, "query">;
}

const prerequisiteRows = [
  ["admissions_leads", "id", "uuid"],
  ["admissions_leads", "canonical_phone", "text"],
  ["admissions_leads", "name", "text"],
  ["admissions_leads", "legacy_match_status", "text"],
  ["admissions_leads", "questionnaire_status", "text"],
  ["admissions_leads", "questionnaire_completed_at", "timestamp with time zone"],
  ["inquiries", "id", "integer"],
  ["inquiries", "lead_id", "uuid"],
  ["inquiries", "name", "text"],
  ["inquiries", "email", "text"],
  ["inquiries", "phone", "text"],
  ["inquiries", "program_interest", "text"],
  ["inquiries", "message", "text"],
  ["inquiries", "submission_source", "text"],
  ["inquiries", "counselling_answers", "jsonb"],
  ["inquiries", "counselling_submitted_at", "timestamp with time zone"],
  ["inquiries", "counselling_delivery_status", "text"],
].map(([table_name, column_name, data_type]) => ({ table_name, column_name, data_type }));

test("Meta migration prerequisites require the exact base columns and types", async () => {
  await assertCrmMetaLeadAdsPrerequisites(fakeClient(prerequisiteRows));
  await assert.rejects(
    assertCrmMetaLeadAdsPrerequisites(fakeClient(prerequisiteRows.slice(1))),
    /CRM_META_SCHEMA_BASE_PREREQUISITES_MISSING/,
  );
  await assert.rejects(
    assertCrmMetaLeadAdsPrerequisites(fakeClient(prerequisiteRows), "invalid-schema!"),
    /CRM_META_SCHEMA_SCHEMA_REJECTED/,
  );
});

test("Meta migration refuses any pre-existing relation or function conflict", async () => {
  await assertCrmMetaLeadAdsSchemaAbsent(fakeClient([]));
  await assert.rejects(
    assertCrmMetaLeadAdsSchemaAbsent(fakeClient([{ name: CRM_META_LEAD_ADS_TABLES[0], kind: "r" }])),
    /CRM_META_SCHEMA_UNTRACKED_STATE/,
  );
});

test("Meta postconditions reject an unsafe schema name before querying catalogs", async () => {
  await assert.rejects(
    assertCrmMetaLeadAdsPostconditions(fakeClient([]), "public;drop"),
    /CRM_META_SCHEMA_SCHEMA_REJECTED/,
  );
});

test("Meta migration declares four tables and nine named indexes without changing base rows", async () => {
  const migration = await readFile("migrations/0017_meta_lead_ads_schema.sql", "utf8");
  const tableStatements = migration.match(/CREATE TABLE IF NOT EXISTS public\./gi) ?? [];
  const indexStatements = migration.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/gi) ?? [];
  assert.equal(tableStatements.length, CRM_META_LEAD_ADS_TABLES.length);
  assert.equal(indexStatements.length, CRM_META_LEAD_ADS_INDEXES.length);
  for (const table of CRM_META_LEAD_ADS_TABLES) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, "i"));
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} OWNER TO aichm_crm_owner`, "i"));
  }
  for (const index of CRM_META_LEAD_ADS_INDEXES) {
    assert.match(migration, new RegExp(`INDEX IF NOT EXISTS ${index}\\b`, "i"));
  }
  assert.doesNotMatch(
    migration,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(?:public\.)?(?:admissions_leads|inquiries)\b/i,
  );
  assert.match(migration, /set_config\('aichm\.crm_meta_0017_owner_had_create'/i);
  assert.match(migration, /REVOKE CREATE ON SCHEMA public FROM aichm_crm_owner/i);
});
