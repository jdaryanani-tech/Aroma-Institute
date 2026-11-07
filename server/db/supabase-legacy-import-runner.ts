import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { pool } from "../db";
import { createSupabaseMigrationConnection } from "./supabase-migration";
import { signatureMatchesDocument } from "./aichm-migration-engine";
import {
  classifyLegacyLead, emptyLegacyImportCounts, legacyLeadProfile, planLegacyConversation,
  planLegacyKnowledge, type LegacyConversation, type LegacyKnowledge, type SupabaseLegacyLead,
} from "./supabase-legacy-import";

type ReviewDecision = { sourceLeadId: string; decision: "link" | "hold"; targetLeadId?: string };
type ReconciliationManifest = {
  version: 1;
  sourceProject: "xylqezjvqqqjozenuygh";
  approved: true;
  decisions: ReviewDecision[];
};
type SignedReconciliationManifest = { document: ReconciliationManifest; signature: string };
type ImportOptions = { apply?: boolean; manifestPath?: string };
type ImportEnvironment = Record<string, string | undefined>;

const safeCount = (value: unknown) => Number(value ?? 0);
const hashPayload = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function parseManifest(raw: string, publicKey: string | undefined): ReconciliationManifest {
  const signed = JSON.parse(raw) as Partial<SignedReconciliationManifest>;
  if (!publicKey || !signed.document || !signed.signature || !signatureMatchesDocument(
    signed as SignedReconciliationManifest, publicKey,
  )) throw new Error("reconciliation_manifest_invalid");
  const value = signed.document as Partial<ReconciliationManifest>;
  if (value.version !== 1 || value.sourceProject !== "xylqezjvqqqjozenuygh"
    || value.approved !== true || !Array.isArray(value.decisions)) {
    throw new Error("reconciliation_manifest_invalid");
  }
  const seen = new Set<string>();
  for (const row of value.decisions) {
    if (!row || !/^[0-9a-f-]{36}$/i.test(row.sourceLeadId) || !["link", "hold"].includes(row.decision)
      || (row.decision === "link" && !/^[0-9a-f-]{36}$/i.test(row.targetLeadId ?? ""))
      || seen.has(row.sourceLeadId)) throw new Error("reconciliation_manifest_invalid");
    seen.add(row.sourceLeadId);
  }
  return value as ReconciliationManifest;
}

export function assertLegacyImportApplyGate(
  options: ImportOptions,
  environment: ImportEnvironment = process.env,
) {
  if (options.apply !== true) return;
  if (environment.AICHM_SUPABASE_LEGACY_IMPORT_ENABLED !== "true"
    || !options.manifestPath
    || !environment.AICHM_MIGRATION_APPROVAL_PUBLIC_KEY
    || environment.AICHM_SUPABASE_LEGACY_IMPORT_TARGET !== "production"
    || environment.NODE_ENV !== "production") {
    throw new Error("apply_prerequisites_missing");
  }
}

async function assertDatabaseSeparation(source: PoolClient, target: PoolClient) {
  const [s, t] = await Promise.all([
    source.query(`SELECT current_database() database_name, inet_server_addr()::text host`),
    target.query(`SELECT current_database() database_name, inet_server_addr()::text host`),
  ]);
  const sourceId = `${s.rows[0]?.database_name}:${s.rows[0]?.host}`;
  const targetId = `${t.rows[0]?.database_name}:${t.rows[0]?.host}`;
  if (!s.rows[0]?.host || !t.rows[0]?.host || sourceId === targetId) throw new Error("source_target_identity_not_distinct");
  if (String(s.rows[0]?.database_name) !== "postgres") throw new Error("supabase_source_identity_mismatch");
}

async function requireTargetSchema(client: PoolClient) {
  const { rows: [row] } = await client.query(`SELECT
    to_regclass('admissions_leads') IS NOT NULL AND
    to_regclass('admissions_legacy_lead_links') IS NOT NULL AND
    to_regclass('admissions_conversation_messages') IS NOT NULL AND
    to_regclass('lms_course_knowledge') IS NOT NULL AS ready`);
  if (!row?.ready) throw new Error("target_schema_not_ready");
}

/**
 * Read-only by default. Apply requires explicit CLI mode, a reviewed
 * reconciliation manifest, and a separate disabled-by-default environment
 * gate. Supabase is opened through the strict TLS migration factory; Replit's
 * current DATABASE_URL is the target and remains the app runtime database.
 */
