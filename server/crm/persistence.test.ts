import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { listCrm, detailCrm } from "./read";
import { updateCrm } from "./write";
import { assignCrmLead } from "./assignment";
import { validateCrmPersistenceTestTarget } from "./persistence-test-target";

const adminPrincipal = { id: 1, roles: ["admin"] as const };
const secondAdminPrincipal = { id: 2, roles: ["admin"] as const };
const studentPrincipal = { id: 3, roles: ["student"] as const };
const admissionsPrincipal = { id: 4, roles: ["admissions"] as const };
const secondAdmissionsPrincipal = { id: 6, roles: ["admissions"] as const };

test("isolated CRM SQL: additive repeat migrations, distinct identities, audit, evidence, pagination, guards and degraded schema",
  {
    skip: process.env.CRM_TEST_DB_WRITE_APPROVED !== "TEMPORARY_DEVELOPMENT_SCHEMA_ONLY"
      || process.env.NODE_ENV !== "test"
      || !process.env.AICHM_DEVELOPMENT_DATABASE_URL
      || !process.env.CRM_TEST_DATABASE_NAME,
  },
  async()=>{
     const target=validateCrmPersistenceTestTarget(process.env);
     assert.equal(target.intent,"disposable-test");
     const root=new Pool({connectionString:target.url,max:2});
    const namespace=`crm_test_${randomUUID().replaceAll("-","")}`;
    assert.match(namespace,/^crm_test_[a-f0-9]+$/);
    let db:Pool|undefined,server:ReturnType<typeof createServer>|undefined;
    try {
      await root.query(`CREATE SCHEMA "${namespace}"`);
      db=new Pool({connectionString:target.url,options:`-c search_path=${namespace}`,max:4});
      await db.query(`CREATE TABLE inquiries(LIKE public.inquiries INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
        CREATE SEQUENCE inquiry_ids; ALTER TABLE inquiries ALTER COLUMN id SET DEFAULT nextval('inquiry_ids');
        ALTER TABLE inquiries ADD PRIMARY KEY(id);
         CREATE TABLE lms_users(id serial PRIMARY KEY,display_name text,is_active boolean DEFAULT true);
        CREATE TABLE lms_user_roles(user_id integer,role text);
         CREATE TABLE lms_audit_logs(id serial PRIMARY KEY,actor_id integer,action text NOT NULL,entity_type text NOT NULL,
           entity_id text,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());
         INSERT INTO lms_users(id,display_name) VALUES
           (1,'Test Admin'),(2,'Other Admin'),(3,'Test Student'),(4,'Admissions One'),
           (5,'Inactive Admissions'),(6,'Admissions Two'),(7,'Test Trainer');
         UPDATE lms_users SET is_active=false WHERE id=5;
         INSERT INTO lms_user_roles VALUES
           (1,'admin'),(2,'admin'),(2,'admissions'),(3,'student'),(4,'admissions'),(5,'admissions'),
           (6,'admissions'),(7,'trainer');`);
      const stage1=(await readFile("migrations/0006_admissions_stage_one.sql","utf8")).replaceAll('"public".',"");
      const crm=(await readFile("migrations/0007_admissions_crm.sql","utf8")).replaceAll('"public".',"");
      const assignments=(await readFile("migrations/0014_crm_canonical_assignments.sql","utf8"))
        .replaceAll('"public".',"").replaceAll("public.","")
        .replace("SET search_path = pg_catalog, public",`SET search_path = pg_catalog, "${namespace}"`);
       const assignmentGuards=(await readFile("migrations/0015_crm_assignment_audit_invariants.sql","utf8"))
         .replaceAll('"public".',"").replaceAll("public.","")
         .replace("SET search_path = pg_catalog, public",`SET search_path = pg_catalog, "${namespace}"`);
      for(let i=0;i<2;i++) {await db.query(stage1);await db.query(crm);}
      await db.query(`CREATE TABLE counselling_delivery_attempts(
        id integer PRIMARY KEY,inquiry_id integer,attempt_number integer,attempted_at timestamptz,
        response_at timestamptz,http_status integer,delivery_state text,error_summary text)`);
      const {rows:[l]}=await db.query("INSERT INTO admissions_leads(canonical_phone,name,registered_at,entry_source) VALUES('919000000011','Linked Person',now(),'vsl_registration') RETURNING id");
      await db.query(assignments);
       await db.query(assignmentGuards);
      await db.query(`INSERT INTO inquiries(name,email,phone,program_interest,lead_id,counselling_answers,counselling_submitted_at) VALUES
        ('Linked Person','','9000000011','Barista',$1,NULL,NULL),
        ('Linked Person','synthetic@example.invalid','+91 90000 00011','Barista',$1,'{\"synthetic\":\"preserved\"}',now()),
        ('Ambiguous A','','9000000022','Barista',NULL,NULL,NULL),
        ('Ambiguous B','','919000000022','Barista',NULL,NULL,NULL),
        ('Unique Legacy','','9000000033','Other',NULL,NULL,NULL)`,[l.id]);
      const initial=await listCrm(db,{pageSize:2,page:1,sort:"name"},adminPrincipal);
      assert.equal(initial.total,4);assert.equal(initial.items.length,2);
      assert.equal(initial.overview.identifiedPeople,2);assert.equal(initial.overview.unresolvedRecords,2);
      assert.equal(initial.overview.totalEnquiries,5);
      assert.equal(initial.overview.registeredToFormPercent,100);
      assert.deepEqual(initial.options.assignees.map(item=>item.id).sort(),[4,6]);
      assert.equal((await listCrm(db,{q:"9000000011"},adminPrincipal)).items.length,1);
      assert.equal((await listCrm(db,{q:"+91 90000 00011"},adminPrincipal)).items.length,1);
      assert.equal((await listCrm(db,{q:"%' OR true --"},adminPrincipal)).total,0);
      assert.equal((await listCrm(db,{program:"Other"},adminPrincipal)).total,1);
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
      let detail=await detailCrm(db,`lead:${l.id}`,adminPrincipal);
      assert.equal(detail.inquiries.length,2);
      assert.equal(detail.lead.stage,"form_submitted");
      assert.equal((await detailCrm(db,"inquiry:1",adminPrincipal)).lead.id,detail.lead.id);
      await db.query(`INSERT INTO counselling_delivery_attempts VALUES(1,2,1,now(),now(),403,'failed','HTTP 403: request rejected')`);
      const failed=await detailCrm(db,detail.lead.id,adminPrincipal);
      assert.equal(failed.inquiries.find(i=>i.id===2)?.deliveryAttemptHistory[0].httpStatus,403);
      assert.ok(failed.activities.some(a=>a.type==="delivery"&&a.data?.bookingConfirmed===false));
      const requestId=randomUUID();
      const firstAssignment=await assignCrmLead(db,l.id,{
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
      const replayed=await assignCrmLead(db,l.id,{
        expectedVersion:0,assigneeUserId:4,reason:"Assign for follow-up",requestId,
      },adminPrincipal);
      assert.equal(replayed.replayed,true);
      await assert.rejects(assignCrmLead(db,l.id,{
        expectedVersion:0,assigneeUserId:6,reason:"Different intent",requestId,
      },adminPrincipal),/already used for a different assignment/);
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
      assert.equal((await listCrm(db,{},admissionsPrincipal)).total,1);
      assert.equal((await listCrm(db,{q:"Linked Person"},admissionsPrincipal)).items.length,1);
      await assert.rejects(listCrm(db,{assignee:"6"},admissionsPrincipal),/cannot query another assignee/);
      await assert.rejects(detailCrm(db,"inquiry:5",admissionsPrincipal),/Lead not found/);
      await assert.rejects(detailCrm(db,`lead:${otherLead.id}`,admissionsPrincipal),/Lead not found/);
      await assert.rejects(detailCrm(db,`inquiry:${Number((await db.query(
        "SELECT id FROM inquiries WHERE lead_id=$1",[unassignedLead.id],
      )).rows[0].id)}`,admissionsPrincipal),/Lead not found/);
      const legacyBeforeAssignment=await detailCrm(db,`lead:${otherLead.id}`,adminPrincipal);
      assert.equal(legacyBeforeAssignment.legacyInquiryAssignments[0].ownerId,2);
      assert.equal((await db.query("SELECT count(*)::int count FROM admissions_lead_assignments WHERE lead_id=$1",[otherLead.id])).rows[0].count,0);
      const otherAssignment=await assignCrmLead(db,otherLead.id,{
        expectedVersion:0,assigneeUserId:6,reason:"Assign second case",requestId:randomUUID(),
      },adminPrincipal);
      assert.equal(otherAssignment.version,1);
      assert.equal((await db.query("SELECT owner_id FROM admissions_crm_profiles WHERE inquiry_id=$1",[otherInquiry.id])).rows[0].owner_id,2);
      await assert.rejects(assignCrmLead(db,l.id,{
        expectedVersion:1,assigneeUserId:4,reason:"Admissions cannot assign",requestId:randomUUID(),
      },admissionsPrincipal),/Only administrators/);
      await assert.rejects(assignCrmLead(db,l.id,{
        expectedVersion:1,assigneeUserId:2,reason:"Reject admin as target",requestId:randomUUID(),
      },adminPrincipal),/active admissions user/);
      await assert.rejects(assignCrmLead(db,l.id,{
        expectedVersion:1,assigneeUserId:5,reason:"Reject inactive target",requestId:randomUUID(),
      },adminPrincipal),/active admissions user/);
      await assert.rejects(assignCrmLead(db,l.id,{
        expectedVersion:0,assigneeUserId:6,reason:"Reject stale assignment",requestId:randomUUID(),
      },adminPrincipal),/assignment changed/);
      const secondReassignment=await assignCrmLead(db,l.id,{
        expectedVersion:1,assigneeUserId:6,reason:"Reassign to second admissions user",requestId:randomUUID(),
      },adminPrincipal);
      assert.equal(secondReassignment.version,2);
       const unassignment=await assignCrmLead(db,l.id,{
         expectedVersion:2,assigneeUserId:null,reason:"Close the assignment",requestId:randomUUID(),
       },adminPrincipal);
       assert.equal(unassignment.version,3);
       assert.equal(unassignment.assigneeUserId,null);
       const reassignmentAfterUnassign=await assignCrmLead(db,l.id,{
         expectedVersion:3,assigneeUserId:6,reason:"Return to admissions queue",requestId:randomUUID(),
       },adminPrincipal);
       assert.equal(reassignmentAfterUnassign.version,4);
      assert.equal((await listCrm(db,{},admissionsPrincipal)).total,0);
      assert.equal((await listCrm(db,{},secondAdmissionsPrincipal)).total,2);
      await assert.rejects(db.query("UPDATE admissions_lead_assignment_history SET reason='tampered' WHERE request_id=$1",[requestId]),/append-only/);
      await assert.rejects(db.query("DELETE FROM admissions_lead_assignment_history WHERE request_id=$1",[requestId]),/append-only/);
      await assert.rejects(db.query("TRUNCATE admissions_lead_assignment_history"),/append-only/);
      assert.ok((await db.query("SELECT count(*)::int count FROM lms_audit_logs WHERE action='crm.authorization.denied'")).rows[0].count>=7);

      detail=await updateCrm(db,detail.lead.id,{expectedVersion:0,stage:"contacted",reason:"Called the prospect",
        followUpAt:"2099-01-01T10:00:00Z",note:"First internal note"},adminPrincipal);
      assert.equal(detail.lead.stage,"contacted");assert.equal(detail.lead.assigneeUserId,6);assert.equal(detail.activities.filter(a=>a.source==="staff").length,3);
      assert.ok(detail.activities.filter(a=>a.source==="staff").every(a=>a.actorId===1 && a.at));
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:0,note:"stale"},adminPrincipal),/changed since/);
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:1,note:"restricted stage"},admissionsPrincipal),/Admissions users cannot change/);
      assert.equal((await listCrm(db,{stage:"contacted",assignee:"6",followUp:"upcoming"},adminPrincipal)).total,1);
      assert.equal((await listCrm(db,{dateFrom:"2000-01-01",dateTo:"2099-01-01"},adminPrincipal)).total,1);
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:1,stage:"counselling_booked",reason:"Booking claim"},adminPrincipal),/persisted AICHM Calendar booking/);
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:1,stage:"vsl_watched",reason:"Claim",evidence:{kind:"tracked_video"}},adminPrincipal));
      await db.query("INSERT INTO admissions_vsl_events(lead_id,event,position_seconds,duration_seconds) VALUES($1,'50',50,100)",[l.id]);
      detail=await updateCrm(db,detail.lead.id,{expectedVersion:1,stage:"vsl_watched",reason:"Playback verified",evidence:{kind:"tracked_video"}},adminPrincipal);
      assert.equal(detail.lead.stage,"vsl_watched");
      detail=await updateCrm(db,detail.lead.id,{expectedVersion:2,stage:"enrolled",reason:"Staff confirmed enrollment",evidence:{kind:"staff_record",confirmed:true,reference:"Checked enrollment in staff records"}},adminPrincipal);
      assert.equal(detail.lead.stage,"enrolled");
      const race=await Promise.allSettled([
        updateCrm(db,detail.lead.id,{expectedVersion:3,note:"Concurrent A"},adminPrincipal),
        updateCrm(db,detail.lead.id,{expectedVersion:3,note:"Concurrent B"},secondAdminPrincipal),
      ]);
      assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
      // Metadata does not freeze automatic verified stages.
      const legacy=await updateCrm(db,"inquiry:5",{expectedVersion:0,note:"Review only"},adminPrincipal);
      assert.equal(legacy.lead.stageSource,"new");
      await db.query(`UPDATE inquiries SET counselling_answers='{"test":"later form"}',counselling_submitted_at=now() WHERE id=5`);
      assert.equal((await detailCrm(db,"inquiry:5",adminPrincipal)).lead.stageSource,"verified_form");
      await db.query("UPDATE inquiries SET counselling_answers=NULL,counselling_submitted_at=NULL WHERE id=5");
      assert.deepEqual((await db.query("SELECT to_jsonb(i) data FROM inquiries i ORDER BY id")).rows,original.rows);

      const {registerCrmRoutes}=await import("./routes");
      const app=express();app.use(express.json());
      registerCrmRoutes(app,{db,connectionPool:db,authenticate:(req,res,next)=>{
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
        assignCrmLead(db,l.id,{expectedVersion:4,assigneeUserId:4,reason:"Concurrent reassign A",requestId:randomUUID()},adminPrincipal),
        assignCrmLead(db,l.id,{expectedVersion:4,assigneeUserId:null,reason:"Concurrent reassign B",requestId:randomUUID()},adminPrincipal),
      ]);
      assert.equal(assignmentRace.filter(result=>result.status==="fulfilled").length,1);
      assert.equal((await db.query("SELECT version FROM admissions_lead_assignments WHERE lead_id=$1",[l.id])).rows[0].version,5);
      await db.query("DROP TABLE admissions_crm_profiles,admissions_crm_activities");
      assert.equal((await listCrm(db,{},adminPrincipal)).capabilities.crmPersistence,false);
      await assert.rejects(updateCrm(db,`lead:${l.id}`,{expectedVersion:0,note:"no schema"},adminPrincipal),/migration is pending/);
      await db.query("DROP TABLE admissions_vsl_events,admissions_vsl_playbacks; DROP TABLE admissions_leads CASCADE");
      const degraded=await listCrm(db,{},adminPrincipal);
      assert.equal(degraded.capabilities.identityTracking,false);
      assert.equal(degraded.capabilities.videoTracking,false);
      assert.equal(degraded.overview.totalEnquiries,7);
    } finally {
      if(server) await new Promise<void>(resolve=>server!.close(()=>resolve()));
      if(db) await db.end();
      await root.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await root.end();
    }
  });
