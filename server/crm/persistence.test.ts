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

test("isolated CRM SQL: additive repeat migrations, distinct identities, audit, evidence, pagination, guards and degraded schema",
  { skip:process.env.CRM_TEST_DB_WRITE_APPROVED!=="TEMPORARY_DEVELOPMENT_SCHEMA_ONLY" || process.env.NODE_ENV!=="test" },
  async()=>{
    const {pool:root}=await import("../db");
    const namespace=`crm_test_${randomUUID().replaceAll("-","")}`;
    assert.match(namespace,/^crm_test_[a-f0-9]+$/);
    let db:Pool|undefined,server:ReturnType<typeof createServer>|undefined;
    try {
      await root.query(`CREATE SCHEMA "${namespace}"`);
      db=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${namespace}`,max:4});
      await db.query(`CREATE TABLE inquiries(LIKE public.inquiries INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
        CREATE SEQUENCE inquiry_ids; ALTER TABLE inquiries ALTER COLUMN id SET DEFAULT nextval('inquiry_ids');
        ALTER TABLE inquiries ADD PRIMARY KEY(id);
        CREATE TABLE lms_users(id serial PRIMARY KEY,display_name text,is_active boolean DEFAULT true);
        CREATE TABLE lms_user_roles(user_id integer,role text);
        INSERT INTO lms_users(id,display_name) VALUES(1,'Test Admin'),(2,'Other Admin'),(3,'Test Student');
        INSERT INTO lms_user_roles VALUES(1,'admin'),(2,'admin'),(3,'student');`);
      const stage1=(await readFile("migrations/0006_admissions_stage_one.sql","utf8")).replaceAll('"public".',"");
      const crm=(await readFile("migrations/0007_admissions_crm.sql","utf8")).replaceAll('"public".',"");
      for(let i=0;i<2;i++) {await db.query(stage1);await db.query(crm);}
      await db.query(`CREATE TABLE counselling_delivery_attempts(
        id integer PRIMARY KEY,inquiry_id integer,attempt_number integer,attempted_at timestamptz,
        response_at timestamptz,http_status integer,delivery_state text,error_summary text)`);
      const {rows:[l]}=await db.query("INSERT INTO admissions_leads(canonical_phone,name,registered_at,entry_source) VALUES('919000000011','Linked Person',now(),'vsl_registration') RETURNING id");
      await db.query(`INSERT INTO inquiries(name,email,phone,program_interest,lead_id,counselling_answers,counselling_submitted_at) VALUES
        ('Linked Person','','9000000011','Barista',$1,NULL,NULL),
        ('Linked Person','synthetic@example.invalid','+91 90000 00011','Barista',$1,'{\"synthetic\":\"preserved\"}',now()),
        ('Ambiguous A','','9000000022','Barista',NULL,NULL,NULL),
        ('Ambiguous B','','919000000022','Barista',NULL,NULL,NULL),
        ('Unique Legacy','','9000000033','Other',NULL,NULL,NULL)`,[l.id]);
      const original=await db.query("SELECT to_jsonb(i) data FROM inquiries i ORDER BY id");
      const initial=await listCrm(db,{pageSize:2,page:1,sort:"name"});
      assert.equal(initial.total,4);assert.equal(initial.items.length,2);
      assert.equal(initial.overview.identifiedPeople,2);assert.equal(initial.overview.unresolvedRecords,2);
      assert.equal(initial.overview.totalEnquiries,5);
      assert.equal(initial.overview.registeredToFormPercent,100);
      assert.equal((await listCrm(db,{q:"9000000011"})).items.length,1);
      assert.equal((await listCrm(db,{q:"+91 90000 00011"})).items.length,1);
      assert.equal((await listCrm(db,{q:"%' OR true --"})).total,0);
      assert.equal((await listCrm(db,{program:"Other"})).total,1);
      let detail=await detailCrm(db,`lead:${l.id}`);
      assert.equal(detail.inquiries.length,2);
      assert.equal(detail.lead.stage,"form_submitted");
      assert.equal((await detailCrm(db,"inquiry:1")).lead.id,detail.lead.id);
      await db.query(`INSERT INTO counselling_delivery_attempts VALUES(1,2,1,now(),now(),403,'failed','HTTP 403: request rejected')`);
      const failed=await detailCrm(db,detail.lead.id);
      assert.equal(failed.inquiries.find(i=>i.id===2)?.deliveryAttemptHistory[0].httpStatus,403);
      assert.ok(failed.activities.some(a=>a.type==="delivery"&&a.data?.bookingConfirmed===false));
      detail=await updateCrm(db,detail.lead.id,{expectedVersion:0,stage:"contacted",reason:"Called the prospect",
        ownerId:2,followUpAt:"2099-01-01T10:00:00Z",note:"First internal note"},1);
      assert.equal(detail.lead.stage,"contacted");assert.equal(detail.lead.ownerId,2);assert.equal(detail.activities.filter(a=>a.source==="staff").length,4);
      assert.ok(detail.activities.filter(a=>a.source==="staff").every(a=>a.actorId===1 && a.at));
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:0,note:"stale"},1),/changed since/);
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:1,ownerId:3},1),/active administrator/);
      assert.equal((await listCrm(db,{stage:"contacted",owner:"2",followUp:"upcoming"})).total,1);
      assert.equal((await listCrm(db,{dateFrom:"2000-01-01",dateTo:"2099-01-01"})).total,1);
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:1,stage:"counselling_booked",reason:"Booking claim"},1),/persisted AICHM Calendar booking/);
      await assert.rejects(updateCrm(db,detail.lead.id,{expectedVersion:1,stage:"vsl_watched",reason:"Claim",evidence:{kind:"tracked_video"}},1));
      await db.query("INSERT INTO admissions_vsl_events(lead_id,event,position_seconds,duration_seconds) VALUES($1,'50',50,100)",[l.id]);
      detail=await updateCrm(db,detail.lead.id,{expectedVersion:1,stage:"vsl_watched",reason:"Playback verified",evidence:{kind:"tracked_video"}},1);
      assert.equal(detail.lead.stage,"vsl_watched");
      detail=await updateCrm(db,detail.lead.id,{expectedVersion:2,stage:"enrolled",reason:"Staff confirmed enrollment",evidence:{kind:"staff_record",confirmed:true,reference:"Checked enrollment in staff records"}},1);
      assert.equal(detail.lead.stage,"enrolled");
      const race=await Promise.allSettled([
        updateCrm(db,detail.lead.id,{expectedVersion:3,note:"Concurrent A"},1),
        updateCrm(db,detail.lead.id,{expectedVersion:3,note:"Concurrent B"},2),
      ]);
      assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
      // Metadata does not freeze automatic verified stages.
      const legacy=await updateCrm(db,"inquiry:5",{expectedVersion:0,note:"Review only"},1);
      assert.equal(legacy.lead.stageSource,"new");
      await db.query(`UPDATE inquiries SET counselling_answers='{"test":"later form"}',counselling_submitted_at=now() WHERE id=5`);
      assert.equal((await detailCrm(db,"inquiry:5")).lead.stageSource,"verified_form");
      await db.query("UPDATE inquiries SET counselling_answers=NULL,counselling_submitted_at=NULL WHERE id=5");
      assert.deepEqual((await db.query("SELECT to_jsonb(i) data FROM inquiries i ORDER BY id")).rows,original.rows);

      const {registerCrmRoutes}=await import("./routes");
      const app=express();app.use(express.json());
      registerCrmRoutes(app,{db,connectionPool:db,authenticate:(req,res,next)=>{
        const role=req.header("x-test-role");
        if(!role) {res.status(401).json({message:"Authentication required"});return;}
        req.lmsUser={id:1,phoneE164:"synthetic",displayName:"Test Admin",roles:[role as "admin"|"student"]};next();
      }});
      server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
      const address=server.address();assert.ok(address && typeof address!=="string");
      const origin=`http://127.0.0.1:${address.port}`;
      for(const path of ["/api/admin/crm/leads",`/api/admin/crm/leads/lead:${l.id}`]) {
        assert.equal((await fetch(origin+path)).status,401);
        assert.equal((await fetch(origin+path,{headers:{"x-test-role":"student"}})).status,403);
        const admin=await fetch(origin+path,{headers:{"x-test-role":"admin"}});
        assert.equal(admin.status,200);assert.match(admin.headers.get("cache-control")!,/no-store/);
      }
      const patch=(role?:string,site=origin)=>fetch(origin+`/api/admin/crm/leads/lead:${l.id}`,{
        method:"PATCH",headers:{"Content-Type":"application/json",Origin:site,...(role?{"x-test-role":role}:{})},
        body:JSON.stringify({expectedVersion:4,note:"Test note"}),
      });
      assert.equal((await patch()).status,401);assert.equal((await patch("student")).status,403);
      assert.equal((await patch("admin","https://evil.invalid")).status,403);
      assert.equal((await fetch(origin+"/api/admin/crm/leads?pageSize=999",{headers:{"x-test-role":"admin"}})).status,400);
      await db.query("DROP TABLE admissions_crm_profiles,admissions_crm_activities");
      assert.equal((await listCrm(db,{})).capabilities.crmPersistence,false);
      await assert.rejects(updateCrm(db,`lead:${l.id}`,{expectedVersion:0,note:"no schema"},1),/migration is pending/);
      await db.query("DROP TABLE admissions_vsl_events,admissions_vsl_playbacks; DROP TABLE admissions_leads CASCADE");
      const degraded=await listCrm(db,{});
      assert.equal(degraded.capabilities.identityTracking,false);
      assert.equal(degraded.capabilities.videoTracking,false);
      assert.equal(degraded.overview.totalEnquiries,5);
    } finally {
      if(server) await new Promise<void>(resolve=>server!.close(()=>resolve()));
      if(db) await db.end();
      await root.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await root.end();
    }
  });