export async function runSupabaseLegacyImport(options: ImportOptions = {}) {
  const apply = options.apply === true;
  assertLegacyImportApplyGate(options);
  const manifest = apply ? parseManifest(
    await readFile(options.manifestPath!, "utf8"),
    process.env.AICHM_MIGRATION_APPROVAL_PUBLIC_KEY,
  ) : null;
  const sourceConnection = createSupabaseMigrationConnection();
  const source = await sourceConnection.pool.connect();
  const target = await pool.connect();
  let sourceTransaction = false, targetTransaction = false;
  try {
    await assertDatabaseSeparation(source, target);
    await requireTargetSchema(target);
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    sourceTransaction = true;
    const [counts, sourceLeads, targetLeads, existingLinks, sourceConversations, targetMessages, sourceKnowledge, targetKnowledge] = await Promise.all([
      source.query(`SELECT
        (SELECT count(*)::integer FROM public.leads) leads,
        (SELECT count(*)::integer FROM public.conversations) conversations,
        (SELECT count(*)::integer FROM public.course_knowledge) course_knowledge`),
      source.query(`SELECT id,phone,name,created_at,lead_type,intent,city,experience,cafe_plan,timeline,lead_score,
        appointment_status,appointment_date,appointment_time,conversation_status,last_message_at
        FROM public.leads ORDER BY id`),
      target.query(`SELECT id,canonical_phone FROM admissions_leads`),
      target.query(`SELECT source_lead_id,lead_id,match_status FROM admissions_legacy_lead_links WHERE source_system='supabase_aichm'`),
      source.query(`SELECT id,lead_id,phone,direction,message_type,created_at,
        (message IS NOT NULL AND btrim(message)<>'') has_message,
        (ai_response IS NOT NULL AND btrim(ai_response)<>'') has_ai_response
        FROM public.conversations ORDER BY id`),
      target.query(`SELECT source_record_id,source_message_side FROM admissions_conversation_messages
        WHERE source_system='supabase_aichm'`),
      source.query(`SELECT id,slug FROM public.course_knowledge ORDER BY id`),
      target.query(`SELECT id,source_record_id,slug FROM lms_course_knowledge`),
    ]);
    const report = emptyLegacyImportCounts();
    report.source = {
      leads: safeCount(counts.rows[0].leads),
      conversations: safeCount(counts.rows[0].conversations),
      courseKnowledge: safeCount(counts.rows[0].course_knowledge),
    };
    report.target = {
      leads: targetLeads.rowCount ?? 0,
      messages: safeCount((await target.query(`SELECT count(*)::integer n FROM admissions_conversation_messages`)).rows[0]?.n),
      courseKnowledge: targetKnowledge.rowCount ?? 0,
    };
    const targetLeadRows = targetLeads.rows.map((row) => ({ id: String(row.id), canonicalPhone: String(row.canonical_phone) }));
    const links = new Map(existingLinks.rows.map((row) => [String(row.source_lead_id), {
      leadId: row.lead_id ? String(row.lead_id) : null, matchStatus: String(row.match_status),
    }]));
    const leadPlan = new Map<string, { kind: string; targetLeadId?: string; phone: string | null; source: SupabaseLegacyLead }>();
    for (const sourceRow of sourceLeads.rows as SupabaseLegacyLead[]) {
      const result = classifyLegacyLead(sourceRow, targetLeadRows, links.get(String(sourceRow.id)));
      leadPlan.set(String(sourceRow.id), { ...result, phone: sourceRow.phone ? normalizeIndianMobile(sourceRow.phone) : null, source: sourceRow });
      if (result.kind === "insert") report.leads.insert++;
      else if (result.kind === "exact_id") report.leads.exactIdSkip++;
      else if (result.kind === "linked") report.leads.linkedSkip++;
      else if (result.kind === "held") report.leads.held++;
      else report.leads.review++;
    }
    const existingMessageKeys = new Set(targetMessages.rows.map((row) => `${row.source_record_id}:${row.source_message_side}`));
    for (const row of sourceConversations.rows) {
      const lead = leadPlan.get(String(row.lead_id));
      if (!lead || !["insert", "exact_id", "linked"].includes(lead.kind)) {
        report.conversations.blockedByLeadReview++;
        continue;
      }
      if (!lead.phone) {
        report.conversations.validationErrors++;
        continue;
      }
      if (row.has_message && !["inbound", "incoming", "user", "outbound", "outgoing", "assistant"].includes(String(row.direction).toLowerCase())) {
        report.conversations.validationErrors++;
        continue;
      }
      const expectedParts = Number(Boolean(row.has_message)) + Number(Boolean(row.has_ai_response));
      const already = Number(existingMessageKeys.has(`${row.id}:message`)) + Number(existingMessageKeys.has(`${row.id}:ai_response`));
      report.conversations.alreadyImported += already;
      report.conversations.plannedMessages += Math.max(expectedParts - already, 0);
    }
    const existingKnowledgeIds = new Set(targetKnowledge.rows.flatMap((row) => [
      String(row.id), row.source_record_id ? String(row.source_record_id) : "",
    ]));
    const existingSlugs = new Set(targetKnowledge.rows.map((row) => String(row.slug)));
    for (const row of sourceKnowledge.rows) {
      if (existingKnowledgeIds.has(String(row.id))) {
        report.courseKnowledge.sourceIdSkip++;
      } else if (existingSlugs.has(String(row.slug))) {
        report.courseKnowledge.slugConflict++;
      } else {
        report.courseKnowledge.insert++;
      }
    }
    if (!apply) {
      await source.query("ROLLBACK");
      sourceTransaction = false;
      return {
        mode: "dry_run",
        sourceProject: "xylqezjvqqqjozenuygh",
        target: "replit_postgresql",
        sourceSnapshot: "repeatable_read_read_only",
        counts: report,
      };
    }

    const decisions = new Map(manifest!.decisions.map((row) => [row.sourceLeadId, row]));
    const unresolved = Array.from(leadPlan.entries()).filter(([, item]) => item.kind === "review" || item.kind === "held");
    if (unresolved.some(([id]) => !decisions.has(id))) throw new Error("reconciliation_manifest_incomplete");
    await target.query("BEGIN");
    targetTransaction = true;
    const appliedCounts = { leadsInserted: 0, crosswalkChanges: 0, messagesInserted: 0, knowledgeInserted: 0 };
    const targetLeadBySource = new Map<string, { leadId: string; phone: string }>();
    for (const [sourceId, item] of Array.from(leadPlan.entries())) {
      const decision = decisions.get(sourceId);
      if (item.kind === "insert") {
        const leadId = String(item.source.id);
        const phone = item.phone!;
        const exists = await target.query(`SELECT id FROM admissions_leads WHERE canonical_phone=$1 OR id=$2::uuid`, [phone, leadId]);
        if (exists.rowCount) throw new Error("target_lead_collision");
        const inserted = await target.query(`INSERT INTO admissions_leads(id,canonical_phone,name,created_at,entry_source,legacy_profile,legacy_match_status)
          VALUES($1::uuid,$2,$3,$4,'supabase_aichm_import',$5::jsonb,'linked')`,
        [leadId, phone, item.source.name?.trim() || "Legacy AICHM lead", item.source.created_at ?? new Date(), JSON.stringify(legacyLeadProfile(item.source))]);
        appliedCounts.leadsInserted += inserted.rowCount ?? 0;
        const link = await target.query(`INSERT INTO admissions_legacy_lead_links(source_system,source_lead_id,lead_id,match_status,legacy_profile)
          VALUES('supabase_aichm',$1::uuid,$2::uuid,'linked',$3::jsonb)`,
        [sourceId, leadId, JSON.stringify(item.source)]);
        appliedCounts.crosswalkChanges += link.rowCount ?? 0;
        targetLeadBySource.set(sourceId, { leadId, phone });
      } else if (item.kind === "exact_id" || item.kind === "linked") {
        const leadId = item.targetLeadId!;
        const [targetLead] = (await target.query(`SELECT id,canonical_phone FROM admissions_leads WHERE id=$1::uuid`, [leadId])).rows;
        if (!targetLead) throw new Error("crosswalk_target_missing");
        targetLeadBySource.set(sourceId, { leadId, phone: targetLead.canonical_phone });
        if (item.kind === "exact_id" && !links.has(sourceId)) {
          const link = await target.query(`INSERT INTO admissions_legacy_lead_links(
          source_system,source_lead_id,lead_id,match_status,legacy_profile) VALUES('supabase_aichm',$1::uuid,$2::uuid,'linked',$3::jsonb)`,
          [sourceId, leadId, JSON.stringify(item.source)]);
          appliedCounts.crosswalkChanges += link.rowCount ?? 0;
        }
      } else if (decision?.decision === "link") {
        const [targetLead] = (await target.query(`SELECT id,canonical_phone FROM admissions_leads WHERE id=$1::uuid`, [decision.targetLeadId])).rows;
        if (!targetLead) throw new Error("reviewed_target_missing");
        const link = await target.query(`INSERT INTO admissions_legacy_lead_links(source_system,source_lead_id,lead_id,match_status,legacy_profile)
          VALUES('supabase_aichm',$1::uuid,$2::uuid,'linked',$3::jsonb)
          ON CONFLICT(source_system,source_lead_id) DO UPDATE SET
            lead_id=EXCLUDED.lead_id,match_status='linked',legacy_profile=EXCLUDED.legacy_profile,reviewed_at=now()`,
        [sourceId, targetLead.id, JSON.stringify(item.source)]);
        appliedCounts.crosswalkChanges += link.rowCount ?? 0;
        targetLeadBySource.set(sourceId, { leadId: String(targetLead.id), phone: String(targetLead.canonical_phone) });
      } else if (decision?.decision === "hold") {
        const link = await target.query(`INSERT INTO admissions_legacy_lead_links(source_system,source_lead_id,lead_id,match_status,legacy_profile)
          VALUES('supabase_aichm',$1::uuid,NULL,'held',$2::jsonb)
          ON CONFLICT(source_system,source_lead_id) DO NOTHING`, [sourceId, JSON.stringify(item.source)]);
        appliedCounts.crosswalkChanges += link.rowCount ?? 0;
      }
    }

    const sourceMessages = await source.query(`SELECT id,lead_id,phone,direction,message_type,message,ai_response,created_at
      FROM public.conversations ORDER BY id`);
    for (const row of sourceMessages.rows as LegacyConversation[]) {
      const lead = targetLeadBySource.get(String(row.lead_id));
      if (!lead) continue;
      const plan = planLegacyConversation(row, lead.phone);
      if (plan.error) continue;
      for (const message of plan.messages) {
        const inserted = await target.query(`INSERT INTO admissions_conversation_messages(
          lead_id,canonical_phone,direction,message_type,body,provider,idempotency_key,delivery_state,
          occurred_at,source_system,source_record_id,source_message_side)
          VALUES($1::uuid,$2,$3,$4,$5,'supabase_aichm',$6,$7,$8,$9,$10,$11)
          ON CONFLICT DO NOTHING`,
        [lead.leadId, message.canonicalPhone, message.direction, row.message_type || "text",
          message.body, message.idempotencyKey, message.deliveryState, message.occurredAt,
          message.sourceSystem, message.sourceRecordId, message.sourceMessageSide]);
        appliedCounts.messagesInserted += inserted.rowCount ?? 0;
      }
    }

    const sourceKnowledgeRows = await source.query(`SELECT id,slug,category,question,answer,keywords,status,priority,metadata,created_at,updated_at
      FROM public.course_knowledge ORDER BY id`);
    for (const row of sourceKnowledgeRows.rows as LegacyKnowledge[]) {
      const knowledge = planLegacyKnowledge(row);
      const inserted = await target.query(`INSERT INTO lms_course_knowledge(id,source_system,source_record_id,slug,category,question,answer,
        keywords,status,priority,metadata,created_at,updated_at)
        VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
        ON CONFLICT DO NOTHING`,
      [knowledge.id, knowledge.sourceSystem, knowledge.sourceRecordId, knowledge.slug, knowledge.category,
        knowledge.question, knowledge.answer, knowledge.keywords, knowledge.status, knowledge.priority,
        JSON.stringify(knowledge.metadata), knowledge.createdAt, knowledge.updatedAt]);
      appliedCounts.knowledgeInserted += inserted.rowCount ?? 0;
    }
    await target.query("COMMIT");
    targetTransaction = false;
    await source.query("ROLLBACK");
    sourceTransaction = false;
    return { mode: "apply", plan: report, appliedCounts, applied: true };
  } catch (error) {
    if (targetTransaction) await target.query("ROLLBACK").catch(() => undefined);
    if (sourceTransaction) await source.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    source.release();
    target.release();
    await sourceConnection.pool.end();
  }
}

export function safeImportErrorCategory(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const allowed = new Set([
    "apply_prerequisites_missing", "reconciliation_manifest_invalid", "source_target_identity_not_distinct",
    "supabase_source_identity_mismatch", "target_schema_not_ready", "reconciliation_manifest_incomplete",
    "target_lead_collision", "crosswalk_target_missing", "reviewed_target_missing",
  ]);
  return allowed.has(message) ? message : "database_or_import_error";
}
