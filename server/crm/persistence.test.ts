import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { drizzle } from "drizzle-orm/node-postgres";
import { listCrm, detailCrm } from "./read";
import { updateCrm } from "./write";
import { assignCrmLead } from "./assignment";
import { createAvniFollowUpReadAuth } from "./avni-follow-up-read-auth";
import { registerAvniCrmFollowUpRoutes } from "./avni-follow-up-routes";
import { N8N_INTEGRATION_SECRET_HEADER } from "../integrations/n8n-auth";
import { assertCrmAssignmentSchemaPostconditions } from "../db/crm-forward-migration-postconditions";
import {
  assertCrmMetaLeadAdsPostconditions,
  assertCrmMetaLeadAdsPrerequisites,
  assertCrmMetaLeadAdsSchemaAbsent,
} from "../db/crm-meta-migration-postconditions";
import {
  assertCrmMetaPhoneIdentityDiagnosticsPostconditions,
  assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent,
} from "../db/crm-meta-phone-identity-diagnostics-postconditions";
import { assertCrmRuntimeRoleSeparationPostconditions } from "../db/crm-runtime-role-postconditions";
import {
  verifyApplicationRuntimePool,
} from "../db/application-runtime-connection";
import {
  assertCrmPersistenceTestServerIdentity,
  validateCrmPersistenceTestTarget,
} from "./persistence-test-target";

const adminPrincipal = { id: 1, roles: ["admin"] as const };
const secondAdminPrincipal = { id: 2, roles: ["admin"] as const };
const studentPrincipal = { id: 3, roles: ["student"] as const };
const admissionsPrincipal = { id: 4, roles: ["admissions"] as const };
const secondAdmissionsPrincipal = { id: 6, roles: ["admissions"] as const };

function rewriteMigrationsForScratchSchema(sql: string, namespace: string): string {
  if (namespace === "public") {
    return sql.replaceAll(
      "SET search_path = pg_catalog, public",
      'SET search_path = pg_catalog, "public"',
    );
  }
  const schemaPrefix = `"${namespace}".`;
  return sql
    .replaceAll("table_schema='public'", `table_schema='${namespace}'`)
    .replaceAll("'public.admissions_meta_lead_links'", `'${namespace}.admissions_meta_lead_links'`)
    .replaceAll("public.admissions_lead_assignment_history", `${schemaPrefix}admissions_lead_assignment_history`)
    .replaceAll("public.admissions_lead_assignments", `${schemaPrefix}admissions_lead_assignments`)
    .replaceAll("public.lms_users", `${schemaPrefix}lms_users`)
    .replaceAll("public.lms_user_roles", `${schemaPrefix}lms_user_roles`)
    .replaceAll('"public".', "")
    .replaceAll("public.", "")
    .replaceAll("SET search_path = pg_catalog, public", `SET search_path = pg_catalog, "${namespace}"`);
}

