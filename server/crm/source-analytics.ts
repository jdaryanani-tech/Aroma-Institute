import type { CrmSourceAnalytics } from "@shared/crm";
import { crmModelSql, inspectCrmSchema, type SqlDb } from "./model";

export const CRM_SOURCE_BUCKETS = [
  "meta_lead_ads",
  "whatsapp",
  "website",
  "manual",
  "other",
  "unknown",
] as const;

export type CrmSourceBucket = (typeof CRM_SOURCE_BUCKETS)[number];

const SOURCE_ALIASES: Record<Exclude<CrmSourceBucket, "other" | "unknown">, readonly string[]> = {
  meta_lead_ads: ["meta", "meta_instant_form", "meta_lead_ads"],
  whatsapp: ["avni_whatsapp", "whatsapp", "whatsapp_admissions"],
  website: [
    "public_form",
    "website",
    "website_enquiry",
    "website_counselling",
    "website_home_vsl",
    "website_vsl",
    "vsl",
    "vsl_registration",
  ],
  manual: ["manual", "admin_manual", "manual_entry"],
};

const EXPLICIT_UNKNOWN_SOURCES = ["unknown", "unattributed"];

function normalized(value: string | null | undefined): string | null {
  const result = value?.trim().toLowerCase();
  return result || null;
}

function directSourceBucket(value: string | null): CrmSourceBucket | null {
  if (!value) return null;
  for (const bucket of ["meta_lead_ads", "whatsapp", "website", "manual"] as const) {
    if (SOURCE_ALIASES[bucket].includes(value)) return bucket;
  }
  if (EXPLICIT_UNKNOWN_SOURCES.includes(value)) return "unknown";
  return "other";
}

/**
 * Source classification is per saved enquiry, never per touchpoint event.
 * The Meta crosswalk is authoritative; a direct submission source wins next.
 * Touchpoints are only a fallback when the enquiry has no direct source, and
 * conflicting touchpoint buckets remain unknown rather than being guessed.
 */
export function classifyCrmEnquirySource(input: {
  hasMetaLeadLink?: boolean;
  submissionSource?: string | null;
  inquiryTouchpointChannels?: readonly (string | null | undefined)[];
}): CrmSourceBucket {
  const source = normalized(input.submissionSource);
  if (input.hasMetaLeadLink || SOURCE_ALIASES.meta_lead_ads.includes(source ?? "")) {
    return "meta_lead_ads";
  }
  const direct = directSourceBucket(source);
  if (direct) return direct;

  const touchpointBuckets = new Set(
    (input.inquiryTouchpointChannels ?? [])
      .map(normalized)
      .filter((channel): channel is string => channel !== null)
      .map(channel => directSourceBucket(channel) ?? "unknown"),
  );
  if (touchpointBuckets.size === 1) return Array.from(touchpointBuckets)[0];
  return "unknown";
}

function sqlList(values: readonly string[]): string {
  // Values are fixed source-code allowlists, not request or database input.
  return values.map(value => `'${value}'`).join(", ");
}

function sqlTouchpointBucket(expression: string): string {
  const cases = (Object.keys(SOURCE_ALIASES) as Array<keyof typeof SOURCE_ALIASES>)
    .map(bucket => `WHEN ${expression} IN (${sqlList(SOURCE_ALIASES[bucket])}) THEN '${bucket}'`)
    .join("\n");
  return `CASE
    ${cases}
    WHEN ${expression} IN (${sqlList(EXPLICIT_UNKNOWN_SOURCES)}) THEN 'unknown'
    ELSE 'other'
  END`;
}

export function buildCrmSourceAnalyticsQuery(options: {
  hasSubmissionSource: boolean;
  hasMetaLeadLinks: boolean;
  hasTouchpoints: boolean;
  crmModel: string;
}): string {
  const directSource = options.hasSubmissionSource
    ? "NULLIF(lower(btrim(i.submission_source)), '')"
    : "NULL::text";
  const metaLink = options.hasMetaLeadLinks
    ? "EXISTS(SELECT 1 FROM admissions_meta_lead_links ml WHERE ml.inquiry_id = pi.inquiry_id)"
    : "false";
  const touchpointCte = options.hasTouchpoints
    ? `touchpoint_buckets AS (
        SELECT inquiry_id,
          array_agg(DISTINCT ${sqlTouchpointBucket("lower(btrim(source_channel))")}) AS buckets
        FROM admissions_lead_touchpoints
        WHERE inquiry_id IS NOT NULL AND NULLIF(btrim(source_channel), '') IS NOT NULL
        GROUP BY inquiry_id
      )`
    : `touchpoint_buckets AS (
        SELECT NULL::integer AS inquiry_id, ARRAY[]::text[] AS buckets WHERE false
      )`;
  const touchpointJoin = options.hasTouchpoints
    ? "LEFT JOIN touchpoint_buckets tb ON tb.inquiry_id = pi.inquiry_id"
    : "LEFT JOIN touchpoint_buckets tb ON false";
  const touchpointFallback = options.hasTouchpoints
    ? `WHEN cardinality(tb.buckets) = 1 THEN tb.buckets[1]
       WHEN cardinality(tb.buckets) > 1 THEN 'unknown'`
    : "";

  return `${options.crmModel},
    person_inquiries AS (
      SELECT m.id::text AS person_key, m.identity_status, ids.inquiry_id
      FROM model m
      CROSS JOIN LATERAL unnest(m.inquiry_ids) AS ids(inquiry_id)
    ),
    ${touchpointCte},
    attributed_enquiries AS (
      SELECT pi.person_key, pi.identity_status, pi.inquiry_id,
        CASE
          WHEN ${metaLink} OR ${directSource} IN (${sqlList(SOURCE_ALIASES.meta_lead_ads)}) THEN 'meta_lead_ads'
          WHEN ${directSource} IN (${sqlList(SOURCE_ALIASES.whatsapp)}) THEN 'whatsapp'
          WHEN ${directSource} IN (${sqlList(SOURCE_ALIASES.website)}) THEN 'website'
          WHEN ${directSource} IN (${sqlList(SOURCE_ALIASES.manual)}) THEN 'manual'
          WHEN ${directSource} IN (${sqlList(EXPLICIT_UNKNOWN_SOURCES)}) THEN 'unknown'
          WHEN ${directSource} IS NOT NULL THEN 'other'
          ${touchpointFallback}
          ELSE 'unknown'
        END AS source_bucket
      FROM person_inquiries pi
      JOIN inquiries i ON i.id = pi.inquiry_id
      ${touchpointJoin}
    ),
    source_counts AS (
      SELECT source_bucket, count(*)::integer AS enquiry_count,
        count(DISTINCT person_key) FILTER (
          WHERE identity_status IN ('linked', 'unique_phone')
        )::integer AS identified_people
      FROM attributed_enquiries
      GROUP BY source_bucket
    ),
    source_buckets(ord, source_bucket) AS (
      VALUES
        (1, 'meta_lead_ads'),
        (2, 'whatsapp'),
        (3, 'website'),
        (4, 'manual'),
        (5, 'other'),
        (6, 'unknown')
    )
    SELECT
      (SELECT count(*)::integer FROM inquiries) AS total_enquiries,
      (SELECT count(*)::integer FROM model
        WHERE identity_status IN ('linked', 'unique_phone')) AS identified_people,
      (SELECT count(*)::integer FROM model
        WHERE identity_status IN ('ambiguous', 'unmatchable')) AS unresolved_records,
      (SELECT count(*)::integer FROM attributed_enquiries) AS classified_enquiries,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'source', b.source_bucket,
          'enquiries', coalesce(c.enquiry_count, 0),
          'identifiedPeople', coalesce(c.identified_people, 0)
        ) ORDER BY b.ord)
        FROM source_buckets b
        LEFT JOIN source_counts c ON c.source_bucket = b.source_bucket
      ), '[]'::jsonb) AS sources`;
}

