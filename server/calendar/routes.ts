import type { Express } from "express";
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  availabilityExceptions, calendarActivity, calendarBatchStudents, calendarBatches,
  calendarEventAttendees, calendarEvents, calendarReminderJobs, calendarResources,
  notificationPreferences, pushSubscriptions, staffAvailability,
} from "@shared/calendar-schema";
import { lmsEnrollments, lmsLiveSessions, lmsNotifications, lmsTrainerAssignments, lmsUserRoles, lmsUsers } from "@shared/lms-schema";
import { admissionsLeads } from "@shared/admissions-schema";
import { inquiries } from "@shared/schema";
import { db, pool } from "../db";
import { requireLmsRole, requireLmsUser, type LmsRole } from "../lms/auth";
import { sameOriginCapture } from "../admissions/routes";
import { getPushConfiguration } from "./push";
import { encryptSubscription, isTrustedPushEndpoint, pushEndpointHash } from "./subscription-crypto";
import { canManageCalendarCategory, canSeeCalendarCategory, canViewCalendarEvent, expandCalendarRecurrence } from "./policy";

const categories = ["admissions","academic","workshops","staff","operations","student"] as const;
const statuses = ["draft","requested","confirmed","completed","cancelled","rescheduled"] as const;
const eventBase = z.object({
  title:z.string().trim().min(1).max(200),description:z.string().max(4000).nullable().optional(),
  category:z.enum(categories),eventType:z.string().trim().min(1).max(100),
  startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}).nullable().optional(),
  timezone:z.string().min(1).max(80).default("Asia/Kolkata"),allDay:z.boolean().default(false),
  location:z.string().max(300).nullable().optional(),onlineUrl:z.string().url().max(1000).nullable().optional(),
  status:z.enum(statuses).default("confirmed"),ownerId:z.number().int().positive().nullable().optional(),
  attendeeIds:z.array(z.number().int().positive()).max(100).default([]),
  leadId:z.string().uuid().nullable().optional(),inquiryId:z.number().int().positive().nullable().optional(),
  studentId:z.number().int().positive().nullable().optional(),courseId:z.number().int().positive().nullable().optional(),
  batchId:z.number().int().positive().nullable().optional(),trainerId:z.number().int().positive().nullable().optional(),
  resourceId:z.number().int().positive().nullable().optional(),capacity:z.number().int().positive().max(10000).nullable().optional(),
  recurrence:z.object({frequency:z.enum(["daily","weekly","monthly"]),interval:z.number().int().min(1).max(99),
    until:z.string().datetime({offset:true}).nullable(),weekdays:z.array(z.number().int().min(0).max(6)).max(7).optional()}).nullable().optional(),
  overrideReason:z.string().trim().min(3).max(1000).optional(),
}).strict();
const eventInput = eventBase.superRefine((value,ctx)=>{
  if(value.endsAt && new Date(value.endsAt)<=new Date(value.startsAt)) ctx.addIssue({code:"custom",path:["endsAt"],message:"End must be after start."});
  try { new Intl.DateTimeFormat("en", {timeZone:value.timezone}); } catch { ctx.addIssue({code:"custom",path:["timezone"],message:"Choose a valid IANA timezone."}); }
  if(value.recurrence?.until && new Date(value.recurrence.until)<new Date(value.startsAt)) ctx.addIssue({code:"custom",path:["recurrence","until"],message:"Repeat end must be after start."});
});
const filterSchema=z.object({
  start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true}),
  category:z.enum(categories).optional(),courseId:z.coerce.number().int().positive().optional(),
  batchId:z.coerce.number().int().positive().optional(),staffId:z.coerce.number().int().positive().optional(),
  resourceId:z.coerce.number().int().positive().optional(),status:z.enum(statuses).optional(),
  search:z.string().trim().max(120).optional(),location:z.string().trim().max(120).optional(),
  view:z.enum(["day","week","month","agenda","my","resource"]).optional(),
}).strict();

type User = NonNullable<Express.Request["lmsUser"]>;
const startOf = (date:string) => new Date(date);
function eventDto(row:any, attendeeIds:number[]=[]):any {
  return {
    id:String(row.id),source:"calendar",title:row.title,description:row.description,category:row.category,eventType:row.eventType,
    startsAt:new Date(row.startsAt).toISOString(),endsAt:row.endsAt?new Date(row.endsAt).toISOString():null,
    timezone:row.timezone,allDay:row.allDay,location:row.location,onlineUrl:row.onlineUrl,status:row.status,
    organizerId:row.organizerId,ownerId:row.ownerId,attendeeIds,leadId:row.leadId,inquiryId:row.inquiryId,
    studentId:row.studentId,courseId:row.courseId,batchId:row.batchId,trainerId:row.trainerId,
    resourceId:row.resourceId,capacity:row.capacity,recurrence:row.recurrenceRule,version:row.version,conflictWarnings:[],
  };
}
class CalendarConflictError extends Error {
  constructor(readonly conflicts:string[]) { super("calendar_conflict"); }
}
export function calendarLockKeys(input:any,actorId:number) {
  return Array.from(new Set<string>([
    ...(input.resourceId?[`resource:${input.resourceId}`]:[]),
    ...(input.trainerId?[`staff:${input.trainerId}`]:[]),
    `staff:${input.ownerId??actorId}`,
    ...(input.leadId?[`lead:${input.leadId}`]:[]),
    ...(input.inquiryId?[`inquiry:${input.inquiryId}`]:[]),
    ...((input.attendeeIds??[]) as number[]).map(id=>`staff:${id}`),
  ])).sort();
}
export async function queueEventReminderJobs(tx:any,event:any,actorId:number,attendeeIds:number[],action:"created"|"updated"|"cancelled") {
  const recipients=new Set<number>([actorId,...attendeeIds,...(event.ownerId?[event.ownerId]:[]),
    ...(event.trainerId?[event.trainerId]:[]),...(event.studentId?[event.studentId]:[])]);
  if(event.courseId) {
    const enrolled=await tx.select({studentId:lmsEnrollments.studentId}).from(lmsEnrollments).where(and(
      eq(lmsEnrollments.courseId,event.courseId),eq(lmsEnrollments.status,"active"),
    ));
    enrolled.forEach((row:any)=>recipients.add(row.studentId));
  }
  if(event.batchId) {
    const assigned=await tx.select({studentId:calendarBatchStudents.studentId}).from(calendarBatchStudents)
      .where(eq(calendarBatchStudents.batchId,event.batchId));
    assigned.forEach((row:any)=>recipients.add(row.studentId));
  }
  const roleTargets:LmsRole[]=["admin"];
  if(event.category==="admissions") roleTargets.push("admissions");
  if(event.category==="academic") roleTargets.push("academic_coordinator");
  if(event.category==="staff"||event.category==="operations") roleTargets.push("operations");
  const roleRecipients=await tx.select({userId:lmsUserRoles.userId}).from(lmsUserRoles)
    .where(inArray(lmsUserRoles.role,roleTargets));
  roleRecipients.forEach((row:any)=>recipients.add(row.userId));
  for(const recipient of Array.from(recipients)) {
    const [categoryPreference]=await tx.select().from(notificationPreferences).where(and(
      eq(notificationPreferences.userId,recipient),eq(notificationPreferences.category,event.category),
    )).limit(1);
    const [defaultPreference]=categoryPreference?[]:await tx.select().from(notificationPreferences).where(and(
      eq(notificationPreferences.userId,recipient),eq(notificationPreferences.category,"default"),
    )).limit(1);
    const preference=categoryPreference??defaultPreference;
    const recipientRoles=await tx.select({role:lmsUserRoles.role}).from(lmsUserRoles)
      .where(eq(lmsUserRoles.userId,recipient));
    const offsets=preference?.reminderOffsetsMinutes??(
      recipientRoles.some((row:any)=>row.role==="trainer")?[1440,120,15]:
      recipientRoles.some((row:any)=>row.role==="student")?[1440,120]:
      recipientRoles.some((row:any)=>row.role==="admissions")?[120,30]:[1440,120]
    );
    if(action!=="cancelled") {
      for(const offset of offsets) {
        const dueAt=new Date(new Date(event.startsAt).getTime()-offset*60_000);
        if(dueAt<=new Date()) continue;
        await tx.insert(calendarReminderJobs).values({
          eventId:event.id,eventVersion:event.version,userId:recipient,dueAt,
          idempotencyKey:`event:${event.id}:v${event.version}:user:${recipient}:at:${dueAt.toISOString()}`,
        }).onConflictDoNothing();
      }
    }
    await tx.insert(calendarReminderJobs).values({
      eventId:event.id,eventVersion:event.version,userId:recipient,dueAt:new Date(),
      idempotencyKey:`event:${event.id}:v${event.version}:user:${recipient}:${action}`,
    }).onConflictDoNothing();
  }
}
function localScheduleParts(date:Date,timezone:string) {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:timezone,weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23",
    year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(date);
  const get=(type:string)=>parts.find(part=>part.type===type)?.value??"";
  const weekdays=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return {
    weekday:weekdays.indexOf(get("weekday")),
    date:`${get("year")}-${get("month")}-${get("day")}`,
    time:`${get("hour")}:${get("minute")}`,
  };
}