test("isolated CRM SQL: additive repeat migrations, distinct identities, audit, evidence, pagination, guards and degraded schema",
  {
    skip: process.env.CRM_TEST_DB_WRITE_APPROVED !== "ISOLATED_EPHEMERAL_POSTGRES_ONLY"
      || process.env.NODE_ENV !== "test"
      || !process.env.AICHM_DEVELOPMENT_DATABASE_URL
      || !process.env.CRM_TEST_DATABASE_NAME
      || !process.env.CRM_TEST_EPHEMERAL_ROOT
      || !process.env.CRM_TEST_EPHEMERAL_PROOF,
  },
  async()=>{
     const target=await validateCrmPersistenceTestTarget(process.env);
     assert.equal(target.intent,"disposable-test");
     const root=new Pool({connectionString:target.url,max:2});
    const namespace="public";
    let db:Pool|undefined,appDb:Pool|undefined,server:ReturnType<typeof createServer>|undefined;
    try {
       await assertCrmPersistenceTestServerIdentity(root,target.proof);
      db=new Pool({connectionString:target.url,options:`-c search_path=${namespace}`,max:4});
       await db.query(`CREATE TABLE inquiries(
           id integer NOT NULL,name text NOT NULL,email text NOT NULL,phone text NOT NULL,
           program_interest text NOT NULL,message text,counselling_answers jsonb,
           counselling_submitted_at timestamptz,counselling_delivery_status text NOT NULL DEFAULT 'not_applicable',
           counselling_delivery_attempts integer NOT NULL DEFAULT 0,
           counselling_delivery_last_attempt_at timestamptz,counselling_delivery_last_result text,
            counselling_delivery_last_verified_at timestamptz,counselling_delivery_last_verified_by integer,
           submission_source text NOT NULL DEFAULT 'public_form',submission_idempotency_key text,
           submission_payload_hash text,lead_id uuid
         );
         CREATE SEQUENCE inquiry_ids; ALTER TABLE inquiries ALTER COLUMN id SET DEFAULT nextval('inquiry_ids');
        ALTER TABLE inquiries ADD PRIMARY KEY(id);
        ALTER SEQUENCE inquiry_ids OWNED BY inquiries.id;
        CREATE TABLE sessions(sid text PRIMARY KEY,sess jsonb NOT NULL,expire timestamptz NOT NULL);
         CREATE TABLE lms_users(id serial PRIMARY KEY,display_name text,is_active boolean DEFAULT true);
        CREATE TABLE lms_user_roles(user_id integer,role text);
         CREATE TABLE counselling_delivery_attempts(
           id integer PRIMARY KEY,inquiry_id integer,attempt_number integer,attempted_at timestamptz,
           response_at timestamptz,http_status integer,delivery_state text,error_summary text);
         CREATE TABLE lms_audit_logs(id serial PRIMARY KEY,actor_id integer,action text NOT NULL,entity_type text NOT NULL,
           entity_id text,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());
         CREATE TABLE admissions_leads(
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),canonical_phone text NOT NULL UNIQUE,name text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now(),registered_at timestamptz,last_registered_at timestamptz,
           entry_source text,entry_path text,entry_host text,
           questionnaire_status text NOT NULL DEFAULT 'not_submitted',questionnaire_completed_at timestamptz,
           legacy_match_status text NOT NULL DEFAULT 'none',
           CONSTRAINT admissions_leads_indian_phone CHECK (canonical_phone ~ '^91[6-9][0-9]{9}$')
         );
         CREATE TABLE admissions_lead_contact_preferences(
           lead_id uuid PRIMARY KEY REFERENCES admissions_leads(id),
           consent_status text NOT NULL DEFAULT 'not_provided',
           consent_recorded_at timestamptz,consent_source text,consent_text text,consent_version text,
           status_updated_at timestamptz NOT NULL DEFAULT now(),opted_out_at timestamptz,opt_out_source text,
           CONSTRAINT admissions_contact_consent_status
             CHECK (consent_status IN ('not_provided','granted','opted_out'))
         );
         ALTER TABLE inquiries ADD CONSTRAINT inquiries_lead_id_fk FOREIGN KEY(lead_id) REFERENCES admissions_leads(id);
         CREATE TABLE admissions_crm_profiles(
           inquiry_id integer PRIMARY KEY,stage text,stage_evidence jsonb,owner_id integer,follow_up_at timestamptz,
           updated_at timestamptz NOT NULL DEFAULT now(),updated_by integer NOT NULL,version integer NOT NULL DEFAULT 1
         );
         CREATE TABLE admissions_crm_activities(
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),inquiry_id integer NOT NULL,type text NOT NULL,
           occurred_at timestamptz NOT NULL DEFAULT now(),actor_id integer NOT NULL,body text,data jsonb
         );
         CREATE TABLE admissions_vsl_playbacks(
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid NOT NULL,session_hash text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now(),last_observed_at timestamptz,
           last_position double precision,duration double precision,ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
           sequence integer NOT NULL DEFAULT 0
         );
         CREATE TABLE admissions_vsl_events(
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid NOT NULL,event text NOT NULL,
           occurred_at timestamptz NOT NULL DEFAULT now(),position_seconds double precision,duration_seconds double precision,
           UNIQUE(lead_id,event)
         );
         INSERT INTO lms_users(id,display_name) VALUES
           (1,'Test Admin'),(2,'Other Admin'),(3,'Test Student'),(4,'Admissions One'),
           (5,'Inactive Admissions'),(6,'Admissions Two'),(7,'Test Trainer');
         UPDATE lms_users SET is_active=false WHERE id=5;
         INSERT INTO lms_user_roles VALUES
           (1,'admin'),(2,'admin'),(2,'admissions'),(3,'student'),(4,'admissions'),(5,'admissions'),
           (6,'admissions'),(7,'trainer');`);
       const assignments = rewriteMigrationsForScratchSchema(
         await readFile("migrations/0014_crm_canonical_assignments.sql", "utf8"),
         namespace,
       );
       const assignmentGuards = rewriteMigrationsForScratchSchema(
         await readFile("migrations/0015_crm_assignment_audit_invariants.sql", "utf8"),
         namespace,
       );
       const testSearchPath = `SET search_path = pg_catalog, "${namespace}"`;
       assert.ok(assignments.includes(testSearchPath));
       assert.ok(assignmentGuards.includes(testSearchPath));
       assert.doesNotMatch(assignments, /SET search_path = pg_catalog, public/);
       assert.doesNotMatch(assignmentGuards, /SET search_path = pg_catalog, public/);
       assert.ok(assignmentGuards.includes(`FROM public.admissions_lead_assignment_history h`));
      const {rows:[l]}=await db.query("INSERT INTO admissions_leads(canonical_phone,name,registered_at,entry_source) VALUES('919000000011','Linked Person',now(),'vsl_registration') RETURNING id");
      await db.query(assignments);
       await assertCrmAssignmentSchemaPostconditions(db,namespace,"0014",assignments,assignmentGuards);
       await db.query(assignmentGuards);
       await assertCrmAssignmentSchemaPostconditions(db,namespace,"0015",assignments,assignmentGuards);
      const runtimeRoleMigration = rewriteMigrationsForScratchSchema(
        await readFile("migrations/0016_crm_runtime_role_separation.sql", "utf8"),
        namespace,
      );
      await db.query(runtimeRoleMigration);
      await db.query(`
        CREATE ROLE aichm_test_app_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
        GRANT aichm_app_runtime TO aichm_test_app_login;
      `);
      await assertCrmAssignmentSchemaPostconditions(
        db, namespace, "0015", assignments, assignmentGuards,
      );
      await assertCrmRuntimeRoleSeparationPostconditions(db, namespace, runtimeRoleMigration);
       const metaMigration = await readFile("migrations/0017_meta_lead_ads_schema.sql", "utf8");
       await assertCrmMetaLeadAdsPrerequisites(db, namespace);
       await assertCrmMetaLeadAdsSchemaAbsent(db, namespace);
       const baseRowsBeforeMetaMigration = {
         leads: (await db.query(
           "SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) AS rows FROM admissions_leads row_data",
         )).rows[0].rows,
         inquiries: (await db.query(
           "SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) AS rows FROM inquiries row_data",
         )).rows[0].rows,
         ownerCanCreate: (await db.query(
           "SELECT has_schema_privilege('aichm_crm_owner','public','CREATE') AS allowed",
         )).rows[0].allowed,
       };
       await db.query(metaMigration);
       await assertCrmMetaLeadAdsPostconditions(db, namespace);
       await db.query(metaMigration);
       await assertCrmMetaLeadAdsPostconditions(db, namespace);
        await db.query(
          `INSERT INTO admissions_meta_lead_links(meta_lead_id,page_id,state)
           VALUES('pre-diagnostics-meta-link','scratch-page','review')`,
        );
        const metaLinksBeforeDiagnostics = (await db.query(`
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'meta_lead_id',meta_lead_id,'page_id',page_id,'state',state,'error_code',error_code
          ) ORDER BY meta_lead_id),'[]'::jsonb) AS rows FROM admissions_meta_lead_links
        `)).rows[0].rows;
       assert.deepEqual(
         (await db.query(
           "SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) AS rows FROM admissions_leads row_data",
         )).rows[0].rows,
         baseRowsBeforeMetaMigration.leads,
       );
       assert.deepEqual(
         (await db.query(
           "SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) AS rows FROM inquiries row_data",
         )).rows[0].rows,
         baseRowsBeforeMetaMigration.inquiries,
       );
       assert.equal(
         (await db.query(
           "SELECT has_schema_privilege('aichm_crm_owner','public','CREATE') AS allowed",
         )).rows[0].allowed,
         baseRowsBeforeMetaMigration.ownerCanCreate,
       );
        await db.query(`
          CREATE SCHEMA aichm_crm_forward_meta;
          CREATE TABLE aichm_crm_forward_meta.schema_migrations(
            migration_id text PRIMARY KEY,
            sha256 text NOT NULL
          );
          INSERT INTO aichm_crm_forward_meta.schema_migrations(migration_id,sha256)
          VALUES('0017_meta_lead_ads_schema','scratch-checksum');
        `);
        const phoneDiagnosticsMigration = rewriteMigrationsForScratchSchema(
          await readFile("migrations/0018_meta_phone_identity_diagnostics.sql", "utf8"),
          namespace,
        );
        await assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent(db, namespace);
        await db.query(phoneDiagnosticsMigration);
        await assertCrmMetaPhoneIdentityDiagnosticsPostconditions(db, namespace);
        await assertCrmMetaLeadAdsPostconditions(db, namespace);
        assert.deepEqual(
          (await db.query(
            "SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) AS rows FROM admissions_leads row_data",
          )).rows[0].rows,
          baseRowsBeforeMetaMigration.leads,
        );
        assert.deepEqual(
          (await db.query(
            "SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) AS rows FROM inquiries row_data",
          )).rows[0].rows,
          baseRowsBeforeMetaMigration.inquiries,
        );
        assert.deepEqual(
          (await db.query(`
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'meta_lead_id',meta_lead_id,'page_id',page_id,'state',state,'error_code',error_code
            ) ORDER BY meta_lead_id),'[]'::jsonb) AS rows FROM admissions_meta_lead_links
          `)).rows[0].rows,
          metaLinksBeforeDiagnostics,
        );
        const scratchDrizzle = drizzle(db);
        const saveMetaInstantLead = await (async () => {
          process.env.DATABASE_URL = target.url;
          try {
            return (await import("../admissions/identity")).saveMetaInstantLead;
          } finally {
            delete process.env.DATABASE_URL;
          }
        })();
        const metaInput = {
          metaLeadId: "diagnostic-meta-lead",
          pageId: "scratch-page",
          formId: null,
          campaignId: null,
          adId: null,
          adsetId: null,
          leadCreatedAt: null,
          fieldData: [
            { name: "phone_number", values: ["invalid-private-phone-value"] },
            { name: "whatsapp_number", values: ["9000000017"] },
          ],
        };
        const savedMetaLead = await saveMetaInstantLead(metaInput, new Date("2026-11-17T12:00:00Z"), scratchDrizzle);
        assert.equal(savedMetaLead.duplicate, false);
        const storedPhoneDiagnostics = (await db.query(`
          SELECT phone_number_field_state,mobile_phone_field_state,whatsapp_number_field_state,
            phone_normalization_outcome,phone_selected_field,phone_fallback_attempted,
            phone_invalid_higher_priority_blocked_fallback
          FROM admissions_meta_lead_links WHERE meta_lead_id='diagnostic-meta-lead'
        `)).rows[0];
        assert.deepEqual(storedPhoneDiagnostics, {
          phone_number_field_state: "populated",
          mobile_phone_field_state: "missing",
          whatsapp_number_field_state: "populated",
          phone_normalization_outcome: "invalid_characters",
          phone_selected_field: "phone_number",
          phone_fallback_attempted: false,
          phone_invalid_higher_priority_blocked_fallback: true,
        });
        const duplicateMetaLead = await saveMetaInstantLead({
          ...metaInput,
          fieldData: [{ name: "whatsapp_number", values: ["9000000018"] }],
        }, new Date("2026-11-17T12:01:00Z"), scratchDrizzle);
        assert.equal(duplicateMetaLead.duplicate, true);
        assert.deepEqual(
          (await db.query(`
            SELECT phone_number_field_state,mobile_phone_field_state,whatsapp_number_field_state,
              phone_normalization_outcome,phone_selected_field,phone_fallback_attempted,
              phone_invalid_higher_priority_blocked_fallback
            FROM admissions_meta_lead_links WHERE meta_lead_id='diagnostic-meta-lead'
          `)).rows[0],
          storedPhoneDiagnostics,
        );
        await db.query(
          "DELETE FROM admissions_lead_touchpoints WHERE inquiry_id=$1",
          [savedMetaLead.inquiryId],
        );
        await db.query(
          "DELETE FROM admissions_meta_lead_links WHERE meta_lead_id='diagnostic-meta-lead'",
        );
        await db.query("DELETE FROM inquiries WHERE id=$1", [savedMetaLead.inquiryId]);
        await db.query(`
          SELECT setval(
            'inquiry_ids',
            COALESCE((SELECT max(id) FROM inquiries),1),
            EXISTS(SELECT 1 FROM inquiries)
          )
        `);
      const appUrl = new URL(target.url);
      appUrl.username = "aichm_test_app_login";
      appUrl.password = "";
      appDb = new Pool({
        connectionString: appUrl.toString(),
        options: `-c search_path=${namespace}`,
        max: 4,
      });
      const appRuntimeMode = {
        // The launcher has already proved this loopback URL belongs to the
        // fresh ephemeral cluster; the production URL resolver intentionally
        // rejects loopback endpoints.
        kind: "least_privilege" as const,
        connectionString: appUrl.toString(),
        expectedDatabase: new URL(target.url).pathname.slice(1),
      };
      await verifyApplicationRuntimePool(appDb, appRuntimeMode);
      assert.equal((await appDb.query("SELECT current_user")).rows[0].current_user,"aichm_test_app_login");
      assert.equal((await appDb.query("SELECT count(*)::int AS count FROM admissions_lead_assignments")).rows[0].count,0);
      assert.equal((await appDb.query("SELECT count(*)::int AS count FROM admissions_lead_assignment_history")).rows[0].count,0);
       const visitorHash = "a".repeat(64);
       await appDb.query(
         `INSERT INTO admissions_meta_lead_links(meta_lead_id,page_id,state)
          VALUES('isolated-meta-link','isolated-page','review')`,
       );
       assert.equal(
         (await appDb.query(
           "SELECT count(*)::int AS count FROM admissions_meta_lead_links WHERE meta_lead_id='isolated-meta-link'",
         )).rows[0].count,
         1,
       );
       await assert.rejects(
         appDb.query("UPDATE admissions_meta_lead_links SET state='failed' WHERE false"),
         /permission denied/,
       );
       await appDb.query(
         `INSERT INTO admissions_lead_touchpoints(lead_id,source_channel,meta_lead_id)
          VALUES($1,'meta_lead_ads','isolated-meta-lead')`,
         [l.id],
       );
       await appDb.query(
         `INSERT INTO admissions_marketing_consent_events
          (visitor_key_hash,lead_id,consent_status,policy_version,source)
          VALUES($1,$2,'granted','test-policy','isolated-test')`,
         [visitorHash, l.id],
       );
       await appDb.query(
         `UPDATE admissions_marketing_consent_events
          SET consent_status='withdrawn'
          WHERE visitor_key_hash=$1`,
         [visitorHash],
       );
       await appDb.query(
         `INSERT INTO admissions_meta_event_outbox
          (event_id,visitor_key_hash,lead_id,event_name,event_time,event_source_url)
          VALUES('isolated-meta-event',$1,$2,'Lead',now(),'https://example.invalid/')`,
         [visitorHash, l.id],
       );
       await appDb.query(
         `UPDATE admissions_meta_event_outbox SET state='failed'
          WHERE event_id='isolated-meta-event'`,
       );
       for (const table of [
         "admissions_marketing_consent_events",
         "admissions_lead_touchpoints",
         "admissions_meta_lead_links",
         "admissions_meta_event_outbox",
       ]) {
         await assert.rejects(
           appDb.query(`DELETE FROM ${table} WHERE false`),
           /permission denied/,
         );
         await assert.rejects(appDb.query(`TRUNCATE ${table}`), /permission denied/);
       }
       await assert.rejects(
         appDb.query("UPDATE admissions_lead_touchpoints SET source='changed' WHERE false"),
         /permission denied/,
       );
      await assert.rejects(appDb.query("SET ROLE aichm_crm_owner"),/permission denied to set role/);
      await assert.rejects(appDb.query("SET ROLE aichm_crm_migrator"),/permission denied to set role/);
      await assert.rejects(
        appDb.query("UPDATE admissions_lead_assignments SET version=version+1 WHERE false"),
        /permission denied/,
      );
      await assert.rejects(
        appDb.query("INSERT INTO admissions_lead_assignment_history(lead_id,previous_assignee_user_id,new_assignee_user_id,actor_user_id,reason,source,request_id,assignment_version) VALUES(gen_random_uuid(),NULL,NULL,1,'direct mutation','admin_ui',gen_random_uuid(),1)"),
        /permission denied/,
      );
      await assert.rejects(
        appDb.query("UPDATE admissions_lead_assignment_history SET reason='direct mutation' WHERE false"),
        /permission denied/,
      );
      await assert.rejects(
        appDb.query("DELETE FROM admissions_lead_assignment_history WHERE false"),
        /permission denied/,
      );
      await assert.rejects(appDb.query("TRUNCATE admissions_lead_assignment_history"),/permission denied/);
      await db.query(`INSERT INTO inquiries(name,email,phone,program_interest,lead_id,counselling_answers,counselling_submitted_at) VALUES
        ('Linked Person','','9000000011','Barista',$1,NULL,NULL),
        ('Linked Person','synthetic@example.invalid','+91 90000 00011','Barista',$1,'{\"synthetic\":\"preserved\"}',now()),
        ('Ambiguous A','','9000000022','Barista',NULL,NULL,NULL),
        ('Ambiguous B','','919000000022','Barista',NULL,NULL,NULL),
        ('Unique Legacy','','9000000033','Other',NULL,NULL,NULL)`,[l.id]);
      const initial=await listCrm(appDb!,{pageSize:2,page:1,sort:"name"},adminPrincipal);
      assert.equal(initial.total,4);assert.equal(initial.items.length,2);
      assert.equal(initial.overview.identifiedPeople,2);assert.equal(initial.overview.unresolvedRecords,2);
      assert.equal(initial.overview.totalEnquiries,5);
      assert.equal(initial.overview.registeredToFormPercent,100);
      assert.deepEqual(initial.options.assignees.map(item=>item.id).sort(),[4,6]);
      assert.equal((await listCrm(appDb!,{q:"9000000011"},adminPrincipal)).items.length,1);
      assert.equal((await listCrm(appDb!,{q:"+91 90000 00011"},adminPrincipal)).items.length,1);
      assert.equal((await listCrm(appDb!,{q:"%' OR true --"},adminPrincipal)).total,0);
      assert.equal((await listCrm(appDb!,{program:"Other"},adminPrincipal)).total,1);
      const {rows:[otherLead]}=await db.query(
        "INSERT INTO admissions_leads(canonical_phone,name,entry_source) VALUES('919000000044','Other Assigned Person','website') RETURNING id",
      );
      const {rows:[unassignedLead]}=await db.query(
        "INSERT INTO admissions_leads(canonical_phone,name,entry_source) VALUES('919000000055','Unassigned Person','website') RETURNING id",
      );
       await assert.rejects(
         db.query(
           "INSERT INTO admissions_lead_assignments(lead_id,assignee_user_id,assigned_by,version) VALUES($1,4,1,1)",
           [unassignedLead.id],
         ),
         /requires a matching history event/,
       );
      await db.query(`INSERT INTO inquiries(name,email,phone,program_interest,lead_id) VALUES
        ('Other Assigned Person','','9000000044','Other',$1),
        ('Unassigned Person','','9000000055','Other',$2)`,[otherLead.id,unassignedLead.id]);
      const {rows:[otherInquiry]}=await db.query("SELECT id FROM inquiries WHERE lead_id=$1",[otherLead.id]);
      await db.query(
        "INSERT INTO admissions_crm_profiles(inquiry_id,stage,owner_id,updated_by) VALUES($1,'contacted',2,1)",
        [otherInquiry.id],
      );
      const original=await db.query("SELECT to_jsonb(i) data FROM inquiries i ORDER BY id");
      let detail=await detailCrm(appDb!,`lead:${l.id}`,adminPrincipal);
      assert.equal(detail.inquiries.length,2);
      assert.equal(detail.lead.stage,"form_submitted");
      assert.equal((await detailCrm(appDb!,"inquiry:1",adminPrincipal)).lead.id,detail.lead.id);
      await db.query(`INSERT INTO counselling_delivery_attempts VALUES(1,2,1,now(),now(),403,'failed','HTTP 403: request rejected')`);
      const failed=await detailCrm(appDb!,detail.lead.id,adminPrincipal);
      assert.equal(failed.inquiries.find(i=>i.id===2)?.deliveryAttemptHistory[0].httpStatus,403);
      assert.ok(failed.activities.some(a=>a.type==="delivery"&&a.data?.bookingConfirmed===false));
      const requestId=randomUUID();
      const firstAssignment=await assignCrmLead(appDb!,l.id,{
        expectedVersion:0,assigneeUserId:4,reason:"Assign for follow-up",requestId,
      },adminPrincipal);
      assert.equal(firstAssignment.version,1);assert.equal(firstAssignment.replayed,false);
       await assert.rejects(db.query(
         `INSERT INTO admissions_lead_assignment_history(
            lead_id,previous_assignee_user_id,new_assignee_user_id,actor_user_id,
            reason,source,request_id,assignment_version
          ) VALUES($1,NULL,4,3,'Invalid history actor','admin_ui',$2,1)`,
         [l.id,randomUUID()],
       ),/active administrator/);
      const replayed=await assignCrmLead(appDb!,l.id,{
        expectedVersion:0,assigneeUserId:4,reason:"Assign for follow-up",requestId,
      },adminPrincipal);
      assert.equal(replayed.replayed,true);
      await assert.rejects(assignCrmLead(appDb!,l.id,{
        expectedVersion:0,assigneeUserId:6,reason:"Different intent",requestId,
       },adminPrincipal),/request ID was already used/);
       await assert.rejects(
         db.query("UPDATE admissions_lead_assignments SET assignee_user_id=6 WHERE lead_id=$1",[l.id]),
         /version must increase by exactly one/,
       );
       await assert.rejects(
         db.query("UPDATE admissions_lead_assignments SET assignee_user_id=6,version=version+1 WHERE lead_id=$1",[l.id]),
         /requires a matching history event/,
       );
       await db.query("BEGIN");
       await db.query(
         "UPDATE admissions_lead_assignments SET assignee_user_id=6,assigned_by=1,version=version+1 WHERE lead_id=$1",
         [l.id],
       );
       await assert.rejects(db.query(
         `INSERT INTO admissions_lead_assignment_history(
            lead_id,previous_assignee_user_id,new_assignee_user_id,actor_user_id,
            reason,source,request_id,assignment_version
          ) VALUES($1,999,6,1,'Mismatched previous assignee','admin_ui',$2,2)`,
         [l.id,randomUUID()],
       ),/must continue the prior assignment version/);
       await db.query("ROLLBACK");
       await assert.rejects(
         db.query("UPDATE admissions_lead_assignments SET assignee_user_id=6,assigned_by=3,version=version+1 WHERE lead_id=$1",[l.id]),
         /active administrator/,
       );
       await assert.rejects(
         db.query("INSERT INTO admissions_lead_assignments(lead_id,assignee_user_id,assigned_by,version) VALUES($1,2,1,1)",[otherLead.id]),
         /active admissions user/,
       );
       await assert.rejects(
         db.query("DELETE FROM admissions_lead_assignments WHERE lead_id=$1",[l.id]),
         /cannot be deleted/,
       );
       await assert.rejects(
         db.query("TRUNCATE admissions_lead_assignments"),
         /cannot be deleted or truncated/,
       );
      assert.equal((await listCrm(appDb!,{},admissionsPrincipal)).total,1);
      assert.equal((await listCrm(appDb!,{q:"Linked Person"},admissionsPrincipal)).items.length,1);
      await assert.rejects(listCrm(appDb!,{assignee:"6",},admissionsPrincipal),/cannot query another assignee/);
      await assert.rejects(detailCrm(appDb!,"inquiry:5",admissionsPrincipal),/Lead not found/);
      await assert.rejects(detailCrm(appDb!,`lead:${otherLead.id}`,admissionsPrincipal),/Lead not found/);
       await assert.rejects(detailCrm(appDb!,`inquiry:${Number((await db.query(
        "SELECT id FROM inquiries WHERE lead_id=$1",[unassignedLead.id],
      )).rows[0].id)}`,admissionsPrincipal),/Lead not found/);
      const legacyBeforeAssignment=await detailCrm(appDb!,`lead:${otherLead.id}`,adminPrincipal);
      assert.equal(legacyBeforeAssignment.legacyInquiryAssignments[0].ownerId,2);
      assert.equal((await db.query("SELECT count(*)::int count FROM admissions_lead_assignments WHERE lead_id=$1",[otherLead.id])).rows[0].count,0);
      const otherAssignment=await assignCrmLead(appDb!,otherLead.id,{
        expectedVersion:0,assigneeUserId:6,reason:"Assign second case",requestId:randomUUID(),
      },adminPrincipal);
      assert.equal(otherAssignment.version,1);
      assert.equal((await db.query("SELECT owner_id FROM admissions_crm_profiles WHERE inquiry_id=$1",[otherInquiry.id])).rows[0].owner_id,2);
      await assert.rejects(assignCrmLead(appDb!,l.id,{
        expectedVersion:1,assigneeUserId:4,reason:"Admissions cannot assign",requestId:randomUUID(),
      },admissionsPrincipal),/Only administrators/);
      await assert.rejects(assignCrmLead(appDb!,l.id,{
        expectedVersion:1,assigneeUserId:2,reason:"Reject admin as target",requestId:randomUUID(),
       },adminPrincipal),/not authorized/);
      await assert.rejects(assignCrmLead(appDb!,l.id,{
        expectedVersion:1,assigneeUserId:5,reason:"Reject inactive target",requestId:randomUUID(),
       },adminPrincipal),/not authorized/);
      await assert.rejects(assignCrmLead(appDb!,l.id,{
        expectedVersion:0,assigneeUserId:6,reason:"Reject stale assignment",requestId:randomUUID(),
      },adminPrincipal),/assignment changed/);
      const secondReassignment=await assignCrmLead(appDb!,l.id,{
        expectedVersion:1,assigneeUserId:6,reason:"Reassign to second admissions user",requestId:randomUUID(),
      },adminPrincipal);
      assert.equal(secondReassignment.version,2);
       const unassignment=await assignCrmLead(appDb!,l.id,{
         expectedVersion:2,assigneeUserId:null,reason:"Close the assignment",requestId:randomUUID(),
       },adminPrincipal);
       assert.equal(unassignment.version,3);
       assert.equal(unassignment.assigneeUserId,null);
       const reassignmentAfterUnassign=await assignCrmLead(appDb!,l.id,{
         expectedVersion:3,assigneeUserId:6,reason:"Return to admissions queue",requestId:randomUUID(),
       },adminPrincipal);
       assert.equal(reassignmentAfterUnassign.version,4);
      assert.equal((await listCrm(appDb!,{},admissionsPrincipal)).total,0);
      assert.equal((await listCrm(appDb!,{},secondAdmissionsPrincipal)).total,2);
      await assert.rejects(db.query("UPDATE admissions_lead_assignment_history SET reason='tampered' WHERE request_id=$1",[requestId]),/append-only/);
      await assert.rejects(db.query("DELETE FROM admissions_lead_assignment_history WHERE request_id=$1",[requestId]),/append-only/);
      await assert.rejects(db.query("TRUNCATE admissions_lead_assignment_history"),/append-only/);
      assert.ok((await db.query("SELECT count(*)::int count FROM lms_audit_logs WHERE action='crm.authorization.denied'")).rows[0].count>=7);

      detail=await updateCrm(appDb!,detail.lead.id,{expectedVersion:0,stage:"contacted",reason:"Called the prospect",
        followUpAt:"2099-01-01T10:00:00Z",note:"First internal note"},adminPrincipal);
      assert.equal(detail.lead.stage,"contacted");assert.equal(detail.lead.assigneeUserId,6);assert.equal(detail.activities.filter(a=>a.source==="staff").length,3);
      assert.ok(detail.activities.filter(a=>a.source==="staff").every(a=>a.actorId===1 && a.at));
      await assert.rejects(updateCrm(appDb!,detail.lead.id,{expectedVersion:0,note:"stale"},adminPrincipal),/changed since/);
       await assert.rejects(
         updateCrm(appDb!,detail.lead.id,{expectedVersion:1,note:"other assignee's lead"},admissionsPrincipal),
         /Lead not found/,
       );
      assert.equal((await listCrm(appDb!,{stage:"contacted",assignee:"6",followUp:"upcoming"},adminPrincipal)).total,1);
       assert.equal((await listCrm(appDb!,{dateFrom:"2000-01-01",dateTo:"2099-01-01"},adminPrincipal)).total,3);
      await assert.rejects(updateCrm(appDb!,detail.lead.id,{expectedVersion:1,stage:"counselling_booked",reason:"Booking claim"},adminPrincipal),/persisted AICHM Calendar booking/);
      await assert.rejects(updateCrm(appDb!,detail.lead.id,{expectedVersion:1,stage:"vsl_watched",reason:"Claim",evidence:{kind:"tracked_video"}},adminPrincipal));
      await db.query("INSERT INTO admissions_vsl_events(lead_id,event,position_seconds,duration_seconds) VALUES($1,'50',50,100)",[l.id]);
      detail=await updateCrm(appDb!,detail.lead.id,{expectedVersion:1,stage:"vsl_watched",reason:"Playback verified",evidence:{kind:"tracked_video"}},adminPrincipal);
      assert.equal(detail.lead.stage,"vsl_watched");
      detail=await updateCrm(appDb!,detail.lead.id,{expectedVersion:2,stage:"enrolled",reason:"Staff confirmed enrollment",evidence:{kind:"staff_record",confirmed:true,reference:"Checked enrollment in staff records"}},adminPrincipal);
      assert.equal(detail.lead.stage,"enrolled");
      const race=await Promise.allSettled([
        updateCrm(appDb!,detail.lead.id,{expectedVersion:3,note:"Concurrent A"},adminPrincipal),
        updateCrm(appDb!,detail.lead.id,{expectedVersion:3,note:"Concurrent B"},secondAdminPrincipal),
      ]);
      assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
      // Metadata does not freeze automatic verified stages.
      const legacy=await updateCrm(appDb!,"inquiry:5",{expectedVersion:0,note:"Review only"},adminPrincipal);
      assert.equal(legacy.lead.stageSource,"new");
      await db.query(`UPDATE inquiries SET counselling_answers='{"test":"later form"}',counselling_submitted_at=now() WHERE id=5`);
      assert.equal((await detailCrm(appDb!,"inquiry:5",adminPrincipal)).lead.stageSource,"verified_form");
      await db.query("UPDATE inquiries SET counselling_answers=NULL,counselling_submitted_at=NULL WHERE id=5");
      assert.deepEqual((await db.query("SELECT to_jsonb(i) data FROM inquiries i ORDER BY id")).rows,original.rows);

       assert.equal(process.env.DATABASE_URL, undefined, "isolated test child must not inherit DATABASE_URL");
       const registerCrmRoutes = await (async () => {
         // Some application modules initialize their unused default pool during import.
         // If needed, expose only the already-verified scratch URL for that import, then remove it.
         process.env.DATABASE_URL = target.url;
         try {
           return (await import("./routes")).registerCrmRoutes;
         } finally {
           delete process.env.DATABASE_URL;
         }
       })();
       assert.equal(process.env.DATABASE_URL, undefined, "scratch import URL must not remain in the test environment");
      const app=express();app.use(express.json());
       registerCrmRoutes(app,{db:appDb!,connectionPool:appDb!,authenticate:(req,res,next)=>{
        const role=req.header("x-test-role");
        if(!role) {res.status(401).json({message:"Authentication required"});return;}
        const userId=role==="admin"?1:role==="admissions"?6:role==="student"?3:7;
        req.lmsUser={id:userId,phoneE164:"synthetic",displayName:"Test User",roles:[role as "admin"|"admissions"|"student"|"trainer"]};next();
      }});
      server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
      const address=server.address();assert.ok(address && typeof address!=="string");
      const origin=`http://127.0.0.1:${address.port}`;
      for(const path of ["/api/admin/crm/leads",`/api/admin/crm/leads/lead:${l.id}`]) {
        assert.equal((await fetch(origin+path)).status,401);
        assert.equal((await fetch(origin+path,{headers:{"x-test-role":"student"}})).status,403);
        const admin=await fetch(origin+path,{headers:{"x-test-role":"admin"}});
        assert.equal(admin.status,200);assert.match(admin.headers.get("cache-control")!,/no-store/);
         const admissions=await fetch(origin+path,{headers:{"x-test-role":"admissions"}});
         if(path.endsWith("/leads")) {
           assert.equal(admissions.status,200);
           assert.equal((await admissions.json()).total,2);
         } else assert.equal(admissions.status,200);
      }
      assert.equal((await fetch(origin+`/api/admin/crm/leads/lead:${unassignedLead.id}`,{headers:{"x-test-role":"admissions"}})).status,404);
      assert.equal((await fetch(origin+`/api/admin/crm/leads/lead:${otherLead.id}`,{headers:{"x-test-role":"admissions"}})).status,200);
      const historyPath=`/api/admin/crm/leads/lead:${l.id}/conversations?limit=20`;
      assert.equal((await fetch(origin+historyPath)).status,401);
      assert.equal((await fetch(origin+historyPath,{headers:{"x-test-role":"student"}})).status,403);
      assert.equal((await fetch(origin+historyPath,{headers:{"x-test-role":"admissions"}})).status,200);
      const historyResponse=await fetch(origin+historyPath,{headers:{"x-test-role":"admin"}});
      assert.equal(historyResponse.status,200);
      assert.equal((await historyResponse.json()).state,"not_configured");
      const detailResponse=await fetch(origin+`/api/admin/crm/leads/lead:${l.id}`,{headers:{"x-test-role":"admin"}});
      const detailBody=await detailResponse.json();
      assert.equal(detailBody.conversationHistory.state,"not_configured");
      assert.equal(detailBody.conversationHistory.items.length,0);
      const patch=(role?:string,site=origin)=>fetch(origin+`/api/admin/crm/leads/lead:${l.id}`,{
        method:"PATCH",headers:{"Content-Type":"application/json",Origin:site,...(role?{"x-test-role":role}:{})},
        body:JSON.stringify({expectedVersion:4,note:"Test note"}),
      });
      assert.equal((await patch()).status,401);assert.equal((await patch("student")).status,403);
      assert.equal((await patch("admin","https://evil.invalid")).status,403);
      const admissionsNote=await fetch(origin+`/api/admin/crm/leads/lead:${l.id}`,{
        method:"PATCH",headers:{"Content-Type":"application/json",Origin:origin,"x-test-role":"admissions"},
        body:JSON.stringify({expectedVersion:4,note:"Admissions internal follow-up"}),
      });
      assert.equal(admissionsNote.status,200);
      const admissionsOwnerEdit=await fetch(origin+`/api/admin/crm/leads/lead:${l.id}`,{
        method:"PATCH",headers:{"Content-Type":"application/json",Origin:origin,"x-test-role":"admissions"},
        body:JSON.stringify({expectedVersion:5,ownerId:1}),
      });
      assert.equal(admissionsOwnerEdit.status,400);
      const admissionsStageEdit=await fetch(origin+`/api/admin/crm/leads/lead:${l.id}`,{
        method:"PATCH",headers:{"Content-Type":"application/json",Origin:origin,"x-test-role":"admissions"},
        body:JSON.stringify({expectedVersion:5,stage:"enrolled",reason:"Not allowed"}),
      });
      assert.equal(admissionsStageEdit.status,403);
      const assignmentPayload={expectedVersion:0,assigneeUserId:4,reason:"Route assignment test",requestId:randomUUID()};
      const admissionsAssign=await fetch(origin+`/api/admin/crm/leads/${unassignedLead.id}/assignment`,{
        method:"PUT",headers:{"Content-Type":"application/json",Origin:origin,"x-test-role":"admissions"},
        body:JSON.stringify(assignmentPayload),
      });
      assert.equal(admissionsAssign.status,403);
      const adminAssign=await fetch(origin+`/api/admin/crm/leads/${unassignedLead.id}/assignment`,{
        method:"PUT",headers:{"Content-Type":"application/json",Origin:origin,"x-test-role":"admin"},
        body:JSON.stringify(assignmentPayload),
      });
      assert.equal(adminAssign.status,200);
      assert.equal((await fetch(origin+"/api/admin/crm/avni-health",{headers:{"x-test-role":"admissions"}})).status,403);
      assert.equal((await fetch(origin+"/api/admin/crm/avni-health",{headers:{"x-test-role":"admin"}})).status,200);
      assert.equal((await fetch(origin+"/api/admin/crm/leads?pageSize=999",{headers:{"x-test-role":"admin"}})).status,400);
      const assignmentRace=await Promise.allSettled([
        assignCrmLead(appDb!,l.id,{expectedVersion:4,assigneeUserId:4,reason:"Concurrent reassign A",requestId:randomUUID()},adminPrincipal),
        assignCrmLead(appDb!,l.id,{expectedVersion:4,assigneeUserId:null,reason:"Concurrent reassign B",requestId:randomUUID()},adminPrincipal),
      ]);
      assert.equal(assignmentRace.filter(result=>result.status==="fulfilled").length,1);
      assert.equal((await db.query("SELECT version FROM admissions_lead_assignments WHERE lead_id=$1",[l.id])).rows[0].version,5);

       // Exercise the real AVNI due-candidate SQL against only this harness's
       // identity-verified disposable loopback PostgreSQL instance.
       await db.query(`
         INSERT INTO lms_users(id,display_name,is_active) VALUES
           (8,'Synthetic AVNI Assignee',true),(9,'Synthetic Inactive Assignee',true),
           (10,'Synthetic Role-Changing Assignee',true);
         INSERT INTO lms_user_roles(user_id,role) VALUES
           (8,'admissions'),(9,'admissions'),(10,'admissions');
       `);
       type DueFixtureOptions = {
         stage: string | null;
         followUpAt: Date | null;
         consent?: "missing" | "granted" | "not_provided" | "opted_out" | "granted_with_opt_out";
         assignment?: "active" | "inactive" | "wrong_role" | "none" | "null";
         version?: number;
       };
       const dueFixtures = new Map<string, { leadId: string; inquiryId: number; followUpAt: Date | null }>();
       let duePhoneSequence = 0;
       async function addDueFixture(key: string, options: DueFixtureOptions) {
         duePhoneSequence += 1;
         const phone = `91${String(6_000_000_000 + duePhoneSequence)}`;
         const { rows: [lead] } = await db.query(
           "INSERT INTO admissions_leads(canonical_phone,name,entry_source) VALUES($1,$2,'synthetic_test') RETURNING id",
           [phone, `Synthetic AVNI ${key}`],
         );
         const { rows: [inquiry] } = await db.query(
           `INSERT INTO inquiries(name,email,phone,program_interest,lead_id)
            VALUES($1,'',$2,'Synthetic',$3) RETURNING id`,
           [`Synthetic AVNI ${key}`, phone, lead.id],
         );
         await db.query(
           `INSERT INTO admissions_crm_profiles(inquiry_id,stage,follow_up_at,updated_by,version)
            VALUES($1,$2,$3,1,$4)`,
           [inquiry.id, options.stage, options.followUpAt, options.version ?? 1],
         );
         if (options.consent !== "missing") {
           const consent = options.consent ?? "granted";
           await db.query(
             `INSERT INTO admissions_lead_contact_preferences(lead_id,consent_status,opted_out_at)
              VALUES($1,$2,$3)`,
             [
               lead.id,
               consent === "granted_with_opt_out" ? "granted" : consent,
               consent === "opted_out" || consent === "granted_with_opt_out" ? new Date() : null,
             ],
           );
         }
         const assignment = options.assignment ?? "active";
         if (assignment !== "none") {
           const assigneeUserId = assignment === "null" ? 8
             : assignment === "inactive" ? 9
             : assignment === "wrong_role" ? 10
             : 8;
           await assignCrmLead(db, lead.id, {
             expectedVersion: 0,
             assigneeUserId,
             reason: `Synthetic AVNI assignment ${key}`,
             requestId: randomUUID(),
           }, adminPrincipal);
           if (assignment === "null") {
             await assignCrmLead(db, lead.id, {
               expectedVersion: 1,
               assigneeUserId: null,
               reason: `Synthetic AVNI unassignment ${key}`,
               requestId: randomUUID(),
             }, adminPrincipal);
           }
         }
         const fixture = { leadId: lead.id as string, inquiryId: inquiry.id as number, followUpAt: options.followUpAt };
         dueFixtures.set(key, fixture);
         return fixture;
       }

       const dueNow = Date.now();
       const dueAt = (minutesAgo: number) => new Date(dueNow - minutesAgo * 60_000);
       const fixtureSpecs: Array<[string, DueFixtureOptions]> = [
         ["routine_valid", { stage: "contacted", followUpAt: dueAt(20), version: 7 }],
         ["future_follow_up", { stage: "contacted", followUpAt: new Date(dueNow + 24 * 60 * 60_000) }],
         ["null_follow_up", { stage: "contacted", followUpAt: null }],
         ["lost_stage", { stage: "lost", followUpAt: dueAt(19) }],
         ["enrolled_stage", { stage: "enrolled", followUpAt: dueAt(18) }],
         ["null_stage", { stage: null, followUpAt: dueAt(17) }],
         ["missing_consent", { stage: "contacted", followUpAt: dueAt(16), consent: "missing" }],
         ["not_provided_consent", { stage: "contacted", followUpAt: dueAt(15), consent: "not_provided" }],
         ["opted_out_status", { stage: "contacted", followUpAt: dueAt(14), consent: "opted_out" }],
         ["opted_out_timestamp", { stage: "contacted", followUpAt: dueAt(13), consent: "granted_with_opt_out" }],
         ["unassigned_no_row", { stage: "contacted", followUpAt: dueAt(12), assignment: "none" }],
         ["unassigned_null_row", { stage: "contacted", followUpAt: dueAt(11), assignment: "null" }],
         ["inactive_assignee", { stage: "contacted", followUpAt: dueAt(10), assignment: "inactive" }],
         ["wrong_role_assignee", { stage: "contacted", followUpAt: dueAt(9), assignment: "wrong_role" }],
         ["pending_pause_checkin", { stage: "nurture", followUpAt: dueAt(4) }],
         ["delivered_pause_checkin_cleared", { stage: "nurture", followUpAt: null }],
         ["delivered_pause_checkin_stale_due", { stage: "nurture", followUpAt: dueAt(2) }],
         ["delivered_pause_checkin_reengaged", { stage: "nurture", followUpAt: dueAt(3) }],
         ["reengaged_pause_lead", { stage: "nurture", followUpAt: dueAt(1) }],
       ];
       for (const [key, options] of fixtureSpecs) await addDueFixture(key, options);

       // The schema invariant prevents missing or malformed canonical phones
       // from existing as admissions leads; verify both rejection paths here.
       await assert.rejects(
         db.query("INSERT INTO admissions_leads(canonical_phone,name) VALUES(NULL,'Synthetic missing phone')"),
         (error: unknown) => !!error && typeof error === "object" && "code" in error
           && (error as { code?: unknown }).code === "23502",
       );
       await assert.rejects(
         db.query("INSERT INTO admissions_leads(canonical_phone,name) VALUES('not-a-phone','Synthetic invalid phone')"),
         (error: unknown) => !!error && typeof error === "object" && "code" in error
           && (error as { code?: unknown }).code === "23514",
       );
       await db.query("UPDATE lms_users SET is_active=false WHERE id=9");
       await db.query("DELETE FROM lms_user_roles WHERE user_id=10");
       await db.query("INSERT INTO lms_user_roles(user_id,role) VALUES(10,'trainer')");

       const pendingPause = dueFixtures.get("pending_pause_checkin")!;
       const deliveredCleared = dueFixtures.get("delivered_pause_checkin_cleared")!;
       const deliveredStale = dueFixtures.get("delivered_pause_checkin_stale_due")!;
       const deliveredReengaged = dueFixtures.get("delivered_pause_checkin_reengaged")!;
       const reengaged = dueFixtures.get("reengaged_pause_lead")!;
       const pauseAt = new Date(dueNow - 60_000);
       async function addActivity(
         inquiryId: number,
         type: string,
         occurredAt: Date,
         data: Record<string, unknown>,
       ) {
         await db.query(
           `INSERT INTO admissions_crm_activities(inquiry_id,type,occurred_at,actor_id,data)
            VALUES($1,$2,$3,1,$4::jsonb)`,
           [inquiryId, type, occurredAt, JSON.stringify(data)],
         );
       }
       for (const [key, fixture] of [
         ["pending", pendingPause],
         ["delivered-cleared", deliveredCleared],
         ["delivered-stale", deliveredStale],
          ["delivered-reengaged", deliveredReengaged],
         ["reengaged", reengaged],
       ] as const) {
         const pauseEventHash = `synthetic-pause-${key}`;
         await addActivity(fixture.inquiryId, "stage", pauseAt, {
           automationAction: "pause",
           automationEventHash: pauseEventHash,
         });
         if (key === "delivered-cleared" || key === "delivered-stale" || key === "delivered-reengaged") {
           await addActivity(fixture.inquiryId, "followup", new Date(dueNow - 30_000), {
             automationAction: "delivery",
             automationFollowUpKind: "pause_checkin",
             pauseEventHash,
           });
         }
         if (key === "reengaged" || key === "delivered-reengaged") {
           await addActivity(fixture.inquiryId, "followup", new Date(dueNow - 30_000), {
             noteSource: "synthetic_reengagement",
           });
         }
       }

       const readSecret = "isolated-avni-follow-up-read-secret";
       const readAudit: Array<{ outcome: string }> = [];
       const dueApp = express();
       dueApp.use(express.json());
       const candidateReadAuth = createAvniFollowUpReadAuth({
         getSecret: () => readSecret,
         getBroadSecret: () => "distinct-isolated-broad-secret",
         logger: entry => readAudit.push(entry),
       });
       registerAvniCrmFollowUpRoutes(
         dueApp,
         (_req, res) => { res.status(401).json({ code: "write_auth_not_used" }); },
         candidateReadAuth,
         db,
       );
       const dueServer = createServer(dueApp);
       dueServer.listen(0, "127.0.0.1");
       await once(dueServer, "listening");
       const dueAddress = dueServer.address();
       assert.ok(dueAddress && typeof dueAddress !== "string");
       const dueOrigin = `http://127.0.0.1:${dueAddress.port}`;
       async function fetchDue(body: Record<string, unknown>) {
         const response = await fetch(`${dueOrigin}/api/integrations/n8n/crm/follow-ups/due`, {
           method: "POST",
           headers: {
             "content-type": "application/json",
             [N8N_INTEGRATION_SECRET_HEADER]: readSecret,
           },
           body: JSON.stringify(body),
         });
         const result = await response.json() as {
           items: Array<{ candidateRef: string; followUpAt: string; expectedVersion: number; followUpKind: string }>;
           nextCursor: { followUpAt: string; candidateRef: string } | null;
         };
         assert.equal(response.status, 200);
         assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
         return result;
       }
       try {
         const firstPage = await fetchDue({ limit: 2 });
         assert.equal(firstPage.items.length, 2);
         assert.ok(firstPage.nextCursor);
         const secondPage = await fetchDue({ limit: 2, cursor: firstPage.nextCursor });
         assert.equal(secondPage.items.length, 2);
         assert.equal(secondPage.nextCursor, null);
         const returned = [...firstPage.items, ...secondPage.items];
         assert.deepEqual(returned.map(item => item.candidateRef), [
           dueFixtures.get("routine_valid")!.leadId,
           pendingPause.leadId,
           deliveredReengaged.leadId,
           reengaged.leadId,
         ]);
         assert.deepEqual(returned.map(item => item.followUpKind), [
           "routine", "pause_checkin", "routine", "routine",
         ]);
         assert.equal(returned[0].expectedVersion, 7);
         const excludedIds = fixtureSpecs
           .filter(([key]) => ![
             "routine_valid", "pending_pause_checkin",
             "delivered_pause_checkin_reengaged", "reengaged_pause_lead",
           ].includes(key))
           .map(([key]) => dueFixtures.get(key)!.leadId);
         assert.equal(excludedIds.some(id => returned.some(item => item.candidateRef === id)), false);
         assert.equal(returned.some(item => item.candidateRef === deliveredCleared.leadId), false);
         assert.equal(returned.some(item => item.candidateRef === deliveredStale.leadId), false);
         const serialized = JSON.stringify([...firstPage.items, ...secondPage.items, readAudit]);
         assert.equal(serialized.includes("Synthetic AVNI"), false);
         assert.equal(serialized.includes("60000000"), false);
         assert.deepEqual(readAudit.map(entry => entry.outcome), ["success", "success"]);
       } finally {
         await new Promise<void>((resolve, reject) => {
           dueServer.close(error => error ? reject(error) : resolve());
         });
       }

       assert.equal(
         (await db.query(
           "SELECT count(*)::int AS count FROM admissions_leads WHERE canonical_phone IS NULL OR canonical_phone !~ '^91[6-9][0-9]{9}$'",
         )).rows[0].count,
         0,
       );
       const dueFixtureInquiryIds = [...dueFixtures.values()].map(fixture => fixture.inquiryId);
       await db.query("DELETE FROM admissions_crm_activities WHERE inquiry_id=ANY($1::integer[])", [dueFixtureInquiryIds]);
       await db.query("DELETE FROM admissions_crm_profiles WHERE inquiry_id=ANY($1::integer[])", [dueFixtureInquiryIds]);
       await db.query("DELETE FROM inquiries WHERE id=ANY($1::integer[])", [dueFixtureInquiryIds]);
      await db.query("DROP TABLE admissions_crm_profiles,admissions_crm_activities");
      assert.equal((await listCrm(appDb!,{},adminPrincipal)).capabilities.crmPersistence,false);
      await assert.rejects(updateCrm(appDb!,`lead:${l.id}`,{expectedVersion:0,note:"no schema"},adminPrincipal),/migration is pending/);
      await db.query("DROP TABLE admissions_vsl_events,admissions_vsl_playbacks; DROP TABLE admissions_leads CASCADE");
      const degraded=await listCrm(appDb!,{},adminPrincipal);
      assert.equal(degraded.capabilities.identityTracking,false);
      assert.equal(degraded.capabilities.videoTracking,false);
      assert.equal(degraded.overview.totalEnquiries,7);
    } finally {
      if(server) await new Promise<void>(resolve=>server!.close(()=>resolve()));
       const closeResults = await Promise.allSettled([
         ...(appDb ? [appDb.end()] : []),
         ...(db ? [db.end()] : []),
         root.end(),
       ]);
       const closeFailure = closeResults.find(result => result.status === "rejected");
       if (closeFailure?.status === "rejected") throw closeFailure.reason;
    }
  });
