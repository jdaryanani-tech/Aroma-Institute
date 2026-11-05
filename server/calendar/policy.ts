export type CalendarRole = "student" | "trainer" | "admin" | "admissions" | "academic_coordinator" | "operations";
export type CalendarViewer = { id:number; roles:CalendarRole[] };

export function canSeeCalendarCategory(user:CalendarViewer,category:string) {
  const roles=user.roles;
  if(roles.includes("admin")) return true;
  if(category==="admissions") return roles.includes("admissions");
  if(category==="academic"||category==="student") return roles.some(role=>["academic_coordinator","trainer","student"].includes(role));
  if(category==="workshops") return roles.some(role=>["admissions","academic_coordinator","operations","trainer","student"].includes(role));
  if(category==="staff") return roles.includes("operations")||roles.includes("academic_coordinator");
  if(category==="operations") return roles.includes("operations");
  return false;
}

export function canManageCalendarCategory(user:CalendarViewer,category:string,trainerId?:number|null) {
  const roles=user.roles;
  if(roles.includes("admin")) return true;
  if(category==="admissions") return roles.includes("admissions");
  if(category==="academic") return roles.includes("academic_coordinator")||(roles.includes("trainer")&&trainerId===user.id);
  if(category==="student") return roles.includes("academic_coordinator");
  if(category==="workshops") return roles.includes("academic_coordinator")||roles.includes("operations");
  if(category==="staff"||category==="operations") return roles.includes("operations");
  return false;
}

export function canViewCalendarEvent(user:CalendarViewer,event:{
  category:string;ownerId:number|null;trainerId:number|null;studentId:number|null;
  courseId:number|null;batchId:number|null;attendeeIds:number[];
},studentCourseIds:ReadonlySet<number>=new Set(),studentBatchIds:ReadonlySet<number>=new Set()) {
  if(!canSeeCalendarCategory(user,event.category)) return false;
  if(user.roles.includes("admin")) return true;
  if(user.roles.includes("student")&&(
    event.studentId===user.id||event.attendeeIds.includes(user.id)||
    (event.courseId!==null&&studentCourseIds.has(event.courseId))||
    (event.batchId!==null&&studentBatchIds.has(event.batchId))
  )) return true;
  if(user.roles.includes("trainer")&&(event.trainerId===user.id||event.attendeeIds.includes(user.id))) return true;
  if(user.roles.includes("admissions")&&event.category==="admissions"&&(event.ownerId===user.id||event.attendeeIds.includes(user.id))) return true;
  if(user.roles.includes("academic_coordinator")||user.roles.includes("operations")) return true;
  return false;
}

export function expandCalendarRecurrence(event:any,start:Date,end:Date) {
  const rule=event.recurrence;
  if(!rule) return event.startsAt<end.toISOString()&&(event.endsAt??event.startsAt)>=start.toISOString()?[event]:[];
  const base=new Date(event.startsAt),until=rule.until?new Date(rule.until):end;
  const duration=event.endsAt?new Date(event.endsAt).getTime()-base.getTime():0;
  const interval=Math.max(1,Number(rule.interval)||1);
  let cursor=new Date(base);
  const dayMs=86_400_000;
  if(start>base&&rule.frequency==="daily") cursor.setUTCDate(cursor.getUTCDate()+Math.max(0,Math.floor((start.getTime()-base.getTime())/dayMs/interval)-1)*interval);
  if(start>base&&rule.frequency==="weekly") cursor.setUTCDate(cursor.getUTCDate()+Math.max(0,Math.floor((start.getTime()-base.getTime())/(dayMs*7*interval))-1)*interval*7);
  if(start>base&&rule.frequency==="monthly") {
    const months=(start.getUTCFullYear()-base.getUTCFullYear())*12+start.getUTCMonth()-base.getUTCMonth();
    cursor.setUTCMonth(cursor.getUTCMonth()+Math.max(0,Math.floor(months/interval)-1)*interval);
  }
  const out:any[]=[];let guard=0;
  while(cursor<=until&&cursor<end&&guard++<1000) {
    if(cursor>=start) out.push({...event,id:`${event.id}@${cursor.toISOString()}`,startsAt:cursor.toISOString(),endsAt:duration?new Date(cursor.getTime()+duration).toISOString():null});
    if(rule.frequency==="daily") cursor.setUTCDate(cursor.getUTCDate()+interval);
    else if(rule.frequency==="weekly") cursor.setUTCDate(cursor.getUTCDate()+interval*7);
    else cursor.setUTCMonth(cursor.getUTCMonth()+interval);
  }
  return out;
}

export function quietHoursDelayMinutes(now:Date,timezone:string,start:string|null,end:string|null) {
  if(!start||!end||start===end) return 0;
  const local=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);
  const current=Number(local.slice(0,2))*60+Number(local.slice(3));
  const startMinute=Number(start.slice(0,2))*60+Number(start.slice(3));
  const endMinute=Number(end.slice(0,2))*60+Number(end.slice(3));
  const quiet=startMinute<endMinute?current>=startMinute&&current<endMinute:current>=startMinute||current<endMinute;
  return quiet?(endMinute-current+1440)%1440||1440:0;
}

export const reminderRetryDelayMs=(attempt:number)=>Math.min(3_600_000,30_000*2**Math.max(0,attempt-1));
