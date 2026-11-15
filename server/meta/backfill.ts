import { createHash, createHmac, randomUUID } from "node:crypto";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { normalizeMetaFieldData } from "./config";
import { classifyMetaGraphError } from "./graph-error";
import { openBackfillState, sealBackfillState } from "./backfill-token";
import type {
  MetaBackfillForm,
  MetaBackfillFormCounts,
  MetaBackfillProgress,
  MetaBackfillTotals,
  MetaBackfillWindow,
} from "@shared/meta-backfill";

export const META_BACKFILL_BATCH_SIZE = 40;
export const META_BACKFILL_MAX_SPAN_DAYS = 365;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SELECTED_FORMS = 50;
const MAX_FORM_PAGES = 250;
const MAX_LEAD_PAGES_PER_FORM = 800;
const MAX_GRAPH_RETRIES = 2;
const MAX_INLINE_RETRY_DELAY_MS = 5_000;
const GRAPH_HOST = "https://graph.facebook.com";
const FORM_FIELDS = "id,name,status,created_time,leads_count";
const LEAD_FIELDS = "created_time,id,ad_id,form_id,field_data";

type Environment = Record<string, string | undefined>;
type GraphDiagnostic = {
  httpStatus: number;
  errorType?: string;
  errorCode?: number;
  errorSubcode?: number;
  isTransient?: boolean;
};
type SafeCode =
  | "meta_configuration_unavailable"
  | "page_identity_mismatch"
  | "graph_authentication_rejected"
  | "graph_permission_rejected"
  | "graph_rate_limited"
  | "graph_request_failed"
  | "graph_response_invalid"
  | "graph_cursor_repeated"
  | "graph_page_limit_reached"
  | "form_selection_invalid"
  | "form_unavailable"
  | "date_range_invalid"
  | "date_range_too_large"
  | "continuation_invalid"
  | "continuation_expired"
  | "continuation_wrong_admin"
  | "continuation_configuration_changed"
  | "meta_schema_unavailable"
  | "database_read_failed"
  | "persistence_failed"
  | "preview_incomplete"
  | "confirmation_count_mismatch"
  | "no_new_submissions";

const SAFE_MESSAGES: Record<SafeCode, string> = {
  meta_configuration_unavailable: "Meta backfill configuration is unavailable.",
  page_identity_mismatch: "The configured Page token does not match the configured Page.",
  graph_authentication_rejected: "Meta rejected the configured Page token. Check its validity.",
  graph_permission_rejected: "Meta denied historical lead retrieval. Check the Page token permissions.",
  graph_rate_limited: "Meta rate-limited this request. Wait before resuming the saved batch.",
  graph_request_failed: "Meta could not complete the request. The batch can be resumed.",
  graph_response_invalid: "Meta returned an unexpected response. No unsafe data was processed.",
  graph_cursor_repeated: "Meta pagination repeated a cursor. This run stopped without skipping ahead.",
  graph_page_limit_reached: "The selected lead history exceeded the safe page limit. Narrow the operation or contact support.",
  form_selection_invalid: "Select one or more valid forms from the loaded Page form list.",
  form_unavailable: "A selected form is no longer available for this Page.",
  date_range_invalid: "Choose valid start and end dates, with the start before the end.",
  date_range_too_large: "The selected date range exceeds the 365-day limit.",
  continuation_invalid: "This continuation is invalid. Start a new preview.",
  continuation_expired: "This continuation expired. Start a new preview.",
  continuation_wrong_admin: "This continuation belongs to a different administrator.",
  continuation_configuration_changed: "Meta configuration changed during this run. Start a new preview.",
  meta_schema_unavailable: "The CRM Meta lead-link schema is not available.",
  database_read_failed: "CRM duplicate-check data is temporarily unavailable.",
  persistence_failed: "A CRM save failed. The current batch can be resumed safely.",
  preview_incomplete: "Complete the full preview before confirming an import.",
  confirmation_count_mismatch: "The confirmation count does not match the completed preview.",
  no_new_submissions: "There are no new submissions to import in this preview.",
};

