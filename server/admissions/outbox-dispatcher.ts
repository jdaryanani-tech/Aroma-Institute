import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { followUpSchemaReady, readLeadFollowUpStatus, type FollowUpDatabase } from "./follow-up";
import { VSL_WEBHOOK_HEADER, VSL_WEBHOOK_SECRET_ENV } from "./follow-up-routes";

export const VSL_WEBHOOK_URL_ENV="N8N_VSL_REGISTRATION_WEBHOOK_URL";
export const VSL_DISPATCH_DEFAULT_ENABLED=false;
export const VSL_MAX_ATTEMPTS=8;
export const VSL_LEASE_MS=60_000;
export const vslRetryDelayMs=(attempt:number)=>Math.min(24*60*60*1000,30_000*2**Math.max(0,attempt-1));

export function isTrustedVslWebhookUrl(value:string) {
  if(value!==value.trim()) return false;
  try {
    const u=new URL(value);
    return u.protocol==="https:" && u.hostname==="n8n.aromacafeinstitute.in"
      && !u.port && !u.username && !u.password && !u.search && !u.hash
      && /^\/webhook\/[A-Za-z0-9_-]+$/.test(u.pathname)
      && !["/webhook/counselling-submission","/webhook/aroma-whatsapp"].includes(u.pathname);
  } catch {return false;}
}

/** One explicitly invoked batch item, NOT a startup worker or scheduled workflow.
 * The default native transport is blocked outside production. Tests inject fake
 * transports. Merely adding environment settings never activates this dispatcher.
 */
export async function dispatchVslRegistrationOnce(options:{
  enabled?:boolean;database?:FollowUpDatabase;transport?:typeof fetch;now?:()=>Date;
  configuration?:{url:string;secret:string};
}={}) {
  if(!(options.enabled ?? VSL_DISPATCH_DEFAULT_ENABLED)) return {state:"disabled" as const};
  if(process.env.NODE_ENV!=="production" && !options.transport)
    return {state:"disabled" as const,reason:"Development network delivery is disabled."};
  const config=options.configuration ?? {
    url:process.env[VSL_WEBHOOK_URL_ENV] ?? "",secret:process.env[VSL_WEBHOOK_SECRET_ENV] ?? "",
  };
  if(!config.url || !config.secret.trim()) return {state:"unconfigured" as const};
  if(!isTrustedVslWebhookUrl(config.url)) return {state:"invalid_configuration" as const};
  const database=options.database ?? db,clock=options.now ?? (()=>new Date()),now=clock();
  if(!await followUpSchemaReady(database)) return {state:"schema_unavailable" as const};
  const expired=new Date(now.getTime()-VSL_LEASE_MS);
  await database.execute(sql`UPDATE admissions_registration_outbox
    SET state='failed',last_error='Worker lease expired; retry limit reached.',locked_at=NULL,lock_token=NULL
    WHERE state='sending' AND locked_at<${expired} AND attempt_count>=${VSL_MAX_ATTEMPTS}`);
  const token=randomUUID();
  const claimed=await database.execute<{
    id:string;lead_id:string;idempotency_key:string;payload:Record<string,unknown>;attempt_count:number;
  }>(sql`UPDATE admissions_registration_outbox SET
    state='sending',lock_token=${token}::uuid,locked_at=${now},last_attempt_at=${now},attempt_count=attempt_count+1
    WHERE id=(SELECT id FROM admissions_registration_outbox
      WHERE attempt_count<${VSL_MAX_ATTEMPTS} AND (
        (state IN ('pending','failed') AND available_at<=${now}) OR (state='sending' AND locked_at<${expired}))
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id,lead_id,idempotency_key,payload,attempt_count`);
  const row=claimed.rows[0];
  if(!row) return {state:"idle" as const};
  let httpStatus:number|null=null,acknowledged=false,error:string|null=null;
  try {
    const status=await readLeadFollowUpStatus(row.lead_id,database);
    if(!status) throw new Error("missing_lead");
    // Never replay an old grant after an opt-out. The stored first-event payload
    // stays immutable; its outbound consent view is refreshed before each attempt.
    const payload={...row.payload,consentToContact:status.consent.whatsappAdmissions.allowed,
      consent:status.consent.whatsappAdmissions};
    const response=await (options.transport ?? fetch)(config.url,{
      method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10_000),
      headers:{"Content-Type":"application/json",[VSL_WEBHOOK_HEADER]:config.secret.trim(),
        "Idempotency-Key":row.idempotency_key},
      body:JSON.stringify(payload),
    });
    httpStatus=response.status;
    if(!response.ok) error=`HTTP ${response.status}: webhook rejected event.`;
    else {
      let body:unknown;
      try {body=await response.json();} catch {error="Webhook returned invalid JSON.";}
      acknowledged=!!body && typeof body==="object" && "received" in body && body.received===true
        && "eventId" in body && body.eventId===row.idempotency_key;
      if(!acknowledged && !error) error="Webhook did not acknowledge the matching event ID.";
    }
  } catch(e) {
    error=e instanceof Error && ["AbortError","TimeoutError"].includes(e.name)
      ? "Webhook request timed out." : "Webhook request failed.";
  }
  const responseAt=clock(),state=acknowledged ? "acknowledged" : "failed";
  const nextAt=new Date(responseAt.getTime()+vslRetryDelayMs(row.attempt_count));
  const result=await database.execute(sql`UPDATE admissions_registration_outbox SET
    state=${state},response_at=${responseAt},acknowledged_at=${acknowledged ? responseAt : null},
    last_http_status=${httpStatus},last_error=${error},available_at=${nextAt},
    locked_at=NULL,lock_token=NULL
    WHERE id=${row.id}::uuid AND lock_token=${token}::uuid RETURNING id`);
  return {state:result.rows.length ? state : "lease_lost",eventId:row.idempotency_key,
    httpStatus,attemptCount:row.attempt_count,error};
}
