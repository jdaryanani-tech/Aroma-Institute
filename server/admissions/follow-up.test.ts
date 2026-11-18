import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import session from "express-session";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, ne, sql } from "drizzle-orm";
import * as core from "@shared/schema";
import * as lms from "@shared/lms-schema";
import * as admissions from "@shared/admissions-schema";
import { admissionsLeads, admissionsLeadContactPreferences as preferences,
  admissionsConversationDispatchGrants as grants, admissionsRegistrationOutbox as outbox,
  admissionsVideoEvents } from "@shared/admissions-schema";
import { VSL_WHATSAPP_CONSENT_TEXT, VSL_WHATSAPP_CONSENT_VERSION } from "@shared/vsl-consent";
import { registerVslLead, saveLinkedCounsellingInquiry } from "./identity";
import { admissionsIntegrationSchemaReady, followUpSchemaReady, readLeadFollowUpByPhone, readLeadFollowUpStatus, recordWhatsAppOptOut } from "./follow-up";
import { registerAdmissionsRoutes } from "./routes";
import { registerFollowUpStatusRoute } from "./follow-up-routes";
import { dispatchVslRegistrationOnce, isTrustedVslWebhookUrl, vslRetryDelayMs } from "./outbox-dispatcher";
import { buildCounsellingWebhookPayload } from "../n8n-counselling";
import { beginAvniDispatchInTransaction, issueAvniDispatchGrantInTransaction } from "./dispatch-grants";

test("registration dispatcher is off by default and blocks native development networking",async()=>{
  assert.deepEqual(await dispatchVslRegistrationOnce(),{state:"disabled"});
  assert.equal((await dispatchVslRegistrationOnce({enabled:true})).state,"disabled");
  assert.ok(isTrustedVslWebhookUrl("https://n8n.aromacafeinstitute.in/webhook/vsl-registration"));
  for(const bad of [
    "http://n8n.aromacafeinstitute.in/webhook/vsl-registration",
    "https://example.invalid/webhook/vsl-registration",
    "https://n8n.aromacafeinstitute.in/webhook/counselling-submission",
    "https://n8n.aromacafeinstitute.in/webhook/aroma-whatsapp",
    "https://n8n.aromacafeinstitute.in/webhook/vsl-registration?token=no",
    " https://n8n.aromacafeinstitute.in/webhook/vsl-registration",
  ]) assert.equal(isTrustedVslWebhookUrl(bad),false);
  assert.equal(vslRetryDelayMs(1),30_000);
  assert.equal(vslRetryDelayMs(3),120_000);
  assert.equal(vslRetryDelayMs(99),86_400_000);
});

