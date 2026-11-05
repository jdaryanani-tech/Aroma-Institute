import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express from "express";
import session from "express-session";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, ne } from "drizzle-orm";
import * as core from "@shared/schema";
import * as lms from "@shared/lms-schema";
import { admissionsLeads, admissionsLeadContactPreferences as preferences, admissionsRegistrationOutbox as outbox, admissionsVideoEvents } from "@shared/admissions-schema";
import { VSL_WHATSAPP_CONSENT_TEXT, VSL_WHATSAPP_CONSENT_VERSION } from "@shared/vsl-consent";
import { registerVslLead, saveLinkedCounsellingInquiry } from "./identity";
import { admissionsIntegrationSchemaReady, followUpSchemaReady, readLeadFollowUpByPhone, readLeadFollowUpStatus, recordWhatsAppOptOut } from "./follow-up";
import { registerAdmissionsRoutes } from "./routes";
import { registerFollowUpStatusRoute } from "./follow-up-routes";
import { dispatchVslRegistrationOnce, isTrustedVslWebhookUrl, vslRetryDelayMs } from "./outbox-dispatcher";
import { buildCounsellingWebhookPayload } from "../n8n-counselling";

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
  const database=drizzle(pool,{schema:{...core,...lms}});
  const server=createServer();
  let listening=false;
  try {
    // Fresh test DB only: prove the additive migration creates missing tables and repeats safely.
    await pool.query("DROP TABLE admissions_registration_outbox, admissions_lead_contact_preferences");
    assert.equal(await followUpSchemaReady(database),false);
    const fallback=await registerVslLead({phone:"9000000099",name:"Synthetic before migration",entryHost:"test.invalid",entryPath:"/vsl"},new Date(),database);
    assert.ok(fallback.id);
    const migration=await readFile("migrations/0008_admissions_follow_up.sql","utf8");
    await pool.query(migration);await pool.query(migration);
    assert.equal(await followUpSchemaReady(database),true);
    const avniMigration=await readFile("migrations/0009_avni_tracking.sql","utf8");
    await pool.query(avniMigration);await pool.query(avniMigration);
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
    const grantAt=status.consent.whatsappAdmissions.recordedAt;
    await registerVslLead(input,new Date(time.getTime()+1000),database);
    assert.equal((await readLeadFollowUpStatus(lead.id,database))!.consent.whatsappAdmissions.recordedAt,grantAt);

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
    assert.equal(status.consent.counsellingQuestion29.consentToContact,true);
    assert.equal(status.consent.counsellingQuestion29.allowed,false);
    assert.equal(status.consent.whatsappAdmissions.optOutSource,"prospect");
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
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/lookup`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({phone:"+91 90000 00001"}),
    })).status,401);
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/lookup`,{
      method:"POST",headers:{"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key"},
      body:JSON.stringify({phone:"not-a-phone"}),
    })).status,400);
    const assistedAnswers={...answers,fullName:"Synthetic AVNI completion"};
    const assistedLead=await registerVslLead({name:"Synthetic AVNI completion",phone:"9000000001",entryHost:"test.invalid",entryPath:"/vsl"},time,database);
    const assistedUrl=`${origin}/api/integrations/n8n/leads/${assistedLead.id}/counselling`;
    const assistedHeaders={"Content-Type":"application/json","x-aichm-webhook-secret":"synthetic-integration-key","Idempotency-Key":"avni-test-001"};
    const assistedBody=JSON.stringify({answers:assistedAnswers});
    const assisted=await fetch(assistedUrl,{method:"POST",headers:assistedHeaders,body:assistedBody});
    assert.equal(assisted.status,201);
    const assistedResult=await assisted.json();
    assert.equal(assistedResult.saved,true);
    assert.equal(assistedResult.duplicate,false);
    const duplicate=await fetch(assistedUrl,{method:"POST",headers:assistedHeaders,body:assistedBody});
    assert.equal(duplicate.status,200);
    assert.equal((await duplicate.json()).duplicate,true);
    assert.equal((await database.select().from(core.inquiries).where(eq(core.inquiries.submissionIdempotencyKey,"avni-test-001"))).length,1);
    assert.equal((await fetch(assistedUrl,{method:"POST",headers:assistedHeaders,body:JSON.stringify({answers:{...assistedAnswers,topQuestions:"changed"}})})).status,409);
    const mismatched=await registerVslLead({name:"Mismatch",phone:"9000000008",entryHost:"test.invalid",entryPath:"/vsl"},time,database);
    assert.equal((await fetch(`${origin}/api/integrations/n8n/leads/${mismatched.id}/counselling`,{
      method:"POST",headers:{...assistedHeaders,"Idempotency-Key":"avni-test-mismatch"},body:assistedBody,
    })).status,409);

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
