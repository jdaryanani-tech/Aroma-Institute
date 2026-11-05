import test from "node:test";
import assert from "node:assert/strict";
import {
  canManageCalendarCategory, canViewCalendarEvent, expandCalendarRecurrence, quietHoursDelayMinutes,
  reminderRetryDelayMs,
} from "./policy";

test("student calendars only expose their own attendee, course, or batch events",()=>{
  const student={id:12,roles:["student" as const]};
  const privateEvent={category:"academic",ownerId:null,trainerId:6,studentId:19,courseId:2,batchId:5,attendeeIds:[]};
  assert.equal(canViewCalendarEvent(student,privateEvent,new Set([1]),new Set([4])),false);
  assert.equal(canViewCalendarEvent(student,privateEvent,new Set([2]),new Set([4])),true);
  assert.equal(canViewCalendarEvent(student,{...privateEvent,courseId:null,batchId:5},new Set(),new Set([5])),true);
  assert.equal(canViewCalendarEvent(student,{...privateEvent,studentId:12},new Set(),new Set()),true);
});

test("trainer event management is limited to their own assigned academic sessions",()=>{
  const trainer={id:6,roles:["trainer" as const]};
  assert.equal(canManageCalendarCategory(trainer,"academic",6),true);
  assert.equal(canManageCalendarCategory(trainer,"academic",8),false);
  assert.equal(canManageCalendarCategory(trainer,"admissions",6),false);
  assert.equal(canManageCalendarCategory(trainer,"operations",6),false);
});

test("recurring daily events expand within the requested date range",()=>{
  const event={id:"series",startsAt:"2026-01-01T03:30:00.000Z",endsAt:"2026-01-01T04:30:00.000Z",
    recurrence:{frequency:"daily" as const,interval:2,until:"2026-02-01T18:29:59.000Z"}};
  const occurrences=expandCalendarRecurrence(event,new Date("2026-01-10T00:00:00.000Z"),new Date("2026-01-15T00:00:00.000Z"));
  assert.deepEqual(occurrences.map(item=>item.startsAt),[
    "2026-01-11T03:30:00.000Z","2026-01-13T03:30:00.000Z",
  ]);
});

test("quiet hours respect Asia/Kolkata and windows that cross midnight",()=>{
  const now=new Date("2026-11-06T17:30:00.000Z"); // 23:00 in India
  assert.equal(quietHoursDelayMinutes(now,"Asia/Kolkata","22:00","06:00"),420);
  assert.equal(quietHoursDelayMinutes(now,"Asia/Kolkata","08:00","18:00"),0);
});

test("reminder retries use bounded exponential backoff",()=>{
  assert.equal(reminderRetryDelayMs(1),30_000);
  assert.equal(reminderRetryDelayMs(2),60_000);
  assert.equal(reminderRetryDelayMs(99),3_600_000);
});