export async function readCrmSourceAnalytics(
  db: SqlDb,
  now: () => Date = () => new Date(),
): Promise<CrmSourceAnalytics> {
  const schema = await inspectCrmSchema(db);
  const { rows: [available] } = await db.query(`SELECT
    EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'inquiries' AND column_name = 'submission_source'
    ) AS submission_source,
    to_regclass('admissions_meta_lead_links') IS NOT NULL AS meta_lead_links`);
  const result = await db.query(buildCrmSourceAnalyticsQuery({
    hasSubmissionSource: available?.submission_source === true,
    hasMetaLeadLinks: available?.meta_lead_links === true,
    hasTouchpoints: schema.metaAttribution,
    crmModel: crmModelSql(schema),
  }));
  const row = result.rows[0];
  if (!row || row.total_enquiries !== row.classified_enquiries) {
    throw new Error("CRM source analytics reconciliation failed.");
  }

  const sources = row.sources as CrmSourceAnalytics["sources"];
  if (!Array.isArray(sources)
    || sources.length !== CRM_SOURCE_BUCKETS.length
    || sources.some((source, index) => source.source !== CRM_SOURCE_BUCKETS[index])
    || sources.reduce((total, source) => total + source.enquiries, 0) !== row.total_enquiries) {
    throw new Error("CRM source analytics bucket reconciliation failed.");
  }

  return {
    totalEnquiries: row.total_enquiries,
    identifiedPeople: row.identified_people,
    unresolvedRecords: row.unresolved_records,
    duplicateSubmissions: null,
    duplicateTracking: "not_tracked",
    duplicateExplanation:
      "Idempotency prevents some repeated submissions from creating another record, but duplicate attempts are not retained as a countable record or relationship.",
    attributionMethod:
      "All-time direct submission source; Meta lead links take precedence. Inquiry-linked touchpoints are fallback only when direct source is absent. Person-level entry source is not spread across submissions.",
    sources,
    lastUpdatedAt: now().toISOString(),
  };
}

export type SourceAnalyticsFixtureRow = {
  personKey: string;
  identityStatus: "linked" | "unique_phone" | "ambiguous" | "unmatchable";
  source: CrmSourceBucket;
};

/** Pure fixture helper for testing bucket reconciliation without database access. */
export function summarizeCrmSourceAnalyticsFixture(rows: readonly SourceAnalyticsFixtureRow[]) {
  const buckets = Object.fromEntries(CRM_SOURCE_BUCKETS.map(source => [source, {
    source,
    enquiries: 0,
    identifiedPeople: new Set<string>(),
  }])) as Record<CrmSourceBucket, {
    source: CrmSourceBucket;
    enquiries: number;
    identifiedPeople: Set<string>;
  }>;
  const identified = new Set<string>();
  const unresolved = new Set<string>();
  for (const row of rows) {
    const bucket = buckets[row.source];
    bucket.enquiries += 1;
    if (row.identityStatus === "linked" || row.identityStatus === "unique_phone") {
      identified.add(row.personKey);
      bucket.identifiedPeople.add(row.personKey);
    } else {
      unresolved.add(row.personKey);
    }
  }
  return {
    totalEnquiries: rows.length,
    identifiedPeople: identified.size,
    unresolvedRecords: unresolved.size,
    sources: CRM_SOURCE_BUCKETS.map(source => ({
      source,
      enquiries: buckets[source].enquiries,
      identifiedPeople: buckets[source].identifiedPeople.size,
    })),
    duplicateSubmissions: null as null,
    duplicateTracking: "not_tracked" as const,
  };
}
