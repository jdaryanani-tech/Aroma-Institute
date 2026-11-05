import test from "node:test";
import assert from "node:assert/strict";
import { counsellingAnswersSchema } from "@shared/schema";
import { counsellingQuestions } from "../../client/src/pages/counsellingQuestions";
import { validateCounsellingAnswer } from "./questionnaire-validation";

test("AVNI questionnaire contract is the same ordered set of 29 official form fields",()=>{
  assert.equal(counsellingQuestions.length,29);
  assert.deepEqual(counsellingQuestions.map(question=>question.number),Array.from({length:29},(_,index)=>index+1));
  assert.deepEqual(counsellingQuestions.map(question=>question.key),Object.keys(counsellingAnswersSchema.shape));
  assert.equal(counsellingQuestions[28].key,"consentToContact");
  assert.equal(counsellingQuestions[28].required,true);
});

test("one-at-a-time validation reuses the public form's field schemas",()=>{
  assert.deepEqual(validateCounsellingAnswer("fullName","Asha Patel"),{valid:true,value:"Asha Patel"});
  assert.equal(validateCounsellingAnswer("ageRange","not-an-option").valid,false);
  assert.equal(validateCounsellingAnswer("careerReasons",[]).valid,false);
  assert.equal(validateCounsellingAnswer("mobileWhatsapp","123").valid,false);
  assert.equal(validateCounsellingAnswer("preferredDate","2000-01-01").valid,false);
  assert.deepEqual(validateCounsellingAnswer("topQuestions",""),{valid:true,value:""});
  assert.equal(validateCounsellingAnswer("consentToContact",false).valid,false);
  assert.deepEqual(validateCounsellingAnswer("consentToContact",true),{valid:true,value:true});
  assert.deepEqual(validateCounsellingAnswer("unrecognized",true),{valid:false,code:"unknown_question"});
});
