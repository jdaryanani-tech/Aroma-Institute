import type { PoolClient } from "pg";
import { pool } from "../db";
import { createSupabaseMigrationConnection } from "./supabase-migration";
import {
  assertLegacyImportApplyGate, classifyLegacyLeadReference, type SupabaseLegacyLeadReference,
} from "./supabase-legacy-import";

type ImportOptions = { apply?: boolean };
type LinkReference = { source_lead_id: string; lead_id: string | null; match_status: string };

async function assertDatabaseSeparation(source: PoolClient, target: PoolClient) {
  const [sourceIdentity, targetIdentity] = await Promise.all([
    source.query(`SELECT current_database() AS db, inet_server_addr()::text AS host`),
    target.query(`SELECT current_database() AS db, inet_server_addr()::text AS host`),
  ]);
  const sourceRow = sourceIdentity.rows[0], targetRow = targetIdentity.rows[0];
  if (!sourceRow?.host || !targetRow?.host
    || `${sourceRow.db}:${sourceRow.host}` === `${targetRow.db}:${targetRow.host}`) {
    throw new Error("source_target_identity_not_distinct");
  }
  if (String(sourceRow.db) !== "postgres") throw new Error("supabase_source_identity_mismatch");
}

/**
 * The old copy operation is intentionally disabled. This tool now performs
 * aggregate-only reconciliation planning; Supabase conversations and course
 * knowledge remain in Supabase, and Supabase lead rows are identity indexes,
 * not new Replit business leads.
 */
export async function runSupabaseLegacyImport(options: ImportOptions = {}) {
  assertLegacyImportApplyGate(options.apply === true);
  const sourceConnection = createSupabaseMigrationConnection();
  const source = await sourceConnection.pool.connect();
  const target = await pool.connect();
  let sourceTransaction = false, targetTransaction = false;
  try {
    await assertDatabaseSeparation(source, target);
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    sourceTransaction = true;
    await target.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    targetTransaction = true;

    const [sourceCounts, targetCounts, sourceLeads, targetLeads, linkSchema] = await Promise.all([
      source.query(`SELECT
        (SELECT count(*)::integer FROM public.leads) AS leads,
        (SELECT count(*)::integer FROM public.conversations) AS conversations,
        (SELECT count(*)::integer FROM public.course_knowledge) AS course_knowledge`),
      target.query(`SELECT
        (SELECT count(*)::integer FROM admissions_leads) AS canonical_leads,
        to_regclass('admissions_legacy_lead_links') IS NOT NULL AS links_available`),
      source.query(`SELECT id, phone FROM public.leads ORDER BY id`),
      target.query(`SELECT id, canonical_phone FROM admissions_leads`),
      target.query(`SELECT to_regclass('admissions_legacy_lead_links') IS NOT NULL AS available`),
    ]);
    let links: LinkReference[] = [];
    if (linkSchema.rows[0]?.available) {
      const result = await target.query(`SELECT source_lead_id, lead_id, match_status
        FROM admissions_legacy_lead_links WHERE source_system = 'supabase_aichm'`);
      links = result.rows;
    }

    const existing = targetLeads.rows.map((row) => ({
      id: String(row.id), canonicalPhone: String(row.canonical_phone),
    }));
    const linkBySource = new Map(links.map((row) => [String(row.source_lead_id), {
      leadId: row.lead_id ? String(row.lead_id) : null, matchStatus: String(row.match_status),
    }]));
    const reconciliation = {
      alreadyLinked: 0,
      reviewRequired: 0,
      uniquePhoneCandidates: 0,
      ambiguousPhoneCandidates: 0,
      identifierCollisionCandidates: 0,
      invalidPhone: 0,
      savedCrosswalkRequiresReview: 0,
      unmatched: 0,
    };
    for (const row of sourceLeads.rows as SupabaseLegacyLeadReference[]) {
      const decision = classifyLegacyLeadReference(row, existing, linkBySource.get(String(row.id)));
      if (decision.kind === "already_linked") reconciliation.alreadyLinked++;
      else if (decision.kind === "unmatched") reconciliation.unmatched++;
      else {
        reconciliation.reviewRequired++;
        if (decision.reason === "unique_phone_candidate") reconciliation.uniquePhoneCandidates++;
        if (decision.reason === "ambiguous_phone") reconciliation.ambiguousPhoneCandidates++;
        if (decision.reason === "identifier_collision_candidate") reconciliation.identifierCollisionCandidates++;
        if (decision.reason === "invalid_phone") reconciliation.invalidPhone++;
        if (decision.reason === "saved_crosswalk_not_linked") reconciliation.savedCrosswalkRequiresReview++;
      }
    }

    await Promise.all([source.query("ROLLBACK"), target.query("ROLLBACK")]);
    sourceTransaction = false;
    targetTransaction = false;
    return {
      mode: "read_only_reconciliation",
      sourceProject: "xylqezjvqqqjozenuygh",
      target: "replit_postgresql",
      snapshot: "repeatable_read_read_only",
      counts: {
        source: {
          leadIndexes: Number(sourceCounts.rows[0]?.leads ?? 0),
          conversationsPreservedInSupabase: Number(sourceCounts.rows[0]?.conversations ?? 0),
          courseKnowledgePreservedInSupabase: Number(sourceCounts.rows[0]?.course_knowledge ?? 0),
        },
        target: {
          canonicalLeads: Number(targetCounts.rows[0]?.canonical_leads ?? 0),
          reviewedCrosswalkRows: links.length,
        },
        reconciliation,
        importedToReplit: { leads: 0, conversations: 0, courseKnowledge: 0 },
      },
      writesEnabled: false,
    };
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
    "legacy_import_disabled_two_database_architecture",
    "source_target_identity_not_distinct",
    "supabase_source_identity_mismatch",
  ]);
  return allowed.has(message) ? message : "database_or_import_error";
}
