/**
 * Read-only readiness report for the currently configured WORKSPACE database.
 * Never sets configuration, runs DDL, prints connection strings, or targets production.
 * Production comparison uses Replit's read-only schema-diff tooling before Publish.
 */
import { pool } from "../server/db";

const required: Record<string,string[]> = {
  inquiries:["lead_id","counselling_delivery_last_verified_at","counselling_delivery_last_verified_by"],
  admissions_leads:["id","canonical_phone","registered_at"],
  admissions_vsl_events:["lead_id","event","occurred_at"],
  admissions_crm_profiles:["inquiry_id","stage","stage_evidence","owner_id","follow_up_at","version"],
  admissions_crm_activities:["id","inquiry_id","actor_id","type","occurred_at"],
};
try {
  const {rows}=await pool.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`,[Object.keys(required)]);
  const missing=Object.entries(required).flatMap(([table,columns])=>
    columns.filter(column=>!rows.some(r=>r.table_name===table&&r.column_name===column)).map(column=>`${table}.${column}`));
  const expectedTypes:Record<string,string>={
    "inquiries.lead_id":"uuid",
    "inquiries.counselling_delivery_last_verified_at":"timestamp with time zone",
    "inquiries.counselling_delivery_last_verified_by":"integer",
  };
  const incompatible=rows.filter(r=>{
    const expected=expectedTypes[`${r.table_name}.${r.column_name}`];return expected&&r.data_type!==expected;
  }).map(r=>`${r.table_name}.${r.column_name}`);
  console.log(JSON.stringify({ready:!missing.length&&!incompatible.length,missing,incompatible,
    advice:"No changes made. Use additive development migrations and review the managed Publish schema diff; never replay the historical migration ledger blindly."},null,2));
  if(missing.length||incompatible.length) process.exitCode=1;
} catch {console.error("Read-only CRM schema check failed; connection details withheld.");process.exitCode=1;}
finally {await pool.end();}