export class MetaBackfillError extends Error {
  readonly code: SafeCode;
  readonly httpStatus: number;
  readonly graph?: GraphDiagnostic;
  readonly retryAfterSeconds?: number;
  continuationToken?: string;
  progress?: MetaBackfillProgress;

  constructor(
    code: SafeCode,
    httpStatus = 400,
    options: { graph?: GraphDiagnostic; retryAfterSeconds?: number } = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "MetaBackfillError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.graph = options.graph;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

type GraphForm = {
  id: string;
  name: string;
  status: string;
  createdAt: string | null;
  leadsCount: number | null;
};

type MetaLead = {
  id: string;
  created_time: string;
  ad_id?: string;
  form_id?: string;
  field_data?: unknown;
};

type MetaPage<T> = { data: T[]; paging?: { next?: unknown; cursors?: { after?: unknown } } };
type FormRun = GraphForm & {
  counts: {
    fetched: number;
    alreadyPresent: number;
    eligibleNew: number;
    validPhone: number;
    phoneReview: number;
    imported: number;
    importReview: number;
    failed: number;
  };
};
type ImportOutcome = { fingerprint: string; status: "imported" | "already_present" | "failed" };
type BackfillState = {
  version: 1;
  phase: "preview" | "import";
  adminId: number;
  createdAt: number;
  expiresAt: number;
  pageId: string;
  graphVersion: string;
  window: MetaBackfillWindow & { startEpoch: number; endEpoch: number };
  forms: FormRun[];
  formIndex: number;
  after: string | null;
  cursorHashes: string[];
  pageNumber: number;
  completed: boolean;
  approvedImportCount: number | null;
  previewTotals: MetaBackfillTotals;
  importTotals: MetaBackfillTotals;
  processedPage: ImportOutcome[];
  retryNotBefore: number | null;
};

type LeadForPersistence = {
  metaLeadId: string;
  pageId: string;
  formId: string | null;
  campaignId: string | null;
  adId: string | null;
  adsetId: string | null;
  leadCreatedAt: Date | null;
  fieldData: unknown;
};

export type MetaBackfillDependencies = {
  env?: Environment;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  isSchemaReady: () => Promise<boolean>;
  findExistingMetaLeadIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
  persistLead: (input: LeadForPersistence) => Promise<{ duplicate?: boolean }>;
  log?: (entry: {
    correlationId: string;
    phase: string;
    code: string;
    counts?: { fetched?: number; imported?: number; alreadyPresent?: number; failed?: number };
  }) => void;
};

export type MetaBackfillService = ReturnType<typeof createMetaBackfillService>;

function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,40}$/.test(value);
}