const approved=process.env.FOLLOW_UP_TEST_DB_APPROVAL==="SOCKET_ONLY_DISPOSABLE_DATABASE";
const testUrl=process.env.FOLLOW_UP_TEST_DATABASE_URL;
test("Stage 2 isolated SQL/HTTP: consent, opt-outs, outbox, retries, status authentication and compatible questionnaire",{
  skip:!approved||!testUrl ? "Run npm run test:follow-up for the disposable database integration." : false,
},async()=>{
  const u=new URL(testUrl!);
  assert.equal(u.hostname,"localhost");assert.equal(u.pathname,"/follow_up_test");
  assert.ok(u.searchParams.get("host")?.includes("/generated-artifacts/follow-up-db-"));
  const pool=new Pool({connectionString:testUrl});
  const database=drizzle(pool,{schema:{...core,...lms,...admissions}});
  const readConsentEpoch=async(leadId:string)=>{
    const [row]=await database.select({epoch:preferences.consentEpoch}).from(preferences).where(eq(preferences.leadId,leadId));
    return Number(row?.epoch??0);
  };
  const server=createServer();
  let listening=false;
  try {
    // Fresh test DB only: prove the additive migration creates missing tables and repeats safely.
    await pool.query("DROP TABLE IF EXISTS admissions_conversation_dispatch_grants");
    await pool.query("DROP TABLE admissions_registration_outbox, admissions_lead_contact_preferences");
    assert.equal(await followUpSchemaReady(database),false);
    const fallback=await registerVslLead({phone:"9000000099",name:"Synthetic before migration",entryHost:"test.invalid",entryPath:"/vsl"},new Date(),database);
    assert.ok(fallback.id);
    const migration=await readFile("migrations/0008_admissions_follow_up.sql","utf8");
    await pool.query(migration);await pool.query(migration);
    assert.equal(await followUpSchemaReady(database),true);
    const avniMigration=await readFile("migrations/0009_avni_tracking.sql","utf8");
    await pool.query(avniMigration);await pool.query(avniMigration);
    await pool.query(`
      CREATE ROLE aichm_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
      CREATE ROLE aichm_app_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION;
      CREATE ROLE aichm_crm_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
      GRANT aichm_app_runtime TO aichm_app_login;
    `);
    const dispatchMigration=await readFile("migrations/0019_avni_dispatch_grants.sql","utf8");
    await pool.query(dispatchMigration);await pool.query(dispatchMigration);
    const dispatchFenceMigration=await readFile("migrations/0020_avni_dispatch_authorization_fence.sql","utf8");
    await pool.query(dispatchFenceMigration);await pool.query(dispatchFenceMigration);
    const epochCatalog=await pool.query<{data_type:string;is_nullable:string;column_default:string|null}>(`
      SELECT data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admissions_lead_contact_preferences'
        AND column_name='consent_epoch'
    `);
    assert.deepEqual(epochCatalog.rows,[{
      data_type:"bigint",is_nullable:"NO",column_default:"0",
    }]);
    const grantConstraints=await pool.query<{constraint_name:string}>(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema='public' AND table_name='admissions_conversation_dispatch_grants'
      ORDER BY constraint_name
    `);
    assert.ok(grantConstraints.rows.some(row=>row.constraint_name==="admissions_dispatch_grant_state_ck"));
    assert.ok(grantConstraints.rows.some(row=>row.constraint_name==="admissions_dispatch_grant_expiry_ck"));
    const grantPrivileges=await pool.query<{can_select:boolean;can_insert:boolean;can_update:boolean;can_delete:boolean}>(`
      SELECT has_table_privilege('aichm_app_runtime','admissions_conversation_dispatch_grants','SELECT') AS can_select,
        has_table_privilege('aichm_app_runtime','admissions_conversation_dispatch_grants','INSERT') AS can_insert,
        has_table_privilege('aichm_app_runtime','admissions_conversation_dispatch_grants','UPDATE') AS can_update,
        has_table_privilege('aichm_app_runtime','admissions_conversation_dispatch_grants','DELETE') AS can_delete
    `);
    assert.deepEqual(grantPrivileges.rows[0],{can_select:true,can_insert:true,can_update:true,can_delete:false});
    await pool.query("CREATE ROLE aichm_dispatch_broad_test NOLOGIN");
    try {
      await pool.query("GRANT aichm_app_runtime TO aichm_app_login WITH ADMIN OPTION");
      await assert.rejects(
        pool.query(dispatchFenceMigration),
        /application runtime role membership is not least privilege/,
        "runtime membership must not grant admin option",
      );
      await pool.query("REVOKE ADMIN OPTION FOR aichm_app_runtime FROM aichm_app_login");
      await pool.query("GRANT aichm_dispatch_broad_test TO aichm_app_runtime");
      await assert.rejects(
        pool.query(dispatchFenceMigration),
        /application runtime role membership is not least privilege/,
        "unexpected runtime role memberships must abort the draft fence",
      );
      await pool.query("REVOKE aichm_dispatch_broad_test FROM aichm_app_runtime");
      await pool.query("GRANT aichm_dispatch_broad_test TO aichm_app_login");
      await assert.rejects(
        pool.query(dispatchFenceMigration),
        /application runtime role membership is not least privilege/,
        "the app login cannot inherit an unexpected broad role",
      );
      await pool.query("REVOKE aichm_dispatch_broad_test FROM aichm_app_login");
      await pool.query("GRANT SELECT ON admissions_conversation_dispatch_grants TO aichm_dispatch_broad_test");
      await assert.rejects(
        pool.query(dispatchFenceMigration),
        /dispatch grant table has an unexpected direct ACL/,
        "unexpected pre-existing table ACLs must abort the draft fence",
      );
      await pool.query("REVOKE SELECT ON admissions_conversation_dispatch_grants FROM aichm_dispatch_broad_test");
    } finally {
      await pool.query("DROP ROLE IF EXISTS aichm_dispatch_broad_test");
    }
    assert.equal(await admissionsIntegrationSchemaReady(database),true);
    assert.equal((await database.select().from(outbox)).length,0,"no replay/backfill of pre-migration registrations");

    let time=new Date("2026-11-05T10:00:00Z");
    const input={phone:"+91 90000 00001",name:"Synthetic consent test",entryHost:"test.invalid",entryPath:"/vsl"};
    const lead=await registerVslLead(input,time,database);
    let status=(await readLeadFollowUpStatus(lead.id,database))!;
    assert.equal(status.phone,"919000000001");assert.equal(status.consent.whatsappAdmissions.status,"not_provided");
    assert.equal(status.consent.whatsappAdmissions.allowed,false);
    assert.equal(status.consent.whatsappAdmissions.text,VSL_WHATSAPP_CONSENT_TEXT);
    assert.equal(status.consent.whatsappAdmissions.version,VSL_WHATSAPP_CONSENT_VERSION);
    const [event]=await database.select().from(outbox);
    assert.equal(event.leadId,lead.id);
    assert.equal(event.payload.consentToContact,false);
    assert.equal(event.payload.eventId,event.idempotencyKey);
    const snapshot=JSON.stringify(event.payload);
    const inquiryCount=(await database.select().from(core.inquiries)).length;
    const repeats=await Promise.all(Array.from({length:3},()=>registerVslLead({...input,phone:"919000000001",whatsappAdmissionsConsent:true},time,database)));
    assert.ok(repeats.every(r=>r.id===lead.id));
    assert.equal((await database.select().from(outbox)).length,1);
    assert.equal((await database.select().from(core.inquiries)).length,inquiryCount);
    status=(await readLeadFollowUpStatus(lead.id,database))!;
    assert.equal(status.consent.whatsappAdmissions.allowed,true);
    assert.equal(await readConsentEpoch(lead.id),1);
    const grantAt=status.consent.whatsappAdmissions.recordedAt;
    await registerVslLead(input,new Date(time.getTime()+1000),database);
    assert.equal((await readLeadFollowUpStatus(lead.id,database))!.consent.whatsappAdmissions.recordedAt,grantAt);
    const [dispatchActor]=await database.insert(lms.lmsUsers).values({
      phoneE164:"+15550000001",displayName:"Synthetic dispatch admin",isActive:true,
    }).returning({id:lms.lmsUsers.id});
    await database.insert(lms.lmsUserRoles).values({userId:dispatchActor.id,role:"admin"});
    const [admissionsActor]=await database.insert(lms.lmsUsers).values({
      phoneE164:"+15550000002",displayName:"Synthetic assigned admissions",isActive:true,
    }).returning({id:lms.lmsUsers.id});
    await database.insert(lms.lmsUserRoles).values({userId:admissionsActor.id,role:"admissions"});
    const dispatchRequest={
      session:{lmsUserId:dispatchActor.id},
      lmsUser:{id:dispatchActor.id},
    } as never;
    const assignedRequest={
      session:{lmsUserId:admissionsActor.id},
      lmsUser:{id:admissionsActor.id},
    } as never;

    const makeGrantBinding=(attempt:number,canonicalLeadId=lead.id)=>{
      const key=(label:string)=>createHash("sha256").update(`${label}:${attempt}`).digest("hex");
      return {
        canonicalLeadId,
        supabaseThreadId:randomUUID(),supabaseOutboxId:randomUUID(),
        supabaseMessageId:randomUUID(),supabaseAttemptId:randomUUID(),
        messageIdempotencyKey:`message:v1:${key("message")}`,
        controlVersion:3,attemptNumber:attempt,leaseTokenHash:key("lease"),
        payloadHash:key("payload"),
      };
    };
    const firstBinding=makeGrantBinding(1);
    const issued=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:firstBinding,now:time,
    }));
    assert.equal(issued.code,"grant_issued");
    assert.ok(issued.grant);
    const duplicateIssue=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:firstBinding,now:time,
    }));
    assert.equal(duplicateIssue.code,"grant_duplicate");
    assert.equal(duplicateIssue.grant?.id,issued.grant?.id);
    const changedPayload=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,
      binding:{...firstBinding,payloadHash:createHash("sha256").update("changed").digest("hex")},now:time,
    }));
    assert.equal(changedPayload.code,"grant_idempotency_conflict");

    const directConsentLead=await registerVslLead({
      phone:"9000000011",name:"Synthetic direct consent update",entryHost:"test.invalid",entryPath:"/vsl",
      whatsappAdmissionsConsent:true,
    },time,database);
    const directGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(5,directConsentLead.id),
    }));
    assert.equal(directGrant.code,"grant_issued");
    await pool.query(
      "UPDATE admissions_lead_contact_preferences SET consent_epoch=900 WHERE lead_id=$1",
      [directConsentLead.id],
    );
    assert.equal(await readConsentEpoch(directConsentLead.id),1,
      "a direct SQL writer cannot forge or skip the epoch");
    await pool.query(
      "UPDATE admissions_lead_contact_preferences SET consent_status='not_provided' WHERE lead_id=$1",
      [directConsentLead.id],
    );
    assert.equal(await readConsentEpoch(directConsentLead.id),2,
      "the trigger increments the epoch for direct effective-consent changes");
    assert.equal((await database.select().from(grants)
      .where(eq(grants.id,directGrant.grant!.id)))[0].state,"revoked",
    "the same database transaction invalidates unused grants");
    await pool.query(
      "UPDATE admissions_lead_contact_preferences SET consent_status='granted',consent_version='v1' WHERE lead_id=$1",
      [directConsentLead.id],
    );
    assert.equal(await readConsentEpoch(directConsentLead.id),3);
    const renewedGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(5,directConsentLead.id),
    }));
    assert.equal(renewedGrant.code,"grant_issued");
    await pool.query(
      "UPDATE admissions_lead_contact_preferences SET consent_version='v2' WHERE lead_id=$1",
      [directConsentLead.id],
    );
    assert.equal(await readConsentEpoch(directConsentLead.id),4,
      "a changed consent version is a new authorization epoch");
    assert.equal((await database.select().from(grants)
      .where(eq(grants.id,renewedGrant.grant!.id)))[0].state,"revoked");

    const assignmentLead=await registerVslLead({
      phone:"9000000012",name:"Synthetic reassignment fence",entryHost:"test.invalid",entryPath:"/vsl",
      whatsappAdmissionsConsent:true,
    },time,database);
    const beforeAssignment=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(6,assignmentLead.id),
    }));
    assert.equal(beforeAssignment.code,"grant_issued");
    await database.insert(core.admissionsLeadAssignments).values({
      leadId:assignmentLead.id,assigneeUserId:admissionsActor.id,
      assignedBy:dispatchActor.id,updatedAt:new Date(),version:1,
    });
    let supersedeCalled=false;
    const assignmentChanged=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:dispatchRequest,grantId:beforeAssignment.grant!.id,
      beginSupabaseSend:async()=>{supersedeCalled=true;return "begun";},
    }));
    assert.equal(assignmentChanged.code,"dispatch_authorization_changed");
    assert.equal(supersedeCalled,false,"reassignment invalidates a grant before the Supabase fence");

    const staffGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:assignedRequest,binding:makeGrantBinding(7,assignmentLead.id),
    }));
    assert.equal(staffGrant.code,"grant_issued");
    await database.delete(lms.lmsUserRoles).where(eq(lms.lmsUserRoles.userId,admissionsActor.id));
    let roleChangedBeginCalled=false;
    const roleChanged=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:assignedRequest,grantId:staffGrant.grant!.id,
      beginSupabaseSend:async()=>{roleChangedBeginCalled=true;return "begun";},
    }));
    assert.equal(roleChanged.code,"dispatch_actor_unavailable");
    assert.equal(roleChangedBeginCalled,false,"role removal is revalidated at redemption");
    await database.insert(lms.lmsUserRoles).values({userId:admissionsActor.id,role:"admissions"});
    const inactiveGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(2,assignmentLead.id),
    }));
    assert.equal(inactiveGrant.code,"grant_issued");
    await database.update(lms.lmsUsers).set({isActive:false})
      .where(eq(lms.lmsUsers.id,dispatchActor.id));
    let inactiveBeginCalled=false;
    const inactiveRedemption=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:dispatchRequest,grantId:inactiveGrant.grant!.id,
      beginSupabaseSend:async()=>{inactiveBeginCalled=true;return "begun";},
    }));
    assert.equal(inactiveRedemption.code,"dispatch_actor_unavailable");
    assert.equal(inactiveBeginCalled,false,"inactive actors cannot redeem prior grants");
    await database.update(lms.lmsUsers).set({isActive:true})
      .where(eq(lms.lmsUsers.id,dispatchActor.id));

    const expiryLead=await registerVslLead({
      phone:"9000000013",name:"Synthetic expiry lock wait",entryHost:"test.invalid",entryPath:"/vsl",
      whatsappAdmissionsConsent:true,
    },time,database);
    const shortGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(8,expiryLead.id),ttlMs:250,
    }));
    assert.equal(shortGrant.code,"grant_issued");
    const consentLocker=await pool.connect();
    let beginBackendPid=0;
    const beginWasCalled={value:false};
    try {
      await consentLocker.query("BEGIN");
      const blockerPid=(await consentLocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await consentLocker.query(
        "SELECT lead_id FROM admissions_lead_contact_preferences WHERE lead_id=$1 FOR UPDATE",
        [expiryLead.id],
      );
      const waitingBegin=database.transaction(async tx=>{
        const pid=await tx.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);
        beginBackendPid=Number(pid.rows[0].pid);
        return beginAvniDispatchInTransaction({
          tx,request:dispatchRequest,grantId:shortGrant.grant!.id,
          beginSupabaseSend:async()=>{beginWasCalled.value=true;return "begun";},
        });
      });
      let observedConsentLockWait=false;
      for(let attempt=0;attempt<200;attempt++) {
        if(beginBackendPid) {
          const blocked=await pool.query<{blocked:boolean}>(
            "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
            [beginBackendPid,blockerPid],
          );
          if(blocked.rows[0]?.blocked) {
            observedConsentLockWait=true;
            break;
          }
        }
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      assert.ok(beginBackendPid>0);
      assert.equal(observedConsentLockWait,true,"test observed the redemption blocked behind consent lock");
      await new Promise(resolve=>setTimeout(resolve,300));
      await consentLocker.query("COMMIT");
      const expiredAfterWait=await waitingBegin;
      assert.equal(expiredAfterWait.code,"grant_expired");
      assert.equal(beginWasCalled.value,false,"expiry is checked after consent/grant locks");
    } finally {
      await consentLocker.query("ROLLBACK").catch(()=>undefined);
      consentLocker.release();
    }
    const rpcExpiryLead=await registerVslLead({
      phone:"9000000014",name:"Synthetic Supabase lock expiry",entryHost:"test.invalid",entryPath:"/vsl",
      whatsappAdmissionsConsent:true,
    },time,database);
    const rpcExpiryGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(1,rpcExpiryLead.id),ttlMs:250,
    }));
    assert.equal(rpcExpiryGrant.code,"grant_issued");
    const expiredAcrossRpc=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:dispatchRequest,grantId:rpcExpiryGrant.grant!.id,
      beginSupabaseSend:async()=>{
        await new Promise(resolve=>setTimeout(resolve,300));
        return "begun";
      },
    }));
    assert.equal(expiredAcrossRpc.code,"supabase_begin_uncertain");
    assert.equal(expiredAcrossRpc.grant?.state,"unknown",
      "an RPC that may have committed after grant expiry cannot be blindly reused");
    assert.equal(expiredAcrossRpc.providerCallAllowed,false);

    const beginDecision=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:dispatchRequest,grantId:issued.grant!.id,now:time,
      beginSupabaseSend:async()=> "begun",
    }));
    assert.equal(beginDecision.code,"begin_send_started");
    assert.equal(beginDecision.providerCallAllowed,false,"provider permission is opt-in and disabled by default");
    assert.equal((await database.select().from(grants).where(eq(grants.id,issued.grant!.id)))[0].state,"in_flight");

    const pilotBoundaryLead=await registerVslLead({
      phone:"9000000015",name:"Synthetic gated pilot boundary",entryHost:"test.invalid",entryPath:"/vsl",
      whatsappAdmissionsConsent:true,
    },time,database);
    const pilotBoundaryGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(2,pilotBoundaryLead.id),requireAdmin:true,
    }));
    assert.equal(pilotBoundaryGrant.code,"grant_issued");
    const disabledProviderPermission=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:dispatchRequest,grantId:pilotBoundaryGrant.grant!.id,requireAdmin:true,
      beginSupabaseSend:async()=>"begun",
    }));
    assert.equal(disabledProviderPermission.providerCallAllowed,false);

    const explicitProviderPermissionLead=await registerVslLead({
      phone:"9000000016",name:"Synthetic explicitly enabled boundary",entryHost:"test.invalid",entryPath:"/vsl",
      whatsappAdmissionsConsent:true,
    },time,database);
    const explicitProviderPermissionGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:makeGrantBinding(3,explicitProviderPermissionLead.id),requireAdmin:true,
    }));
    assert.equal(explicitProviderPermissionGrant.code,"grant_issued");
    const explicitProviderPermission=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:dispatchRequest,grantId:explicitProviderPermissionGrant.grant!.id,
      requireAdmin:true,allowProviderCallAfterBegin:true,beginSupabaseSend:async()=>"begun",
    }));
    assert.equal(explicitProviderPermission.code,"begin_send_started");
    assert.equal(explicitProviderPermission.providerCallAllowed,true,
      "only a trusted server caller may opt in after a successful begin_send fence");

    const unusedBindings=[makeGrantBinding(2),makeGrantBinding(3)];
    const unused=await Promise.all(unusedBindings.map(binding=>database.transaction(tx=>
      issueAvniDispatchGrantInTransaction(tx,{request:dispatchRequest,binding,now:time}))));
    assert.ok(unused.every(item=>item.code==="grant_issued"));
    await pool.query(`
      CREATE FUNCTION fail_dispatch_grant_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic grant invalidation failure'; END $$;
      CREATE TRIGGER fail_dispatch_grant_revocation BEFORE UPDATE
        ON admissions_conversation_dispatch_grants
        FOR EACH ROW EXECUTE FUNCTION fail_dispatch_grant_revocation();
    `);
    await assert.rejects(recordWhatsAppOptOut(lead.id,"prospect",database,time),/synthetic grant invalidation failure/);
    await pool.query("DROP TRIGGER fail_dispatch_grant_revocation ON admissions_conversation_dispatch_grants");
    await pool.query("DROP FUNCTION fail_dispatch_grant_revocation()");
    assert.equal((await readLeadFollowUpStatus(lead.id,database))!.consent.whatsappAdmissions.allowed,true,
      "consent write rolls back if same-transaction grant invalidation fails");
    assert.equal(await readConsentEpoch(lead.id),1);
    assert.ok((await database.select().from(grants).where(eq(grants.state,"issued"))).length>=2);

    const answers:core.CounsellingAnswers={
      fullName:"Synthetic consent test",ageRange:"18to20",currentActivity:"college",city:"Ahmedabad",
      careerReasons:["practicalSkills"],mainBarrier:"noWorkExperience",situationImpact:"",
      sixToTwelveMonthGoal:"firstCaféJob",coffeeKnowledge:"beginner",stepsTaken:["onlineResearch"],
      biggestConcern:"jobWithoutExperience",desiredStart:"withinOneMonth",handsOnReadiness:"ready",
      timeAvailability:"fullTime",decisionMaker:"self",familyDiscussion:"notDiscussed",
      investmentSituation:"understandProgramFirst",topQuestions:"",counsellorNote:"",
      visitMode:"instituteAhmedabad",preferredDate:"2099-01-10",preferredTime:"10to12",visitCompanion:"alone",
      visitFocus:"",mobileWhatsapp:"9000000001",email:"",counsellingLanguage:"hinglish",parentJoining:"no",consentToContact:true,
    };
    const submission=await saveLinkedCounsellingInquiry({name:input.name,phone:input.phone,
      email:"",programInterest:"test",counsellingAnswers:answers},time,database);
    assert.equal(submission.leadId,lead.id);assert.equal(Object.keys(submission.counsellingAnswers!).length,29);
    status=(await readLeadFollowUpStatus(lead.id,database))!;
    assert.equal(status.questionnaire.status,"completed");assert.equal(status.questionnaire.completedAt,time.toISOString());
    assert.equal(status.consent.counsellingQuestion29.consentToContact,true);
    assert.equal(status.consent.counsellingQuestion29.inquiryId,submission.id);
    const payload=buildCounsellingWebhookPayload(submission as typeof submission & {counsellingAnswers:core.CounsellingAnswers},time);
    assert.equal(payload.lead.id,submission.id);assert.equal(payload.leadId,lead.id);
    assert.equal(payload.submissionId,`counselling-inquiry-${submission.id}`);
    assert.deepEqual(payload.counsellingAnswers,answers);assert.equal(payload.appointmentRequest.confirmed,false);

    await recordWhatsAppOptOut(lead.id,"prospect",database,time);
    await registerVslLead({...input,whatsappAdmissionsConsent:true},new Date(time.getTime()+2000),database);
    status=(await readLeadFollowUpStatus(lead.id,database))!;
    assert.equal(status.consent.whatsappAdmissions.status,"opted_out");
    assert.equal(status.consent.whatsappAdmissions.allowed,false);
    assert.equal(await readConsentEpoch(lead.id),2);
    assert.equal((await database.select().from(grants).where(and(
      eq(grants.leadId,lead.id),eq(grants.state,"issued"),
    ))).length,0);
    assert.ok((await database.select().from(grants).where(and(
      eq(grants.leadId,lead.id),eq(grants.state,"revoked"),
    ))).length>=2);
    assert.equal((await database.select().from(grants).where(and(
      eq(grants.leadId,lead.id),eq(grants.state,"in_flight"),
    ))).length,1,
      "opt-out invalidates unused grants but cannot recall an in-flight begin_send");
    let staleBeginInvoked=false;
    const staleRedemption=await database.transaction(tx=>beginAvniDispatchInTransaction({
      tx,request:dispatchRequest,grantId:unused[0].grant!.id,now:time,
      beginSupabaseSend:async()=>{staleBeginInvoked=true;return "begun";},
    }));
    assert.equal(staleRedemption.providerCallAllowed,false);
    assert.equal(staleBeginInvoked,false,"opt-out before redemption prevents Supabase begin_send");

    const barrierLead=await registerVslLead({
      phone:"9000000008",name:"Synthetic dispatch barrier",entryHost:"test.invalid",entryPath:"/vsl",
      whatsappAdmissionsConsent:true,
    },time,database);
    const barrierBinding=makeGrantBinding(4,barrierLead.id);
    const barrierGrant=await database.transaction(tx=>issueAvniDispatchGrantInTransaction(tx,{
      request:dispatchRequest,binding:barrierBinding,now:time,
    }));
    assert.equal(barrierGrant.code,"grant_issued");
    let beginPid=0;
    let optoutPid=0;
    let beginEntered!:()=>void;
    let releaseBegin!:()=>void;
    const beganAtSupabase=new Promise<void>(resolve=>{beginEntered=resolve;});
    const releaseSupabase=new Promise<void>(resolve=>{releaseBegin=resolve;});
    const beginPromise=database.transaction(async tx=>{
      const pid=await tx.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);
      beginPid=Number(pid.rows[0].pid);
      return beginAvniDispatchInTransaction({
        tx,request:dispatchRequest,grantId:barrierGrant.grant!.id,now:time,
        beginSupabaseSend:async()=>{
          beginEntered();
          await releaseSupabase;
          return "begun";
        },
      });
    });
    await beganAtSupabase;
    const trackedDatabase=new Proxy(database,{
      get(target,property){
        if(property==="transaction") return (callback:Parameters<typeof database.transaction>[0])=>
          database.transaction(async tx=>{
            const pid=await tx.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);
            optoutPid=Number(pid.rows[0].pid);
            return callback(tx);
          });
        const value=Reflect.get(target,property,target);
        return typeof value==="function" ? value.bind(target) : value;
      },
    }) as typeof database;
    const optoutPromise=recordWhatsAppOptOut(barrierLead.id,"prospect",trackedDatabase,time);
    let observedBlock=false;
    for(let attempt=0;attempt<1_000;attempt+=1) {
      if(optoutPid) {
        const blocked=await pool.query<{blocked:boolean}>(
          "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",[optoutPid,beginPid],
        );
        if(blocked.rows[0]?.blocked){observedBlock=true;break;}
      }
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    releaseBegin();
    const barrierBegin=await beginPromise;
    assert.equal(observedBlock,true,"opt-out waits on the consent row held across begin_send");
    assert.equal(barrierBegin.code,"begin_send_started");
    assert.equal(barrierBegin.providerCallAllowed,false);
    assert.equal(await optoutPromise,true);
    assert.equal(await readConsentEpoch(barrierLead.id),2);
    assert.equal((await database.select().from(grants).where(eq(grants.id,barrierGrant.grant!.id)))[0].state,"in_flight");
    assert.equal(status.consent.counsellingQuestion29.consentToContact,true);
    assert.equal(status.consent.counsellingQuestion29.allowed,false);
    assert.equal(status.consent.whatsappAdmissions.optOutSource,"prospect");
    await recordWhatsAppOptOut(lead.id,"admin",database,new Date(time.getTime()+3000));
    assert.equal(await readConsentEpoch(lead.id),2,"repeated opt-out does not increment the effective-consent epoch");
    assert.equal((await readLeadFollowUpStatus(lead.id,database))!.consent.whatsappAdmissions.optOutSource,"prospect");
    assert.equal(JSON.stringify((await database.select().from(outbox))[0].payload),snapshot);
    // Question-29 consent alone is not a WhatsApp admissions opt-in.
    const independent=await saveLinkedCounsellingInquiry({name:"Synthetic questionnaire only",phone:"9000000002",
      email:"",programInterest:"test",counsellingAnswers:{...answers,mobileWhatsapp:"9000000002"}},time,database);
    const independentStatus=(await readLeadFollowUpStatus(independent.leadId!,database))!;
    assert.equal(independentStatus.consent.counsellingQuestion29.allowed,true);
    assert.equal(independentStatus.consent.whatsappAdmissions.allowed,false);

    const app=express();app.use(express.json());
    app.use(session({secret:"synthetic-only-session",resave:false,saveUninitialized:false}));
    registerAdmissionsRoutes(app,database,async()=>100);
    registerFollowUpStatusRoute(app,{database,getSecret:()=>"synthetic-integration-key"});
    server.on("request",app);server.listen(0,"127.0.0.1");listening=true;await once(server,"listening");
    const address=server.address();assert.ok(address && typeof address!=="string");
    const origin=`http://127.0.0.1:${address.port}`;
    const endpoint=`${origin}/api/integrations/n8n/leads/${lead.id}/status`;
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(`${endpoint}?secret=synthetic-integration-key`)).status,401);
    assert.equal((await fetch(endpoint,{headers:{Authorization:"Bearer synthetic-integration-key"}})).status,401);
    const headers={"x-aichm-webhook-secret":"synthetic-integration-key"};
    const before=JSON.stringify((await database.select().from(outbox)));
    const response=await fetch(endpoint,{headers});
    assert.equal(response.status,200);assert.match(response.headers.get("cache-control")!,/no-store/);
    const body=await response.json();
    assert.deepEqual(Object.keys(body).sort(),["consent","leadId","name","phone","questionnaire","registeredAt","video"]);
    assert.equal(body.questionnaire.latestSubmission.answers.fullName,answers.fullName);
    assert.equal(body.video.observedPercent,0);
    assert.equal(JSON.stringify((await database.select().from(outbox))),before);
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/not-a-uuid/status`,{headers})).status,400);
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/${randomUUID()}/status`,{headers})).status,404);
    const missingApp=express();registerFollowUpStatusRoute(missingApp,{database,getSecret:()=>""});
    app.use("/missing",missingApp);
    assert.equal((await fetch(`${origin}/missing/api/integrations/n8n/leads/${lead.id}/status`)).status,503);

    const registration=await fetch(`${origin}/api/vsl/registrations`,{
      method:"POST",headers:{"Content-Type":"application/json",Origin:origin},
      body:JSON.stringify({...input,entryHost:undefined,whatsappAdmissionsConsent:true}),
    });
    assert.equal(registration.status,400,"opt-in requires the presented consent version");
    assert.equal((await fetch(`${origin}/api/vsl/registration-options`)).status,200);
    const post=await fetch(`${origin}/api/vsl/registrations`,{
      method:"POST",headers:{"Content-Type":"application/json",Origin:origin},
      body:JSON.stringify({name:"Synthetic no-consent viewer",phone:"9000000003",entryPath:"/vsl"}),
    });
    assert.equal(post.status,201,"VSL does not require opt-in");
    const registrationLead=(await registerVslLead({
      name:"Synthetic no-consent viewer",phone:"9000000003",entryHost:"test.invalid",entryPath:"/vsl",
    },time,database)).id;
    await database.update(outbox).set({state:"acknowledged"}).where(eq(outbox.leadId,registrationLead));
    const sessionCookie=post.headers.get("set-cookie")!.split(";")[0];
    const sessionPost=(path:string,body:unknown)=>fetch(`${origin}${path}`,{
      method:"POST",headers:{"Content-Type":"application/json",Origin:origin,Cookie:sessionCookie},
      body:JSON.stringify(body),
    });
    const playbackResponse=await sessionPost("/api/vsl/playbacks",{});
    assert.equal(playbackResponse.status,201);
    const {playbackId}=await playbackResponse.json();
    const play={playbackId,sequence:1,type:"play",position:0,duration:100};
    assert.equal((await sessionPost("/api/vsl/events",play)).status,200);
    for(let position=4;position<=100;position+=4) {
      await database.update(core.admissionsPlaybacks).set({lastObservedAt:new Date(Date.now()-4000)})
        .where(eq(core.admissionsPlaybacks.id,playbackId));
      assert.equal((await sessionPost("/api/vsl/events",{...play,sequence:position/4+1,type:"sample",position})).status,200);
    }
    assert.equal((await sessionPost("/api/vsl/events",{...play,sequence:27,type:"ended",position:100})).status,200);
    const persistedMilestones=await database.select().from(admissionsVideoEvents)
      .where(eq(admissionsVideoEvents.leadId,registrationLead));
    assert.deepEqual(persistedMilestones.map(e=>e.event).sort(),["25","50","75","90","completed","started"]);
    const progressOutbox=(await database.select().from(outbox).where(eq(outbox.leadId,registrationLead)))
      .filter(e=>e.eventType==="vsl.progress");
    assert.equal(progressOutbox.length,6);
    const completedPayload=progressOutbox.find(e=>e.payload.milestone==="completed")!.payload;
    assert.equal(completedPayload.observedPercent,100);
    assert.ok(typeof completedPayload.completedAt==="string");

    const lookup=await fetch(`${origin}/api/integrations/n8n/leads/lookup`,{
      method:"POST",headers:{"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key"},
      body:JSON.stringify({phone:"+91 90000 00001"}),
    });
    assert.equal(lookup.status,200);
    const lookupBody=await lookup.json();
    assert.equal(lookupBody.leadId,lead.id);
    assert.equal(lookupBody.questionnaire.latestSubmission.answers.fullName,answers.fullName);
    assert.equal(lookupBody.questionnaire.status,"completed");
    const questionsResponse=await fetch(`${origin}/api/integrations/n8n/counselling/questions`,{
      headers:{"x-aichm-webhook-secret":"synthetic-integration-key"},
    });
    assert.equal(questionsResponse.status,200);
    const questionsBody=await questionsResponse.json();
    assert.equal(questionsBody.questionCount,29);
    assert.deepEqual(questionsBody.questions.map((question:{key:string})=>question.key),Object.keys(core.counsellingAnswersSchema.shape));
    assert.equal((await fetch(`${origin}/api/integrations/n8n/counselling/questions`)).status,401);
    const validSingle=await fetch(`${origin}/api/integrations/n8n/counselling/validate-answer`,{
      method:"POST",headers:{"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key"},
      body:JSON.stringify({questionKey:"ageRange",value:"21to24"}),
    });
    assert.deepEqual(await validSingle.json(),{valid:true,value:"21to24"});
    assert.equal((await fetch(`${origin}/api/integrations/n8n/counselling/validate-answer`,{
      method:"POST",headers:{"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key"},
      body:JSON.stringify({questionKey:"ageRange",value:"not-an-option"}),
    })).status,400);
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/lookup`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({phone:"+91 90000 00001"}),
    })).status,401);
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/lookup`,{
      method:"POST",headers:{"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key"},
      body:JSON.stringify({phone:"not-a-phone"}),
    })).status,400);
    const assistedAnswers={...answers,fullName:"Synthetic AVNI completion",mobileWhatsapp:"9000000007"};
    const assistedLead=await registerVslLead({name:"Synthetic AVNI completion",phone:"9000000007",entryHost:"test.invalid",entryPath:"/vsl"},time,database);
    const assistedUrl=`${origin}/api/integrations/n8n/leads/${assistedLead.id}/counselling`;
    const assistedHeaders={"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key","Idempotency-Key":"avni-test-001"};
    const assistedBody=JSON.stringify({answers:assistedAnswers});
    const assisted=await fetch(assistedUrl,{method:"POST",headers:assistedHeaders,body:assistedBody});
    assert.equal(assisted.status,201);
    const assistedResult=await assisted.json();
    assert.equal(assistedResult.saved,true);
    assert.equal(assistedResult.duplicate,false);
    assert.equal(assistedResult.alreadySubmitted,false);
    const duplicate=await fetch(assistedUrl,{method:"POST",headers:assistedHeaders,body:assistedBody});
    assert.equal(duplicate.status,200);
    const duplicateResult=await duplicate.json();
    assert.equal(duplicateResult.duplicate,true);
    assert.equal(duplicateResult.alreadySubmitted,true);
    assert.equal((await database.select().from(core.inquiries).where(eq(core.inquiries.submissionIdempotencyKey,"avni-test-001"))).length,1);
    assert.equal((await database.select().from(core.inquiries).where(eq(core.inquiries.submissionIdempotencyKey,"avni-test-001")))[0].submissionSource,"avni_whatsapp");
    assert.equal((await fetch(assistedUrl,{method:"POST",headers:assistedHeaders,body:JSON.stringify({answers:{...assistedAnswers,topQuestions:"changed"}})})).status,409);
    const mismatched=await registerVslLead({name:"Mismatch",phone:"9000000008",entryHost:"test.invalid",entryPath:"/vsl"},time,database);
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/${mismatched.id}/counselling`,{
      method:"POST",headers:{...assistedHeaders,"Idempotency-Key":"avni-test-mismatch"},body:assistedBody,
    })).status,409);
    const phoneAssistedAnswers={...answers,mobileWhatsapp:"9000000009"};
    const phoneAssistedBody={phone:"+91 90000 00009",answers:phoneAssistedAnswers};
    const notSubmittedLookup=await fetch(`${origin}/api/integrations/n8n/leads/lookup`,{
      method:"POST",headers:{"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key"},
      body:JSON.stringify({phone:"9000000009"}),
    });
    assert.equal((await notSubmittedLookup.json()).questionnaire.status,"not_submitted");
    const phoneAssisted=await fetch(`${origin}/api/integrations/n8n/counselling/submit`,{
      method:"POST",headers:{...assistedHeaders,"Idempotency-Key":"avni-phone-test-001"},body:JSON.stringify(phoneAssistedBody),
    });
    assert.equal(phoneAssisted.status,201);
    const phoneAssistedResult=await phoneAssisted.json();
    assert.equal(phoneAssistedResult.saved,true);
    assert.equal(phoneAssistedResult.alreadySubmitted,false);
    const phoneAssistedSubmission=(await database.select().from(core.inquiries)
      .where(eq(core.inquiries.submissionIdempotencyKey,"avni-phone-test-001")))[0];
    assert.equal(phoneAssistedSubmission.submissionSource,"avni_whatsapp");
    const phoneLookup=await fetch(`${origin}/api/integrations/n8n/leads/lookup`,{
      method:"POST",headers:{"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key"},
      body:JSON.stringify({phone:"9000000009"}),
    });
    const phoneLookupBody=await phoneLookup.json();
    assert.equal(phoneLookupBody.questionnaire.status,"completed");
    assert.deepEqual(phoneLookupBody.questionnaire.latestSubmission.answers,phoneAssistedAnswers);
    const doNotDuplicate=await fetch(`${origin}/api/integrations/n8n/counselling/submit`,{
      method:"POST",headers:{...assistedHeaders,"Idempotency-Key":"avni-phone-test-002"},body:JSON.stringify(phoneAssistedBody),
    });
    assert.equal(doNotDuplicate.status,200);
    const doNotDuplicateResult=await doNotDuplicate.json();
    assert.equal(doNotDuplicateResult.alreadySubmitted,true);
    assert.equal(doNotDuplicateResult.submissionId,phoneAssistedSubmission.id);
    assert.equal((await database.select().from(core.inquiries)
      .where(eq(core.inquiries.phone,"9000000009"))).length,1);

    // Keep the dispatcher assertion scoped to the registration row under test.
    await database.update(outbox).set({state:"acknowledged"}).where(ne(outbox.id,event.id));
    let requests=0;
    const configuration={url:"https://n8n.aromacafeinstitute.in/webhook/vsl-registration",secret:"  synthetic-integration-key  "};
    const transport:typeof fetch=async(_url,init)=>{
      requests++;
      assert.equal((init!.headers as Record<string,string>)["x-aichm-webhook-secret"],"synthetic-integration-key");
      assert.equal((init!.headers as Record<string,string>)["Authorization"],undefined);
      assert.equal((init!.headers as Record<string,string>)["Idempotency-Key"],event.idempotencyKey);
      assert.equal(init!.redirect,"error");
      const sent=JSON.parse(init!.body as string);
      assert.equal(sent.leadId,lead.id);assert.equal(sent.consentToContact,false,"refresh revoked consent before sending");
      return new Response(JSON.stringify({received:true,eventId:event.idempotencyKey}),{status:requests===1?403:200});
    };
    const dispatch=()=>dispatchVslRegistrationOnce({enabled:true,database,transport,configuration,now:()=>time});
    assert.equal((await dispatch()).state,"failed");assert.equal(requests,1);
    assert.equal((await dispatch()).state,"idle");assert.equal(requests,1);
    let [failed]=await database.select().from(outbox).where(eq(outbox.id,event.id));
    assert.equal(failed.lastHttpStatus,403);assert.equal(failed.attemptCount,1);
    time=failed.availableAt;
    assert.equal((await dispatch()).state,"acknowledged");assert.equal(requests,2);
    assert.equal((await dispatch()).state,"idle");
    assert.equal(JSON.stringify((await database.select().from(outbox).where(eq(outbox.id,event.id)))[0].payload),snapshot);
    // Expired leases can be retried using the same idempotency key, never a new inquiry.
    await database.update(outbox).set({state:"sending",lockedAt:new Date(time.getTime()-120000),lockToken:randomUUID()}).where(eq(outbox.id,event.id));
    const unack=await dispatchVslRegistrationOnce({enabled:true,database,configuration,now:()=>time,
      transport:async()=>new Response(JSON.stringify({received:true,eventId:"wrong"}),{status:200})});
    assert.equal(unack.state,"failed");
    [failed]=await database.select().from(outbox).where(eq(outbox.id,event.id));
    time=failed.availableAt;
    const timeout=await dispatchVslRegistrationOnce({enabled:true,database,configuration,now:()=>time,
      transport:async()=>{throw new DOMException("must not be persisted","TimeoutError");}});
    assert.equal(timeout.state,"failed");assert.equal(timeout.error,"Webhook request timed out.");
    [failed]=await database.select().from(outbox).where(eq(outbox.id,event.id));time=failed.availableAt;
    const invalidJson=await dispatchVslRegistrationOnce({enabled:true,database,configuration,now:()=>time,
      transport:async()=>new Response("not json",{status:200})});
    assert.equal(invalidJson.state,"failed");
    [failed]=await database.select().from(outbox).where(eq(outbox.id,event.id));time=failed.availableAt;
    let release!:()=>void;
    const blocked=dispatchVslRegistrationOnce({enabled:true,database,configuration,now:()=>time,transport:async()=>{
      await new Promise<void>(r=>{release=r;});
      return new Response(JSON.stringify({received:true,eventId:event.idempotencyKey}),{status:200});
    }});
    while(!release) await new Promise(r=>setTimeout(r,5));
    assert.equal((await dispatch()).state,"idle","concurrent dispatch cannot claim active lease");
    release();assert.equal((await blocked).state,"acknowledged");
    await database.update(outbox).set({state:"failed",attemptCount:8,availableAt:time}).where(eq(outbox.id,event.id));
    assert.equal((await dispatch()).state,"idle","retry budget is bounded");
    await database.update(outbox).set({state:"sending",lockedAt:new Date(time.getTime()-120000),lockToken:randomUUID()}).where(eq(outbox.id,event.id));
    assert.equal((await dispatch()).state,"idle","exhausted abandoned lease is not sent again");
    const [exhausted]=await database.select().from(outbox).where(eq(outbox.id,event.id));
    assert.equal(exhausted.state,"failed");assert.equal(exhausted.lockToken,null);
    assert.equal((await database.select().from(admissionsLeads).where(eq(admissionsLeads.id,lead.id))).length,1);
    assert.equal((await database.select().from(outbox).where(eq(outbox.leadId,lead.id))).length,1);
  } finally {
    if(listening) await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await pool.end();
  }
});
