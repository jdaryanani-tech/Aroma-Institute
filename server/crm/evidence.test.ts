import test from "node:test";
import assert from "node:assert/strict";
import { validateStageEvidence, updateCrmSchema } from "./evidence";
import type { CrmLead, CrmUpdate } from "../../shared/crm";

const lead = {stage:"new_enquiry",lastVideoMilestone:null,hasVerifiedForm:false} as CrmLead;
const update=(stage:CrmUpdate["stage"],evidence?:CrmUpdate["evidence"]):CrmUpdate=>({expectedVersion:0,stage,reason:"Explicit staff decision",evidence});
test("CRM evidence rules never treat a shared link or webhook receipt as watched/form/booked",()=>{
  assert.throws(()=>validateStageEvidence(lead,update("vsl_shared")));
  assert.throws(()=>validateStageEvidence(lead,update("vsl_watched",{kind:"tracked_video"})));
  assert.throws(()=>validateStageEvidence({...lead,lastVideoMilestone:"started"},update("vsl_watched",{kind:"tracked_video"})));
  assert.throws(()=>validateStageEvidence(lead,update("form_submitted")));
  assert.throws(()=>validateStageEvidence(lead,update("counselling_booked",{kind:"calendar_booking",reference:"invented-id",confirmed:true})),/persisted AICHM Calendar booking/);
  assert.throws(()=>validateStageEvidence(lead,update("enrolled")));
  assert.throws(()=>validateStageEvidence(lead,{expectedVersion:0,stage:"contacted"}));
});
test("CRM accepts only explicit staff/prospect attestations or stored playback/form evidence",()=>{
  assert.doesNotThrow(()=>validateStageEvidence(lead,update("vsl_shared",{
    kind:"link_sent",confirmed:true,reference:"sent-message-reference",occurredAt:"2026-01-01T00:00:00Z",
  })));
  assert.doesNotThrow(()=>validateStageEvidence(lead,update("vsl_watched",{
    kind:"prospect_confirmation",confirmed:true,reference:"Prospect explicitly confirmed watching the VSL",
  })));
  assert.doesNotThrow(()=>validateStageEvidence({...lead,lastVideoMilestone:"25"},update("vsl_watched",{kind:"tracked_video"})));
  assert.doesNotThrow(()=>validateStageEvidence({...lead,hasVerifiedForm:true},update("form_submitted")));
  for(const stage of ["enrolled","counselling_attended"] as const)
    assert.doesNotThrow(()=>validateStageEvidence(lead,update(stage,{kind:"staff_record",confirmed:true,reference:"Staff checked attendance/enrollment record"})));
  assert.equal(updateCrmSchema.safeParse({expectedVersion:0,note:"note",actorId:999}).success,false);
});