function dateOnly(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function istMidnightEpoch(date: string) {
  // The allowed Unix-era window uses Asia/Kolkata's fixed UTC+05:30 offset.
  const dateMs = Date.parse(`${date}T00:00:00.000Z`);
  return Math.floor(dateMs / 1_000) - (5 * 60 + 30) * 60;
}

export function createMetaBackfillWindow(startDate: unknown, endDate: unknown): BackfillState["window"] {
  if (!dateOnly(startDate) || !dateOnly(endDate) || String(startDate) >= String(endDate)) {
    throw new MetaBackfillError("date_range_invalid");
  }
  const start = istMidnightEpoch(String(startDate));
  const endExclusive = istMidnightEpoch(new Date(Date.parse(`${endDate}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10));
  const span = (endExclusive - start) / 86_400;
  if (!Number.isInteger(span) || span > META_BACKFILL_MAX_SPAN_DAYS) {
    throw new MetaBackfillError("date_range_too_large");
  }
  return {
    timezone: "Asia/Kolkata",
    startDate: String(startDate),
    endDate: String(endDate),
    startUtc: new Date(start * 1_000).toISOString(),
    endUtcExclusive: new Date(endExclusive * 1_000).toISOString(),
    maximumDays: META_BACKFILL_MAX_SPAN_DAYS,
    startEpoch: start,
    endEpoch: endExclusive,
  };
}

function emptyCounts(): FormRun["counts"] {
  return { fetched: 0, alreadyPresent: 0, eligibleNew: 0, validPhone: 0, phoneReview: 0, imported: 0, importReview: 0, failed: 0 };
}

function emptyTotals(): MetaBackfillTotals {
  return { fetched: 0, alreadyPresent: 0, eligibleNew: 0, validPhone: 0, phoneReview: 0, imported: 0, importReview: 0, failed: 0 };
}

function safeForm(value: unknown): GraphForm | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const form = value as Record<string, unknown>;
  if (!isNumericId(form.id)) return null;
  const createdAt = typeof form.created_time === "string" && Number.isFinite(Date.parse(form.created_time))
    ? new Date(form.created_time).toISOString()
    : null;
  return {
    id: form.id,
    name: typeof form.name === "string" ? form.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled form" : "Untitled form",
    status: typeof form.status === "string" ? form.status.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40) || "Unknown" : "Unknown",
    createdAt,
    leadsCount: typeof form.leads_count === "number" && Number.isSafeInteger(form.leads_count) && form.leads_count >= 0
      ? form.leads_count
      : null,
  };
}

function safePage<T>(body: unknown): MetaPage<T> {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as Record<string, unknown>).data)) {
    throw new MetaBackfillError("graph_response_invalid", 502);
  }
  return body as MetaPage<T>;
}

function hasMore(page: MetaPage<unknown>) {
  return typeof page.paging?.next === "string" && page.paging.next.length > 0;
}

function afterCursor(page: MetaPage<unknown>) {
  const after = page.paging?.cursors?.after;
  return typeof after === "string" && after.length > 0 ? after : null;
}

function cursorFingerprint(cursor: string) {
  return createHash("sha256").update(cursor).digest("base64url").slice(0, 22);
}

function leadFingerprint(leadId: string, secret: string) {
  return createHmac("sha256", secret).update(`aichm-meta-backfill-lead:${leadId}`).digest("base64url");
}

function parseRetryAfter(value: string | null, nowMs: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(86_400, Math.max(0, Math.ceil((date - nowMs) / 1_000))) : undefined;
}

function safeGraphError(status: number, body: unknown, retryAfterSeconds?: number): MetaBackfillError {
  const diagnostic = classifyMetaGraphError(status, body);
  const graph: GraphDiagnostic = {
    httpStatus: status,
    ...(diagnostic.upstreamErrorType ? { errorType: diagnostic.upstreamErrorType } : {}),
    ...(diagnostic.upstreamErrorCode !== undefined ? { errorCode: diagnostic.upstreamErrorCode } : {}),
    ...(diagnostic.upstreamErrorSubcode !== undefined ? { errorSubcode: diagnostic.upstreamErrorSubcode } : {}),
    ...(diagnostic.upstreamIsTransient !== undefined ? { isTransient: diagnostic.upstreamIsTransient } : {}),
  };
  const code: SafeCode = status === 429
    ? "graph_rate_limited"
    : diagnostic.errorCategory === "graph_authentication_rejected"
      ? "graph_authentication_rejected"
      : diagnostic.errorCategory === "graph_permission_rejected"
        ? "graph_permission_rejected"
        : "graph_request_failed";
  return new MetaBackfillError(code, status === 429 ? 429 : 503, {
    graph,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

function validateGraphContext(env: Environment) {
  const pageId = env.META_PAGE_ID?.trim() ?? "";
  const accessToken = env.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
  const graphVersion = env.META_GRAPH_API_VERSION?.trim() ?? "";
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (!isNumericId(pageId) || !accessToken || !/^v\d+\.\d+$/.test(graphVersion) || !sessionSecret) {
    throw new MetaBackfillError("meta_configuration_unavailable", 503);
  }
  return { pageId, accessToken, graphVersion, sessionSecret };
}

function decodeState(token: string, adminId: number, context: ReturnType<typeof validateGraphContext>, now: Date, secret: string) {
  let state: BackfillState;
  try {
    state = openBackfillState<BackfillState>(token, secret);
  } catch {
    throw new MetaBackfillError("continuation_invalid");
  }
  if (!state || state.version !== 1 || !["preview", "import"].includes(state.phase)
    || !Number.isSafeInteger(state.adminId) || !Array.isArray(state.forms)) {
    throw new MetaBackfillError("continuation_invalid");
  }
  if (state.expiresAt <= now.getTime()) throw new MetaBackfillError("continuation_expired", 410);
  if (state.adminId !== adminId) throw new MetaBackfillError("continuation_wrong_admin", 403);
  if (state.pageId !== context.pageId || state.graphVersion !== context.graphVersion) {
    throw new MetaBackfillError("continuation_configuration_changed", 409);
  }
  return state;
}

function safeProgress(state: BackfillState, secret: string): MetaBackfillProgress {
  const totals = state.phase === "preview" ? state.previewTotals : state.importTotals;
  return {
    phase: state.phase,
    state: state.completed ? "complete" : "running",
    continuationToken: sealBackfillState(state, secret),
    expiresAt: new Date(state.expiresAt).toISOString(),
    window: {
      timezone: state.window.timezone,
      startDate: state.window.startDate,
      endDate: state.window.endDate,
      startUtc: state.window.startUtc,
      endUtcExclusive: state.window.endUtcExclusive,
      maximumDays: state.window.maximumDays,
    },
    batchSize: META_BACKFILL_BATCH_SIZE,
    identityResolution: "determined_during_import",
    approvedImportCount: state.approvedImportCount,
    forms: state.forms.map((form): MetaBackfillFormCounts => ({
      formId: form.id,
      name: form.name,
      status: form.status,
      ...form.counts,
    })),
    totals: { ...totals },
  };
}

export function createMetaBackfillService(dependencies: MetaBackfillDependencies) {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? ((entry) => console.info("[meta-backfill]", JSON.stringify(entry)));

  async function graphGet<T>(path: string[], params: Record<string, string>, phase: string, correlationId: string) {
    const context = validateGraphContext(env);
    const url = new URL(`/${context.graphVersion}/${path.map((part) => encodeURIComponent(part)).join("/")}`, GRAPH_HOST);
    url.searchParams.set("access_token", context.accessToken);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    for (let attempt = 0; attempt <= MAX_GRAPH_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "GET",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        if (attempt < MAX_GRAPH_RETRIES) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        log({ correlationId, phase, code: "graph_transport_failure" });
        throw new MetaBackfillError("graph_request_failed", 503);
      }

      if (!response.ok) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), now().getTime());
        let body: unknown;
        try { body = await response.json(); } catch { body = null; }
        const error = safeGraphError(response.status, body, retryAfterSeconds);
        if (response.status !== 429 && error.graph?.isTransient === true && attempt < MAX_GRAPH_RETRIES) {
          const delay = error.retryAfterSeconds === undefined
            ? 250 * 2 ** attempt
            : error.retryAfterSeconds * 1_000;
          if (delay <= MAX_INLINE_RETRY_DELAY_MS) {
            await sleep(delay);
            continue;
          }
        }
        log({
          correlationId,
          phase,
          code: error.code,
        });
        throw error;
      }

      try {
        return await response.json() as T;
      } catch {
        throw new MetaBackfillError("graph_response_invalid", 502);
      }
    }
    throw new MetaBackfillError("graph_request_failed", 503);
  }

  async function verifyConfiguredPage(phase: string, correlationId: string) {
    const context = validateGraphContext(env);
    const identity = await graphGet<{ id?: unknown }>(["me"], { fields: "id" }, phase, correlationId);
    if (identity.id !== context.pageId) {
      log({ correlationId, phase, code: "page_identity_mismatch" });
      throw new MetaBackfillError("page_identity_mismatch", 403);
    }
    return context;
  }

  async function enumerateForms(correlationId: string): Promise<MetaBackfillForm[]> {
    const context = await verifyConfiguredPage("forms", correlationId);
    const forms = new Map<string, MetaBackfillForm>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_FORM_PAGES; pageNumber++) {
      const params: Record<string, string> = { fields: FORM_FIELDS, limit: "100" };
      if (after) params.after = after;
      const page = safePage<unknown>(await graphGet<MetaPage<unknown>>(
        [context.pageId, "leadgen_forms"], params, "forms", correlationId,
      ));
      for (const raw of page.data) {
        const form = safeForm(raw);
        if (!form) throw new MetaBackfillError("graph_response_invalid", 502);
        forms.set(form.id, form);
      }
      if (!hasMore(page)) {
        const result = Array.from(forms.values());
        log({ correlationId, phase: "forms", code: "forms_enumeration_complete", counts: { fetched: result.length } });
        return result;
      }
      const next = afterCursor(page);
      if (!next || cursors.has(cursorFingerprint(next)) || next === after) {
        throw new MetaBackfillError("graph_cursor_repeated", 502);
      }
      cursors.add(cursorFingerprint(next));
      after = next;
    }
    throw new MetaBackfillError("graph_page_limit_reached", 502);
  }

  async function assertMetaSchema() {
    try {
      if (!await dependencies.isSchemaReady()) throw new Error("schema_not_ready");
    } catch {
      throw new MetaBackfillError("meta_schema_unavailable", 503);
    }
  }

  function makeState(
    adminId: number,
    context: ReturnType<typeof validateGraphContext>,
    window: BackfillState["window"],
    forms: MetaBackfillForm[],
    phase: BackfillState["phase"],
  ): BackfillState {
    const timestamp = now().getTime();
    const runs: FormRun[] = forms.map((form) => ({ ...form, counts: emptyCounts() }));
    return {
      version: 1,
      phase,
      adminId,
      createdAt: timestamp,
      expiresAt: timestamp + TOKEN_TTL_MS,
      pageId: context.pageId,
      graphVersion: context.graphVersion,
      window,
      forms: runs,
      formIndex: 0,
      after: null,
      cursorHashes: [],
      pageNumber: 0,
      completed: false,
      approvedImportCount: null,
      previewTotals: emptyTotals(),
      importTotals: emptyTotals(),
      processedPage: [],
    retryNotBefore: null,
    };
  }

  function validateCursor(state: BackfillState, next: string | null) {
    if (!next) return;
    const nextHash = cursorFingerprint(next);
    if (next === state.after || state.cursorHashes.includes(nextHash)) {
      throw new MetaBackfillError("graph_cursor_repeated", 502);
    }
  }

  function validatePageAdvance(state: BackfillState, page: MetaPage<unknown>) {
    const more = hasMore(page);
    const next = more ? afterCursor(page) : null;
    if (more && !next) throw new MetaBackfillError("graph_response_invalid", 502);
    validateCursor(state, next);
    if (state.pageNumber + 1 > MAX_LEAD_PAGES_PER_FORM
      || (state.after && state.cursorHashes.length >= MAX_LEAD_PAGES_PER_FORM)) {
      throw new MetaBackfillError("graph_page_limit_reached", 502);
    }
  }

  function advancePage(state: BackfillState, page: MetaPage<unknown>) {
    const more = hasMore(page);
    const next = more ? afterCursor(page) : null;
    if (more && !next) throw new MetaBackfillError("graph_response_invalid", 502);
    validateCursor(state, next);
    if (state.after) state.cursorHashes.push(cursorFingerprint(state.after));
    if (state.cursorHashes.length > MAX_LEAD_PAGES_PER_FORM) {
      throw new MetaBackfillError("graph_page_limit_reached", 502);
    }
    state.pageNumber++;
    if (state.pageNumber > MAX_LEAD_PAGES_PER_FORM) throw new MetaBackfillError("graph_page_limit_reached", 502);
    if (more) {
      state.after = next;
    } else {
      state.formIndex++;
      state.after = null;
      state.cursorHashes = [];
      state.pageNumber = 0;
    }
    state.processedPage = [];
    state.completed = state.formIndex >= state.forms.length;
  }

  async function fetchLeadPage(state: BackfillState, correlationId: string) {
    const form = state.forms[state.formIndex];
    const context = await verifyConfiguredPage(state.phase, correlationId);
    const filtering = [
      { field: "time_created", operator: "GREATER_THAN_OR_EQUAL", value: state.window.startEpoch },
      { field: "time_created", operator: "LESS_THAN", value: state.window.endEpoch },
    ];
    const params: Record<string, string> = {
      fields: LEAD_FIELDS,
      limit: String(META_BACKFILL_BATCH_SIZE),
      filtering: JSON.stringify(filtering),
    };
    if (state.after) params.after = state.after;
    const page = safePage<unknown>(await graphGet<MetaPage<unknown>>(
      [form.id, "leads"], params, state.phase, correlationId,
    ));
    if (page.data.length > META_BACKFILL_BATCH_SIZE) {
      throw new MetaBackfillError("graph_response_invalid", 502);
    }
    const leads: MetaLead[] = [];
    const seen = new Set<string>();
    for (const raw of page.data) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new MetaBackfillError("graph_response_invalid", 502);
      }
      const lead = raw as Record<string, unknown>;
      if (!isNumericId(lead.id) || typeof lead.created_time !== "string" || !Number.isFinite(Date.parse(lead.created_time))) {
        throw new MetaBackfillError("graph_response_invalid", 502);
      }
      if (lead.form_id !== undefined && lead.form_id !== form.id) throw new MetaBackfillError("graph_response_invalid", 502);
      if (seen.has(lead.id)) continue;
      seen.add(lead.id);
      const createdSeconds = Math.floor(Date.parse(lead.created_time) / 1_000);
      if (createdSeconds < state.window.startEpoch || createdSeconds >= state.window.endEpoch) continue;
      leads.push({
        id: lead.id,
        created_time: lead.created_time,
        ...(typeof lead.ad_id === "string" && isNumericId(lead.ad_id) ? { ad_id: lead.ad_id } : {}),
        form_id: form.id,
        field_data: lead.field_data,
      });
    }
    return { page, leads };
  }

  function addPreviewRecord(state: BackfillState, form: FormRun, lead: MetaLead, existing: ReadonlySet<string>) {
    form.counts.fetched++;
    state.previewTotals.fetched++;
    if (existing.has(lead.id)) {
      form.counts.alreadyPresent++;
      state.previewTotals.alreadyPresent++;
      return;
    }
    form.counts.eligibleNew++;
    state.previewTotals.eligibleNew++;
    const mapped = normalizeMetaFieldData(lead.field_data);
    if (normalizeIndianMobile(mapped.phone)) {
      form.counts.validPhone++;
      state.previewTotals.validPhone++;
    } else {
      form.counts.phoneReview++;
      state.previewTotals.phoneReview++;
    }
  }

  async function processPreviewPage(state: BackfillState, correlationId: string) {
    const form = state.forms[state.formIndex];
    const { page, leads } = await fetchLeadPage(state, correlationId);
    validatePageAdvance(state, page);
    let existing: ReadonlySet<string>;
    try {
      existing = await dependencies.findExistingMetaLeadIds(leads.map((lead) => lead.id));
    } catch {
      throw new MetaBackfillError("database_read_failed", 503);
    }
    for (const lead of leads) addPreviewRecord(state, form, lead, existing);
    advancePage(state, page);
  }

  async function processImportPage(state: BackfillState, correlationId: string) {
    const form = state.forms[state.formIndex];
    const { page, leads } = await fetchLeadPage(state, correlationId);
    validatePageAdvance(state, page);
    let existing: ReadonlySet<string>;
    try {
      existing = await dependencies.findExistingMetaLeadIds(leads.map((lead) => lead.id));
    } catch {
      throw new MetaBackfillError("database_read_failed", 503);
    }
    const secret = env.SESSION_SECRET ?? "";
    const outcomes = new Map(state.processedPage.map((entry) => [entry.fingerprint, entry.status]));
    const effectiveLeads = leads.filter((lead) => {
      const prior = outcomes.get(leadFingerprint(lead.id, secret));
      return prior !== "imported" && prior !== "already_present";
    });
    for (const lead of effectiveLeads) {
      if (state.importTotals.imported >= (state.approvedImportCount ?? 0)) {
        state.completed = true;
        return;
      }
      const fingerprint = leadFingerprint(lead.id, secret);
      const previousStatus = outcomes.get(fingerprint);
      if (previousStatus !== "failed") {
        form.counts.fetched++;
        state.importTotals.fetched++;
      }
      if (previousStatus === "failed") {
        form.counts.failed = Math.max(0, form.counts.failed - 1);
        state.importTotals.failed = Math.max(0, state.importTotals.failed - 1);
      }
      const wasExisting = existing.has(lead.id);
      if (wasExisting) {
        form.counts.alreadyPresent++;
        state.importTotals.alreadyPresent++;
        outcomes.set(fingerprint, "already_present");
        state.processedPage = Array.from(outcomes.entries()).map(([id, status]) => ({ fingerprint: id, status }));
        continue;
      }
      const mapped = normalizeMetaFieldData(lead.field_data);
      const validPhone = normalizeIndianMobile(mapped.phone) !== null;
      try {
        const result = await dependencies.persistLead({
          metaLeadId: lead.id,
          pageId: state.pageId,
          formId: form.id,
          campaignId: null,
          adId: lead.ad_id ?? null,
          adsetId: null,
          leadCreatedAt: new Date(lead.created_time),
          fieldData: lead.field_data,
        });
        if (result?.duplicate) {
          form.counts.alreadyPresent++;
          state.importTotals.alreadyPresent++;
          outcomes.set(fingerprint, "already_present");
        } else {
          form.counts.imported++;
          state.importTotals.imported++;
          if (!validPhone) {
            form.counts.importReview++;
            state.importTotals.importReview++;
          }
          outcomes.set(fingerprint, "imported");
        }
        state.processedPage = Array.from(outcomes.entries()).map(([id, status]) => ({ fingerprint: id, status }));
      } catch {
        form.counts.failed++;
        state.importTotals.failed++;
        outcomes.set(fingerprint, "failed");
        state.processedPage = Array.from(outcomes.entries()).map(([id, status]) => ({ fingerprint: id, status }));
        throw new MetaBackfillError("persistence_failed", 503);
      }
    }
    if (state.importTotals.imported >= (state.approvedImportCount ?? 0)) {
      state.completed = true;
      return;
    }
    advancePage(state, page);
  }

  function logProgress(correlationId: string, state: BackfillState) {
    const totals = state.phase === "preview" ? state.previewTotals : state.importTotals;
    log({
      correlationId,
      phase: state.phase,
      code: state.completed ? `${state.phase}_complete` : `${state.phase}_batch_complete`,
      counts: {
        fetched: totals.fetched,
        imported: totals.imported,
        alreadyPresent: totals.alreadyPresent,
        failed: totals.failed,
      },
    });
  }

  function stateFromToken(token: string, adminId: number, phase: BackfillState["phase"]) {
    const context = validateGraphContext(env);
    let state = decodeState(token, adminId, context, now(), context.sessionSecret);
    if (state.phase !== phase) throw new MetaBackfillError("continuation_invalid");
    if (state.retryNotBefore && state.retryNotBefore > now().getTime()) {
      const error = new MetaBackfillError("graph_rate_limited", 429, {
        retryAfterSeconds: Math.ceil((state.retryNotBefore - now().getTime()) / 1_000),
      });
      error.continuationToken = token;
      error.progress = safeProgress(state, context.sessionSecret);
      throw error;
    }
    state.retryNotBefore = null;
    return { state, context };
  }

  async function processOneBatch(state: BackfillState, correlationId: string) {
    try {
      await assertMetaSchema();
      if (!state.completed) {
        if (state.phase === "preview") await processPreviewPage(state, correlationId);
        else await processImportPage(state, correlationId);
      }
      logProgress(correlationId, state);
    } catch (error) {
      const safeError = error instanceof MetaBackfillError ? error : new MetaBackfillError("graph_request_failed", 503);
      if (safeError.code === "graph_rate_limited" && safeError.retryAfterSeconds !== undefined) {
        state.retryNotBefore = now().getTime() + safeError.retryAfterSeconds * 1_000;
        state.expiresAt = Math.max(state.expiresAt, state.retryNotBefore + 15 * 60 * 1_000);
      }
      safeError.continuationToken = sealBackfillState(state, env.SESSION_SECRET ?? "");
      safeError.progress = safeProgress(state, env.SESSION_SECRET ?? "");
      log({
        correlationId,
        phase: state.phase,
        code: safeError.code,
        counts: {
          fetched: state.phase === "preview" ? state.previewTotals.fetched : state.importTotals.fetched,
          imported: state.importTotals.imported,
          alreadyPresent: state.phase === "preview" ? state.previewTotals.alreadyPresent : state.importTotals.alreadyPresent,
          failed: state.importTotals.failed,
        },
      });
      throw safeError;
    }
    return safeProgress(state, env.SESSION_SECRET ?? "");
  }

  return {
    async listForms(correlationId: string = randomUUID()) {
      const forms = await enumerateForms(correlationId);
      return { forms, correlationId };
    },

    async startPreview(
      adminId: number,
      input: { formIds: unknown; startDate: unknown; endDate: unknown },
      correlationId: string = randomUUID(),
    ) {
      if (!Number.isSafeInteger(adminId) || adminId < 1) throw new MetaBackfillError("continuation_invalid");
      const window = createMetaBackfillWindow(input.startDate, input.endDate);
      if (!Array.isArray(input.formIds) || !input.formIds.length || input.formIds.length > MAX_SELECTED_FORMS
        || input.formIds.some((id) => !isNumericId(id)) || new Set(input.formIds).size !== input.formIds.length) {
        throw new MetaBackfillError("form_selection_invalid");
      }
      const available = await enumerateForms(correlationId);
      const byId = new Map(available.map((form) => [form.id, form]));
      const selected = input.formIds.map((id) => byId.get(id as string));
      if (selected.some((form) => !form)) throw new MetaBackfillError("form_unavailable", 409);
      const context = validateGraphContext(env);
      const state = makeState(adminId, context, window, selected as MetaBackfillForm[], "preview");
      return processOneBatch(state, correlationId);
    },

    async continuePreview(adminId: number, token: string, correlationId: string = randomUUID()) {
      const { state } = stateFromToken(token, adminId, "preview");
      return processOneBatch(state, correlationId);
    },

    async startImport(
      adminId: number,
      token: string,
      confirmation: { confirmed: unknown; count: unknown },
      correlationId: string = randomUUID(),
    ) {
      const { state, context } = stateFromToken(token, adminId, "preview");
      if (!state.completed) throw new MetaBackfillError("preview_incomplete", 409);
      if (state.previewTotals.eligibleNew <= 0) throw new MetaBackfillError("no_new_submissions", 409);
      if (confirmation.confirmed !== true || confirmation.count !== state.previewTotals.eligibleNew) {
        throw new MetaBackfillError("confirmation_count_mismatch", 409);
      }
      const importState = makeState(adminId, context, state.window, state.forms, "import");
      importState.expiresAt = state.expiresAt;
      importState.previewTotals = { ...state.previewTotals };
      importState.forms = state.forms.map((form) => ({
        ...form,
        counts: {
          ...form.counts,
          imported: 0,
          importReview: 0,
          failed: 0,
        },
      }));
      importState.approvedImportCount = state.previewTotals.eligibleNew;
      return processOneBatch(importState, correlationId);
    },

    async continueImport(adminId: number, token: string, correlationId: string = randomUUID()) {
      const { state } = stateFromToken(token, adminId, "import");
      return processOneBatch(state, correlationId);
    },
  };
}

export function safeMetaBackfillError(error: unknown) {
  if (!(error instanceof MetaBackfillError)) {
    return {
      status: 503,
      body: { code: "backfill_unavailable", message: "Historical Meta import is temporarily unavailable." },
    };
  }
  return {
    status: error.httpStatus,
    body: {
      code: error.code,
      message: SAFE_MESSAGES[error.code],
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.graph ? { graph: { ...error.graph } } : {}),
      ...(error.continuationToken ? { continuationToken: error.continuationToken } : {}),
      ...(error.progress ? { progress: error.progress } : {}),
    },
  };
}

export function previewPhoneOutcome(fieldData: unknown) {
  const mapped = normalizeMetaFieldData(fieldData);
  return normalizeIndianMobile(mapped.phone) ? "valid" : "review";
}

export function getDefaultMetaBackfillDates(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const end = new Date(`${today}T00:00:00.000Z`);
  const start = new Date(end.getTime() - 89 * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: today,
  };
}