export function registerCalendarRoutes(app:Express) {
  app.get("/api/calendar/events",requireLmsUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const parsed=filterSchema.safeParse(req.query);
    if(!parsed.success) return void res.status(400).json({message:"Calendar range or filter is invalid."});
    const f=parsed.data,user=req.lmsUser!;
    const start=startOf(f.start),end=startOf(f.end);
    if(end<=start||end.getTime()-start.getTime()>93*86400000) return void res.status(400).json({message:"Choose a calendar range under 93 days."});
    try {
      const stored=await db.select().from(calendarEvents).where(and(
        lt(calendarEvents.startsAt,end),
        or(sql`${calendarEvents.endsAt} IS NULL`,gt(calendarEvents.endsAt,start)),
        f.category?eq(calendarEvents.category,f.category):undefined,
        f.courseId?eq(calendarEvents.courseId,f.courseId):undefined,
        f.batchId?eq(calendarEvents.batchId,f.batchId):undefined,
        f.staffId?or(eq(calendarEvents.trainerId,f.staffId),eq(calendarEvents.ownerId,f.staffId)):undefined,
        f.resourceId?eq(calendarEvents.resourceId,f.resourceId):undefined,
        f.status?eq(calendarEvents.status,f.status):undefined,
      ));
      const storedIds=stored.map(row=>row.id);
      const attendeeRows=storedIds.length?await db.select().from(calendarEventAttendees).where(inArray(calendarEventAttendees.eventId,storedIds)):[];
      const attendeeMap=new Map<string,number[]>();
      for(const attendee of attendeeRows) if(attendee.userId) attendeeMap.set(attendee.eventId,(attendeeMap.get(attendee.eventId)??[]).concat(attendee.userId));
      const studentCourseIds=new Set<number>();
      const studentBatchIds=new Set<number>();
      if(user.roles.includes("student")) {
        const enrollments=await db.select({courseId:lmsEnrollments.courseId}).from(lmsEnrollments).where(and(
          eq(lmsEnrollments.studentId,user.id),eq(lmsEnrollments.status,"active"),
        ));
        enrollments.forEach(item=>studentCourseIds.add(item.courseId));
        const batches=await db.select({batchId:calendarBatchStudents.batchId}).from(calendarBatchStudents)
          .where(eq(calendarBatchStudents.studentId,user.id));
        batches.forEach(item=>studentBatchIds.add(item.batchId));
      }
      let items=stored.map(row=>eventDto(row,attendeeMap.get(row.id)??[]));
      items=items.filter((item:any)=>canViewCalendarEvent(user,item,studentCourseIds,studentBatchIds));
      // Project LMS live sessions directly from their system-of-record table; no duplicate calendar rows.
      if(canSeeCalendarCategory(user,"academic")&&(!f.category||f.category==="academic")) {
        const sessions=await db.select().from(lmsLiveSessions).where(and(
          lt(lmsLiveSessions.startsAt,end),
          or(sql`${lmsLiveSessions.endsAt} IS NULL`,gt(lmsLiveSessions.endsAt,start)),
          f.courseId?eq(lmsLiveSessions.courseId,f.courseId):undefined,
          f.staffId?eq(lmsLiveSessions.trainerId,f.staffId):undefined,
          user.roles.includes("admin")||user.roles.includes("academic_coordinator")?undefined:
            user.roles.includes("trainer")?eq(lmsLiveSessions.trainerId,user.id):undefined,
        ));
        for(const session of sessions) {
          if(user.roles.includes("student")&&!user.roles.some(role=>["admin","academic_coordinator","trainer"].includes(role))) {
            const [enrollment]=await db.select({id:lmsEnrollments.id}).from(lmsEnrollments).where(and(
              eq(lmsEnrollments.studentId,user.id),eq(lmsEnrollments.courseId,session.courseId),eq(lmsEnrollments.status,"active"),
            )).limit(1);
            if(!enrollment) continue;
          }
          items.push({
            id:`lms-session:${session.id}`,source:"lms_session",title:session.title,description:session.topic||null,
            category:"academic",eventType:"live_session",startsAt:session.startsAt.toISOString(),endsAt:session.endsAt?.toISOString()??null,
            timezone:"Asia/Kolkata",allDay:false,location:null,onlineUrl:session.meetUrl,
            status:session.status==="scheduled"?"confirmed":session.status,organizerId:session.trainerId,ownerId:session.trainerId,
            attendeeIds:[],leadId:null,inquiryId:null,studentId:null,courseId:session.courseId,batchId:null,
            trainerId:session.trainerId,resourceId:null,capacity:null,recurrence:null,version:1,conflictWarnings:[],
          });
        }
      }
      // CRM follow-ups remain sourced from the existing profile field, not a second follow-up record.
      if((user.roles.includes("admin")||user.roles.includes("admissions"))&&(!f.category||f.category==="admissions")) {
        const rows=await pool.query(`SELECT p.inquiry_id,p.follow_up_at,p.owner_id,i.lead_id
          FROM admissions_crm_profiles p JOIN inquiries i ON i.id=p.inquiry_id
          WHERE p.follow_up_at >= $1 AND p.follow_up_at < $2 AND p.follow_up_at IS NOT NULL
            AND ($3::boolean OR p.owner_id=$4)`,[start,end,user.roles.includes("admin"),user.id]);
        for(const row of rows.rows) items.push({
          id:`crm-follow-up:${row.inquiry_id}`,source:"crm_follow_up",title:`Admissions follow-up · enquiry ${row.inquiry_id}`,
          description:null,category:"admissions",eventType:"follow_up",startsAt:new Date(row.follow_up_at).toISOString(),
          endsAt:null,timezone:"Asia/Kolkata",allDay:false,location:null,onlineUrl:null,status:"confirmed",
          organizerId:row.owner_id,ownerId:row.owner_id,attendeeIds:[],leadId:row.lead_id,inquiryId:Number(row.inquiry_id),
          studentId:null,courseId:null,batchId:null,trainerId:null,resourceId:null,capacity:null,recurrence:null,version:1,conflictWarnings:[],
        });
      }
      // Preferred counselling times are requests only; they are never treated as confirmed bookings.
      if((user.roles.includes("admin")||user.roles.includes("admissions"))&&(!f.category||f.category==="admissions")) {
        const rows=await pool.query(`SELECT i.id,i.counselling_answers,i.lead_id FROM inquiries i
          WHERE i.counselling_answers->>'preferredDate' IS NOT NULL
            AND ($1::boolean OR EXISTS(SELECT 1 FROM admissions_crm_profiles p WHERE p.inquiry_id=i.id AND p.owner_id=$2))
            AND NOT EXISTS(SELECT 1 FROM calendar_events e WHERE e.inquiry_id=i.id AND e.source_type='counselling_booking' AND e.status<>'cancelled')`,
          [user.roles.includes("admin"),user.id]);
        const slotStart:Record<string,string>={ "10to12":"10:00","12to14":"12:00","14to16":"14:00","16to18":"16:00" };
        for(const row of rows.rows) {
          const answers=row.counselling_answers??{};
          const day=String(answers.preferredDate);
          if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
          const time=slotStart[String(answers.preferredTime)]??"09:00";
          const begins=new Date(`${day}T${time}:00+05:30`);
          if(begins<start||begins>=end) continue;
          items.push({id:`counselling-request:${row.id}`,source:"counselling_request",title:`Counselling request · enquiry ${row.id}`,
            description:"Prospect-selected preferred time; appointment is not confirmed.",category:"admissions",eventType:"counselling_request",
            startsAt:begins.toISOString(),endsAt:new Date(begins.getTime()+60*60_000).toISOString(),timezone:"Asia/Kolkata",
            allDay:false,location:null,onlineUrl:null,status:"requested",organizerId:null,ownerId:null,attendeeIds:[],
            leadId:row.lead_id,inquiryId:Number(row.id),studentId:null,courseId:null,batchId:null,trainerId:null,
            resourceId:null,capacity:null,recurrence:null,version:1,conflictWarnings:[]});
        }
      }
      items=items.flatMap((item:any)=>expandCalendarRecurrence(item,start,end))
        .filter((item:any)=>!f.search||`${item.title} ${item.description??""} ${item.eventType} ${item.location??""}`.toLowerCase().includes(f.search.toLowerCase()))
        .filter((item:any)=>!f.location||(item.location??"").toLowerCase().includes(f.location.toLowerCase()))
        .filter((item:any)=>!f.staffId||item.trainerId===f.staffId||item.ownerId===f.staffId)
        .filter((item:any)=>!f.courseId||item.courseId===f.courseId)
        .filter((item:any)=>!f.batchId||item.batchId===f.batchId)
        .filter((item:any)=>!f.resourceId||item.resourceId===f.resourceId)
        .filter((item:any)=>!f.status||item.status===f.status)
        .filter((item:any)=>f.view!=="my"||item.ownerId===user.id||item.trainerId===user.id||item.attendeeIds.includes(user.id)||item.studentId===user.id)
        .sort((a:any,b:any)=>a.startsAt.localeCompare(b.startsAt));
      return void res.json(items);
    } catch {
      return void res.status(503).json({message:"Calendar is temporarily unavailable."});
    }
  });

  app.post("/api/calendar/events",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const parsed=eventInput.safeParse(req.body);
    if(!parsed.success) return void res.status(400).json({message:"Enter valid calendar event details."});
    const input=parsed.data,user=req.lmsUser!;
    if(!canManageCalendarCategory(user,input.category,input.trainerId)) return void res.status(403).json({message:"You cannot create events in this calendar."});
    if(input.status==="confirmed"&&input.category==="admissions"&&/counselling|visit/i.test(input.eventType)&&!input.inquiryId)
      return void res.status(400).json({message:"A confirmed counselling appointment must link to its saved enquiry."});
    if(input.ownerId!==undefined&&input.ownerId!==null&&!user.roles.includes("admin")&&input.ownerId!==user.id)
      return void res.status(403).json({message:"You cannot assign this event to another owner."});
    try {
      let linkedLeadId:string|null=null;
      if(input.inquiryId) {
        if(input.category!=="admissions") return void res.status(400).json({message:"Only admissions events can link to an enquiry."});
        const [inquiry]=await pool.query(`SELECT i.id,i.lead_id,p.owner_id FROM inquiries i
          LEFT JOIN admissions_crm_profiles p ON p.inquiry_id=i.id WHERE i.id=$1 LIMIT 1`,[input.inquiryId]).then(result=>result.rows);
        if(!inquiry||(!user.roles.includes("admin")&&inquiry.owner_id!==user.id))
          return void res.status(404).json({message:"Saved enquiry not found for this account."});
        linkedLeadId=inquiry.lead_id??null;
      } else if(input.leadId) {
        return void res.status(400).json({message:"Link an admissions event through its saved enquiry."});
      }
      if(input.trainerId) {
        const [trainer]=await db.select({role:lmsUserRoles.role}).from(lmsUserRoles).where(and(
          eq(lmsUserRoles.userId,input.trainerId),eq(lmsUserRoles.role,"trainer"),
        )).limit(1);
        if(!trainer) return void res.status(400).json({message:"Select an assigned trainer account."});
        if(input.courseId) {
          const [assignment]=await db.select({id:lmsTrainerAssignments.id}).from(lmsTrainerAssignments).where(and(
            eq(lmsTrainerAssignments.courseId,input.courseId),eq(lmsTrainerAssignments.trainerId,input.trainerId),
          )).limit(1);
          if(!assignment) return void res.status(400).json({message:"Assign this trainer to the course before scheduling."});
        }
      }
      if(input.ownerId) {
        const [ownerRole]=await db.select({role:lmsUserRoles.role}).from(lmsUserRoles).where(and(
          eq(lmsUserRoles.userId,input.ownerId),
          inArray(lmsUserRoles.role,["admin","trainer","admissions","academic_coordinator","operations"]),
        )).limit(1);
        if(!ownerRole) return void res.status(400).json({message:"Assign this event to an active staff account."});
      }
      if(input.studentId) {
        const [studentRole]=await db.select({id:lmsUserRoles.userId}).from(lmsUserRoles).where(and(
          eq(lmsUserRoles.userId,input.studentId),eq(lmsUserRoles.role,"student"),
        )).limit(1);
        if(!studentRole) return void res.status(400).json({message:"Select a valid student account."});
      }
      if(input.batchId) {
        const [batch]=await db.select({courseId:calendarBatches.courseId}).from(calendarBatches)
          .where(eq(calendarBatches.id,input.batchId)).limit(1);
        if(!batch||(input.courseId&&input.courseId!==batch.courseId))
          return void res.status(400).json({message:"The selected batch does not match this course."});
      }
      if(input.resourceId) {
        const [resource]=await db.select({id:calendarResources.id}).from(calendarResources).where(and(
          eq(calendarResources.id,input.resourceId),eq(calendarResources.active,true),
        )).limit(1);
        if(!resource) return void res.status(400).json({message:"The selected resource is unavailable."});
      }
      if(input.attendeeIds.length) {
        const attendees=await db.select({userId:lmsUserRoles.userId}).from(lmsUserRoles)
          .where(inArray(lmsUserRoles.userId,input.attendeeIds));
        if(new Set(attendees.map(row=>row.userId)).size!==input.attendeeIds.length)
          return void res.status(400).json({message:"One or more attendees are unavailable."});
      }
      const idempotencyKey=req.get("Idempotency-Key")?.slice(0,200)||
        `calendar:${user.id}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
      const [existing]=await db.select().from(calendarEvents).where(eq(calendarEvents.idempotencyKey,idempotencyKey)).limit(1);
      if(existing) return void res.status(200).json(eventDto(existing));
      const {attendeeIds,overrideReason,recurrence,...eventFields}=input;
      let conflicts:string[]=[];
      const canOverride=user.roles.some(role=>["admin","academic_coordinator","operations"].includes(role));
      const [saved]=await db.transaction(async tx=>{
        const conflictInput={...input,leadId:linkedLeadId};
        for(const key of calendarLockKeys(conflictInput,user.id)) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
        conflicts=await findConflicts(conflictInput,user.id);
        if(conflicts.length&&!(overrideReason&&canOverride)) throw new CalendarConflictError(conflicts);
        const [created]=await tx.insert(calendarEvents).values({
          ...eventFields,startsAt:new Date(input.startsAt),endsAt:input.endsAt?new Date(input.endsAt):null,
          organizerId:user.id,ownerId:input.ownerId??user.id,createdBy:user.id,
          leadId:linkedLeadId,recurrenceRule:recurrence??null,idempotencyKey,
          sourceType:input.inquiryId&&/counselling|visit/i.test(input.eventType)?"counselling_booking":input.inquiryId?"admissions_event":null,
          sourceId:input.inquiryId?String(input.inquiryId):null,
        }).returning();
        if(attendeeIds.length) await tx.insert(calendarEventAttendees).values(attendeeIds.map(userId=>({eventId:created.id,userId,required:true,status:"invited"}))).onConflictDoNothing();
        await queueEventReminderJobs(tx,created,user.id,attendeeIds,"created");
        await tx.insert(calendarActivity).values({
          eventId:created.id,actorId:user.id,action:"created",newValues:input,
          reason:conflicts.length?input.overrideReason??null:null,
        });
        return [created];
      });
      return void res.status(201).json(eventDto(saved,attendeeIds));
    } catch(error) {
      if(error instanceof CalendarConflictError)
        return void res.status(409).json({message:"This event conflicts with another booking. Review the conflict or enter an authorized override reason.",conflicts:error.conflicts});
      return void res.status(503).json({message:"Calendar event could not be saved."});
    }
  });

  app.patch("/api/calendar/events/:eventId",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const eventId=String(req.params.eventId).split("@")[0];
    const parsed=z.object({expectedVersion:z.number().int().positive(),update:eventBase.partial()}).strict().safeParse(req.body);
    if(!parsed.success) return void res.status(400).json({message:"Event changes are invalid."});
    try {
      const [before]=await db.select().from(calendarEvents).where(eq(calendarEvents.id,eventId)).limit(1);
      if(!before) return void res.status(404).json({message:"Calendar event not found."});
      const user=req.lmsUser!;
      if(!canManageCalendarCategory(user,before.category,before.trainerId)) return void res.status(403).json({message:"You cannot edit this event."});
      if(before.version!==parsed.data.expectedVersion) return void res.status(409).json({message:"This event changed. Reload it before editing."});
      const currentAttendees=await db.select({userId:calendarEventAttendees.userId}).from(calendarEventAttendees)
        .where(eq(calendarEventAttendees.eventId,eventId));
      const attendeeIds=parsed.data.update.attendeeIds??currentAttendees.flatMap(item=>item.userId?[item.userId]:[]);
      const next={...before,...parsed.data.update,attendeeIds};
      if(!canManageCalendarCategory(user,next.category,next.trainerId))
        return void res.status(403).json({message:"You cannot move this event to another calendar."});
      if(next.endsAt&&new Date(next.endsAt)<=new Date(next.startsAt)) return void res.status(400).json({message:"End time must follow start time."});
      if(parsed.data.update.leadId!==undefined)
        return void res.status(400).json({message:"Lead identity is derived from the saved enquiry link."});
      if(parsed.data.update.inquiryId===null&&before.inquiryId)
        return void res.status(400).json({message:"Keep the original saved enquiry linked to this event."});
      if(parsed.data.update.inquiryId&&before.inquiryId&&parsed.data.update.inquiryId!==before.inquiryId)
        return void res.status(400).json({message:"The saved enquiry link cannot be changed after creation."});
      if(parsed.data.update.inquiryId) {
        if(next.category!=="admissions") return void res.status(400).json({message:"Only admissions events can link to an enquiry."});
        const {rows}=await pool.query(`SELECT i.lead_id,p.owner_id FROM inquiries i
          LEFT JOIN admissions_crm_profiles p ON p.inquiry_id=i.id WHERE i.id=$1 LIMIT 1`,[parsed.data.update.inquiryId]);
        if(!rows[0]||(!user.roles.includes("admin")&&rows[0].owner_id!==user.id))
          return void res.status(404).json({message:"Saved enquiry not found for this account."});
        next.leadId=rows[0].lead_id??null;
      }
      if(next.status==="confirmed"&&next.category==="admissions"&&/counselling|visit/i.test(next.eventType)&&!next.inquiryId)
        return void res.status(400).json({message:"A confirmed counselling appointment must link to its saved enquiry."});
      if(parsed.data.update.ownerId!==undefined&&parsed.data.update.ownerId!==null&&
        !user.roles.includes("admin")&&parsed.data.update.ownerId!==user.id)
        return void res.status(403).json({message:"You cannot assign this event to another owner."});
      if(parsed.data.update.ownerId) {
        const [ownerRole]=await db.select({role:lmsUserRoles.role}).from(lmsUserRoles).where(and(
          eq(lmsUserRoles.userId,parsed.data.update.ownerId),
          inArray(lmsUserRoles.role,["admin","trainer","admissions","academic_coordinator","operations"]),
        )).limit(1);
        if(!ownerRole) return void res.status(400).json({message:"Assign this event to an active staff account."});
      }
      if(next.trainerId&&(parsed.data.update.trainerId!==undefined||parsed.data.update.courseId!==undefined)) {
        const [trainer]=await db.select({role:lmsUserRoles.role}).from(lmsUserRoles).where(and(
          eq(lmsUserRoles.userId,next.trainerId),eq(lmsUserRoles.role,"trainer"),
        )).limit(1);
        if(!trainer) return void res.status(400).json({message:"Select an assigned trainer account."});
        if(next.courseId) {
          const [assignment]=await db.select({id:lmsTrainerAssignments.id}).from(lmsTrainerAssignments).where(and(
            eq(lmsTrainerAssignments.courseId,next.courseId),eq(lmsTrainerAssignments.trainerId,next.trainerId),
          )).limit(1);
          if(!assignment) return void res.status(400).json({message:"Assign this trainer to the course before scheduling."});
        }
      }
      if(parsed.data.update.studentId) {
        const [student]=await db.select({id:lmsUserRoles.userId}).from(lmsUserRoles).where(and(
          eq(lmsUserRoles.userId,parsed.data.update.studentId),eq(lmsUserRoles.role,"student"),
        )).limit(1);
        if(!student) return void res.status(400).json({message:"Select a valid student account."});
      }
      if(parsed.data.update.resourceId) {
        const [resource]=await db.select({id:calendarResources.id}).from(calendarResources).where(and(
          eq(calendarResources.id,parsed.data.update.resourceId),eq(calendarResources.active,true),
        )).limit(1);
        if(!resource) return void res.status(400).json({message:"The selected resource is unavailable."});
      }
      if(parsed.data.update.batchId) {
        const [batch]=await db.select({courseId:calendarBatches.courseId}).from(calendarBatches)
          .where(eq(calendarBatches.id,parsed.data.update.batchId)).limit(1);
        if(!batch||(next.courseId&&next.courseId!==batch.courseId))
          return void res.status(400).json({message:"The selected batch does not match this course."});
      }
      if(parsed.data.update.attendeeIds) {
        const valid=await db.select({userId:lmsUserRoles.userId}).from(lmsUserRoles)
          .where(inArray(lmsUserRoles.userId,parsed.data.update.attendeeIds));
        if(new Set(valid.map(item=>item.userId)).size!==parsed.data.update.attendeeIds.length)
          return void res.status(400).json({message:"One or more attendees are unavailable."});
      }
      const reason=parsed.data.update.overrideReason;
      let conflicts:string[]=[];
      const canOverride=user.roles.some(role=>["admin","academic_coordinator","operations"].includes(role));
      const saved=await db.transaction(async tx=>{
        for(const key of calendarLockKeys(next,user.id)) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
        conflicts=await findConflicts(next,user.id,eventId);
        if(conflicts.length&&!(reason&&canOverride)) throw new CalendarConflictError(conflicts);
        const [updated]=await tx.update(calendarEvents).set({
          title:next.title,description:next.description,category:next.category,eventType:next.eventType,
          startsAt:new Date(next.startsAt),endsAt:next.endsAt?new Date(next.endsAt):null,timezone:next.timezone,
          allDay:next.allDay,location:next.location,onlineUrl:next.onlineUrl,status:next.status,
          ownerId:next.ownerId,leadId:next.leadId,inquiryId:next.inquiryId,studentId:next.studentId,
          courseId:next.courseId,batchId:next.batchId,trainerId:next.trainerId,resourceId:next.resourceId,
          capacity:next.capacity,recurrenceRule:next.recurrence,version:before.version+1,updatedAt:new Date(),
        }).where(and(eq(calendarEvents.id,eventId),eq(calendarEvents.version,before.version))).returning();
        if(!updated) throw new Error("version_conflict");
        if(parsed.data.update.attendeeIds) {
          await tx.delete(calendarEventAttendees).where(eq(calendarEventAttendees.eventId,eventId));
          if(parsed.data.update.attendeeIds.length) await tx.insert(calendarEventAttendees).values(
            parsed.data.update.attendeeIds.map(userId=>({eventId,userId,required:true,status:"invited"})),
          ).onConflictDoNothing();
        }
        await tx.update(calendarReminderJobs).set({
          state:"failed",lastError:"Superseded by a schedule update.",lockedAt:null,lockToken:null,updatedAt:new Date(),
        }).where(and(eq(calendarReminderJobs.eventId,eventId),eq(calendarReminderJobs.state,"pending")));
        if(updated.status==="cancelled") await queueEventReminderJobs(tx,updated,user.id,attendeeIds,"cancelled");
        else if(updated.status!=="completed") await queueEventReminderJobs(tx,updated,user.id,attendeeIds,"updated");
        await tx.insert(calendarActivity).values({
          eventId,actorId:user.id,action:next.status==="cancelled"?"cancelled":"updated",
          oldValues:before,newValues:next,reason:reason??null,
        });
        return updated;
      });
      return void res.json(eventDto(saved,attendeeIds));
    } catch(error) {
      if(error instanceof CalendarConflictError)
        return void res.status(409).json({message:"This event conflicts with another booking. Review the conflict or enter an authorized override reason.",conflicts:error.conflicts});
      return void res.status(409).json({message:"Event could not be updated. Refresh and review its current state."});
    }
  });

  app.get("/api/calendar/resources",requireLmsUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    if(!req.lmsUser!.roles.some(r=>["admin","operations","academic_coordinator","trainer"].includes(r)))
      return void res.json([]);
    const rows=await db.select().from(calendarResources).where(eq(calendarResources.active,true)).orderBy(asc(calendarResources.name));
    return void res.json(rows);
  });

  app.post("/api/calendar/resources",requireLmsUser,sameOriginCapture,async(req,res)=>{
    if(!req.lmsUser!.roles.some(r=>["admin","operations","academic_coordinator"].includes(r)))
      return void res.status(403).json({message:"You cannot manage calendar resources."});
    const parsed=z.object({name:z.string().trim().min(1).max(120),kind:z.enum(["classroom","lab","equipment","location","other"]),
      location:z.string().max(200).nullable().optional(),capacity:z.number().int().positive().nullable().optional()}).strict().safeParse(req.body);
    if(!parsed.success) return void res.status(400).json({message:"Enter valid resource details."});
    const [resource]=await db.insert(calendarResources).values({...parsed.data,createdBy:req.lmsUser!.id}).returning();
    return void res.status(201).json(resource);
  });

  app.get("/api/calendar/batches",requireLmsUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const user=req.lmsUser!;
    if(!user.roles.some(role=>["admin","academic_coordinator","trainer","student"].includes(role))) return void res.json([]);
    let rows=await db.select().from(calendarBatches).orderBy(asc(calendarBatches.startsAt));
    if(user.roles.includes("student")&&!user.roles.some(role=>["admin","academic_coordinator","trainer"].includes(role))) {
      const memberships=await db.select({batchId:calendarBatchStudents.batchId}).from(calendarBatchStudents)
        .where(eq(calendarBatchStudents.studentId,user.id));
      const ids=new Set(memberships.map(item=>item.batchId));
      rows=rows.filter(item=>ids.has(item.id));
    }
    return void res.json(rows);
  });
  app.post("/api/calendar/batches",requireLmsUser,sameOriginCapture,async(req,res)=>{
    if(!req.lmsUser!.roles.some(role=>["admin","academic_coordinator"].includes(role)))
      return void res.status(403).json({message:"You cannot manage training batches."});
    const parsed=z.object({
      courseId:z.number().int().positive(),name:z.string().trim().min(1).max(120),
      startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}).nullable().optional(),
      timezone:z.string().max(80).default("Asia/Kolkata"),status:z.enum(["planned","active","completed","cancelled"]).default("planned"),
      studentIds:z.array(z.number().int().positive()).max(500).default([]),
    }).strict().safeParse(req.body);
    if(!parsed.success) return void res.status(400).json({message:"Enter valid batch details."});
    if(parsed.data.endsAt&&new Date(parsed.data.endsAt)<=new Date(parsed.data.startsAt))
      return void res.status(400).json({message:"The batch end must follow its start."});
    try {
      const [batch]=await db.transaction(async tx=>{
        const [created]=await tx.insert(calendarBatches).values({
          courseId:parsed.data.courseId,name:parsed.data.name,startsAt:new Date(parsed.data.startsAt),
          endsAt:parsed.data.endsAt?new Date(parsed.data.endsAt):null,timezone:parsed.data.timezone,
          status:parsed.data.status,createdBy:req.lmsUser!.id,
        }).returning();
        if(parsed.data.studentIds.length) await tx.insert(calendarBatchStudents).values(parsed.data.studentIds.map(studentId=>({
          batchId:created.id,studentId,assignedBy:req.lmsUser!.id,
        }))).onConflictDoNothing();
        await tx.insert(calendarActivity).values({actorId:req.lmsUser!.id,action:"batch.created",newValues:{batchId:created.id}});
        return [created];
      });
      return void res.status(201).json(batch);
    } catch {
      return void res.status(400).json({message:"The batch could not be saved. Check the course and student records."});
    }
  });

  app.get("/api/calendar/availability",requireLmsUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const user=req.lmsUser!;
    const target=z.coerce.number().int().positive().optional().safeParse(req.query.userId);
    if(!target.success) return void res.status(400).json({message:"Staff filter is invalid."});
    const canSeeAll=user.roles.some(role=>["admin","academic_coordinator","operations"].includes(role));
    if(!canSeeAll&&(!user.roles.includes("trainer")||target.data&&target.data!==user.id))
      return void res.status(403).json({message:"You cannot view this staff availability."});
    const rows=await db.select().from(staffAvailability).where(and(
      eq(staffAvailability.active,true),
      canSeeAll&&target.data?eq(staffAvailability.userId,target.data):canSeeAll?undefined:eq(staffAvailability.userId,user.id),
    )).orderBy(asc(staffAvailability.weekday),asc(staffAvailability.startsAtLocal));
    return void res.json(rows);
  });
  app.post("/api/calendar/availability",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const user=req.lmsUser!;
    const parsed=z.object({
      userId:z.number().int().positive().optional(),weekday:z.number().int().min(0).max(6),
      startsAtLocal:z.string().regex(/^\d{2}:\d{2}$/),endsAtLocal:z.string().regex(/^\d{2}:\d{2}$/),
      timezone:z.string().max(80).default("Asia/Kolkata"),
      effectiveFrom:z.string().datetime({offset:true}).nullable().optional(),
      effectiveUntil:z.string().datetime({offset:true}).nullable().optional(),
    }).strict().safeParse(req.body);
    if(!parsed.success||parsed.data.startsAtLocal>=parsed.data.endsAtLocal)
      return void res.status(400).json({message:"Enter a valid availability window."});
    const manager=user.roles.some(role=>["admin","academic_coordinator","operations"].includes(role));
    const target=parsed.data.userId??user.id;
    if(!manager&&(!user.roles.includes("trainer")||target!==user.id))
      return void res.status(403).json({message:"You can only update your own availability."});
    const [targetRole]=await db.select({role:lmsUserRoles.role}).from(lmsUserRoles).where(eq(lmsUserRoles.userId,target)).limit(1);
    if(!targetRole||!["admin","trainer","admissions","academic_coordinator","operations"].includes(targetRole.role))
      return void res.status(400).json({message:"Availability must belong to an active staff account."});
    try {
      const [row]=await db.insert(staffAvailability).values({
        userId:target,weekday:parsed.data.weekday,startsAtLocal:parsed.data.startsAtLocal,
        endsAtLocal:parsed.data.endsAtLocal,timezone:parsed.data.timezone,
        effectiveFrom:parsed.data.effectiveFrom?new Date(parsed.data.effectiveFrom):null,
        effectiveUntil:parsed.data.effectiveUntil?new Date(parsed.data.effectiveUntil):null,
        createdBy:user.id,
      }).returning();
      await db.insert(calendarActivity).values({actorId:user.id,action:"availability.created",newValues:{availabilityId:row.id,userId:target}});
      return void res.status(201).json(row);
    } catch { return void res.status(400).json({message:"Availability could not be saved."}); }
  });
  app.post("/api/calendar/availability-exceptions",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const user=req.lmsUser!;
    const parsed=z.object({
      userId:z.number().int().positive().nullable().optional(),resourceId:z.number().int().positive().nullable().optional(),
      startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}),
      kind:z.enum(["unavailable","leave","maintenance","available_override"]),reason:z.string().trim().max(500).nullable().optional(),
    }).strict().safeParse(req.body);
    if(!parsed.success||Boolean(parsed.data.userId)===Boolean(parsed.data.resourceId)||new Date(parsed.data.endsAt)<=new Date(parsed.data.startsAt))
      return void res.status(400).json({message:"Choose one staff member or resource and a valid time range."});
    const manager=user.roles.some(role=>["admin","academic_coordinator","operations"].includes(role));
    if(parsed.data.userId&&parsed.data.userId!==user.id&&!manager)
      return void res.status(403).json({message:"You cannot change another staff member’s availability."});
    if(parsed.data.resourceId&&!user.roles.some(role=>["admin","academic_coordinator","operations"].includes(role)))
      return void res.status(403).json({message:"You cannot manage resource availability."});
    const [row]=await db.insert(availabilityExceptions).values({
      userId:parsed.data.userId??null,resourceId:parsed.data.resourceId??null,
      startsAt:new Date(parsed.data.startsAt),endsAt:new Date(parsed.data.endsAt),kind:parsed.data.kind,
      reason:parsed.data.reason??null,createdBy:user.id,
    }).returning();
    await db.insert(calendarActivity).values({actorId:user.id,action:"availability.exception_created",
      newValues:{exceptionId:row.id,userId:row.userId,resourceId:row.resourceId,kind:row.kind}});
    return void res.status(201).json(row);
  });

  app.get("/api/calendar/inbox",requireLmsUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const [preference]=await db.select({inAppEnabled:notificationPreferences.inAppEnabled}).from(notificationPreferences).where(and(
      eq(notificationPreferences.userId,req.lmsUser!.id),eq(notificationPreferences.category,"default"),
    )).limit(1);
    if(preference?.inAppEnabled===false) return void res.json({items:[],unreadCount:0});
    const rows=await db.select().from(lmsNotifications).where(eq(lmsNotifications.userId,req.lmsUser!.id))
      .orderBy(sql`${lmsNotifications.createdAt} DESC`).limit(100);
    return void res.json({items:rows,unreadCount:rows.filter(row=>!row.readAt).length});
  });
  app.post("/api/calendar/inbox/:id/read",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const id=z.coerce.number().int().positive().safeParse(req.params.id);
    if(!id.success) return void res.status(400).json({message:"Notification ID is invalid."});
    await db.update(lmsNotifications).set({readAt:new Date()})
      .where(and(eq(lmsNotifications.id,id.data),eq(lmsNotifications.userId,req.lmsUser!.id)));
    return void res.json({saved:true});
  });
  app.post("/api/calendar/inbox/read-all",requireLmsUser,sameOriginCapture,async(req,res)=>{
    await db.update(lmsNotifications).set({readAt:new Date()})
      .where(and(eq(lmsNotifications.userId,req.lmsUser!.id),sql`${lmsNotifications.readAt} IS NULL`));
    return void res.json({saved:true});
  });

  app.get("/api/calendar/preferences",requireLmsUser,async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const [preference]=await db.select().from(notificationPreferences).where(and(
      eq(notificationPreferences.userId,req.lmsUser!.id),eq(notificationPreferences.category,"default"),
    )).limit(1);
    const [subscription]=await db.select({id:pushSubscriptions.id}).from(pushSubscriptions).where(and(
      eq(pushSubscriptions.userId,req.lmsUser!.id),eq(pushSubscriptions.active,true),
      or(sql`${pushSubscriptions.expirationTime} IS NULL`,gt(pushSubscriptions.expirationTime,new Date())),
    )).limit(1);
    return void res.json({
      inAppEnabled:preference?.inAppEnabled??true,pushEnabled:Boolean(subscription),
      quietHoursStart:preference?.quietHoursStart??null,quietHoursEnd:preference?.quietHoursEnd??null,
      timezone:preference?.timezone??"Asia/Kolkata",reminderOffsetsMinutes:preference?.reminderOffsetsMinutes??[1440,120],
    });
  });
  app.patch("/api/calendar/preferences",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const parsed=z.object({
      inAppEnabled:z.boolean().optional(),quietHoursStart:z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      quietHoursEnd:z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      timezone:z.string().max(80).optional(),reminderOffsetsMinutes:z.array(z.number().int().min(5).max(10080)).max(8).optional(),
    }).strict().safeParse(req.body);
    if(!parsed.success) return void res.status(400).json({message:"Notification preferences are invalid."});
    const [preference]=await db.insert(notificationPreferences).values({
      userId:req.lmsUser!.id,category:"default",...parsed.data,
    }).onConflictDoUpdate({target:[notificationPreferences.userId,notificationPreferences.category],
      set:{...parsed.data,updatedAt:new Date()}}).returning();
    return void res.json({inAppEnabled:preference.inAppEnabled,pushEnabled:true,
      quietHoursStart:preference.quietHoursStart,quietHoursEnd:preference.quietHoursEnd,
      timezone:preference.timezone,reminderOffsetsMinutes:preference.reminderOffsetsMinutes});
  });

  app.get("/api/calendar/push/public-key",requireLmsUser,async(_req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const config=getPushConfiguration();
    return void res.json({publicKey:config.configured?config.publicKey:null});
  });
  app.post("/api/calendar/push/subscriptions",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const parsed=z.object({
      subscription:z.object({endpoint:z.string().url().max(3000),expirationTime:z.string().datetime({offset:true}).nullable().optional(),
        keys:z.object({p256dh:z.string().min(16).max(256),auth:z.string().min(8).max(256)}).strict()}).strict(),
      deviceLabel:z.string().trim().min(1).max(80).default("This device"),appScope:z.enum(["admin","learn"]),
    }).strict().safeParse(req.body);
    if(!parsed.success||!getPushConfiguration().configured) return void res.status(400).json({message:"Push setup is not available."});
    if(!isTrustedPushEndpoint(parsed.data.subscription.endpoint)) return void res.status(400).json({message:"Push endpoint is not supported."});
    const endpointHash=pushEndpointHash(parsed.data.subscription.endpoint);
    const encrypted=encryptSubscription(parsed.data.subscription);
    const [existing]=await db.select({id:pushSubscriptions.id,userId:pushSubscriptions.userId}).from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpointHash,endpointHash)).limit(1);
    if(existing&&existing.userId!==req.lmsUser!.id)
      await db.update(pushSubscriptions).set({active:false,updatedAt:new Date()}).where(eq(pushSubscriptions.id,existing.id));
    const [saved]=await db.insert(pushSubscriptions).values({
      userId:req.lmsUser!.id,endpointHash,subscriptionCiphertext:encrypted.ciphertext,nonce:encrypted.nonce,
      appScope:parsed.data.appScope,deviceLabel:parsed.data.deviceLabel,
      expirationTime:parsed.data.subscription.expirationTime?new Date(parsed.data.subscription.expirationTime):null,
    }).onConflictDoUpdate({target:pushSubscriptions.endpointHash,set:{
      userId:req.lmsUser!.id,subscriptionCiphertext:encrypted.ciphertext,nonce:encrypted.nonce,appScope:parsed.data.appScope,
      deviceLabel:parsed.data.deviceLabel,expirationTime:parsed.data.subscription.expirationTime?new Date(parsed.data.subscription.expirationTime):null,
      active:true,updatedAt:new Date(),
    }}).returning({id:pushSubscriptions.id,deviceLabel:pushSubscriptions.deviceLabel,appScope:pushSubscriptions.appScope});
    return void res.status(201).json({subscribed:true,device:saved});
  });
  app.delete("/api/calendar/push/subscriptions",requireLmsUser,sameOriginCapture,async(req,res)=>{
    const parsed=z.object({endpoint:z.string().url().max(3000)}).strict().safeParse(req.body);
    if(!parsed.success) return void res.status(400).json({message:"Subscription is invalid."});
    await db.update(pushSubscriptions).set({active:false,updatedAt:new Date()}).where(and(
      eq(pushSubscriptions.userId,req.lmsUser!.id),eq(pushSubscriptions.endpointHash,pushEndpointHash(parsed.data.endpoint)),
    ));
    return void res.json({subscribed:false});
  });
}

export async function findConflicts(input:any,actorId:number,ignoreId?:string) {
  const start=new Date(input.startsAt);
  const end=input.endsAt?new Date(input.endsAt):new Date(start.getTime()+60*60_000);
  const attendees:number[]=input.attendeeIds??[];
  const {rows}=await pool.query(`SELECT e.id,e.title,e.starts_at,e.ends_at,e.resource_id,e.trainer_id
    FROM calendar_events e
    WHERE e.status NOT IN ('cancelled','completed') AND e.starts_at<$2 AND COALESCE(e.ends_at,e.starts_at+interval '1 hour')>$1
      AND ($3::uuid IS NULL OR e.id<>$3)
      AND (($4::int IS NOT NULL AND e.resource_id=$4) OR ($5::int IS NOT NULL AND e.trainer_id=$5)
        OR ($6::int IS NOT NULL AND e.owner_id=$6)
        OR ($8::uuid IS NOT NULL AND e.lead_id=$8)
        OR ($9::int IS NOT NULL AND e.inquiry_id=$9)
        OR EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.event_id=e.id AND (
          a.user_id=ANY($7::int[]) OR ($8::uuid IS NOT NULL AND a.lead_id=$8)
          OR ($9::int IS NOT NULL AND a.inquiry_id=$9))))`,
    [start,end,ignoreId??null,input.resourceId??null,input.trainerId??null,input.ownerId??actorId,attendees,input.leadId??null,input.inquiryId??null]);
  const warnings=rows.map(()=> "The selected resource, staff member, or attendee has an overlapping event.");
  if(input.trainerId) {
    const sessions=await pool.query(`SELECT id,title,starts_at FROM lms_live_sessions
      WHERE trainer_id=$1 AND status='scheduled' AND starts_at<$3
        AND COALESCE(ends_at,starts_at+interval '1 hour')>$2`,[input.trainerId,start,end]);
    for(const _session of sessions.rows) warnings.push("The selected trainer has an overlapping LMS session.");
  }
  if(attendees.length) {
    const sessions=await pool.query(`SELECT DISTINCT s.id,s.title,s.starts_at FROM lms_live_sessions s
      JOIN lms_enrollments e ON e.course_id=s.course_id AND e.status='active'
      WHERE e.student_id=ANY($1::int[]) AND s.status='scheduled' AND s.starts_at<$3
        AND COALESCE(s.ends_at,s.starts_at+interval '1 hour')>$2`,[attendees,start,end]);
    for(const _session of sessions.rows) warnings.push("An attendee has an overlapping LMS session.");
  }
  if(input.resourceId) {
    const exceptions=await db.select().from(availabilityExceptions).where(and(
      eq(availabilityExceptions.resourceId,input.resourceId),lt(availabilityExceptions.startsAt,end),gt(availabilityExceptions.endsAt,start),
    ));
    for(const item of exceptions.filter(item=>item.kind!=="available_override")) warnings.push("The selected resource is unavailable during this time.");
  }
  const possibleStaff=Array.from(new Set<number>([
    ...(input.trainerId?[input.trainerId]:[]),...(input.ownerId?[input.ownerId]:[]),...(input.attendeeIds??[]),
  ]));
  if(possibleStaff.length) {
    const staffRows=await db.select({userId:lmsUserRoles.userId,role:lmsUserRoles.role}).from(lmsUserRoles)
      .where(inArray(lmsUserRoles.userId,possibleStaff));
    const staffIds=Array.from(new Set(staffRows.filter(row=>["admin","trainer","admissions","academic_coordinator","operations"].includes(row.role)).map(row=>row.userId)));
    for(const staffId of staffIds) {
      const exceptions=await db.select().from(availabilityExceptions).where(and(
        eq(availabilityExceptions.userId,staffId),lt(availabilityExceptions.startsAt,end),gt(availabilityExceptions.endsAt,start),
      ));
      const activeException=exceptions.find(item=>item.kind!=="available_override");
      if(activeException) warnings.push("The selected staff member is unavailable during this time.");
      if(exceptions.some(item=>item.kind==="available_override")) continue;
      const windows=await db.select().from(staffAvailability).where(and(
        eq(staffAvailability.userId,staffId),eq(staffAvailability.active,true),
      ));
      if(!windows.length) continue;
      const timezone=windows[0].timezone;
      const startParts=localScheduleParts(start,timezone);
      const endParts=localScheduleParts(end,timezone);
      const applies=windows.some(window=>{
        const effectiveFrom=!window.effectiveFrom||window.effectiveFrom<=start;
        const effectiveUntil=!window.effectiveUntil||window.effectiveUntil>=end;
        return window.weekday===startParts.weekday&&effectiveFrom&&effectiveUntil&&
          startParts.date===endParts.date&&startParts.time>=window.startsAtLocal&&endParts.time<=window.endsAtLocal;
      });
      if(!applies) warnings.push(`Staff member is outside their saved availability window (${timezone}).`);
    }
  }
  return warnings;
}

