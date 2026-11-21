import { getMetaAllowedFormIdsStatus, parseMetaAllowedFormIds } from "./config";
import type { MetaGraphFetch } from "./page-subscription";

export const VERIFIED_AICHM_META_PAGE_ID = "1096372060227919";

const GRAPH_ORIGIN = "https://graph.facebook.com";
const GRAPH_TIMEOUT_MS = 8_000;
const FORM_LIST_PAGE_SIZE = 100;
const MAX_FORM_LIST_PAGES = 5;

type ExpiryStatus = "not_checked" | "valid" | "expired" | "never_expires" | "unknown";
type SafeFailureCode =
  | "missing_configuration"
  | "invalid_configuration"
  | "configured_page_mismatch"
  | "authentication_rejected"
  | "permission_denied"
  | "leadgen_subscription_missing"
  | "approved_form_not_accessible"
  | "graph_request_failed"
  | "network_error"
  | "invalid_graph_response"
  | "form_list_incomplete";

export type MetaLeadAdsReadinessEnvironment = {
  META_PAGE_ID?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_PAGE_ACCESS_TOKEN?: string;
  META_GRAPH_API_VERSION?: string;
  META_ALLOWED_FORM_IDS?: string;
};

export type MetaLeadAdsReadinessReport = {
  checkedAt: string;
  configuredPageStatus: "missing" | "approved" | "mismatch";
  configuredPageIsAichmPage: boolean;
  tokenDebugChecked: boolean;
  tokenValid: boolean;
  tokenTypeIsPage: boolean;
  tokenBelongsToConfiguredApp: boolean;
  tokenExpiryStatus: ExpiryStatus;
  tokenExpiresAt: string | null;
  dataAccessExpiryStatus: ExpiryStatus;
  dataAccessExpiresAt: string | null;
  permissionsChecked: boolean;
  leadRetrievalPermission: boolean;
  pageSubscriptionPermission: boolean;
  pageIdentityChecked: boolean;
  pageIdentityMatches: boolean;
  subscriptionChecked: boolean;
  appInstalled: boolean;
  leadgenSubscribed: boolean;
  formAccessChecked: boolean;
  formAccessGranted: boolean;
  hasAccessibleForm: boolean;
  approvedFormAllowlistStatus: "missing" | "empty" | "invalid" | "configured";
  approvedFormCount: number;
  formCheckStatus: "not_checked" | "complete" | "incomplete" | "failed";
  accessibleApprovedFormCount: number;
  inaccessibleApprovedFormCount: number | null;
  allApprovedFormsAccessible: boolean | null;
  safeCode: SafeFailureCode | null;
};

type GraphResult =
  | { ok: true; body: unknown }
  | { ok: false; code: SafeFailureCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function graphUrl(version: string, path: string): URL {
  return new URL(`${GRAPH_ORIGIN}/${version}/${path}`);
}

async function graphGetJson(
  url: URL,
  accessToken: string,
  fetcher: MetaGraphFetch,
): Promise<GraphResult> {
  url.searchParams.set("access_token", accessToken);
  try {
    const response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        code: response.status === 401
          ? "authentication_rejected"
          : response.status === 403
            ? "permission_denied"
            : "graph_request_failed",
      };
    }
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, code: "invalid_graph_response" };
    }
  } catch {
    return { ok: false, code: "network_error" };
  }
}

function initialReport(
  environment: MetaLeadAdsReadinessEnvironment,
  now: Date,
): MetaLeadAdsReadinessReport {
  const pageId = environment.META_PAGE_ID?.trim() ?? "";
  const allowlist = getMetaAllowedFormIdsStatus(environment.META_ALLOWED_FORM_IDS);
  return {
    checkedAt: now.toISOString(),
    configuredPageStatus: !pageId
      ? "missing"
      : pageId === VERIFIED_AICHM_META_PAGE_ID
        ? "approved"
        : "mismatch",
    configuredPageIsAichmPage: pageId === VERIFIED_AICHM_META_PAGE_ID,
    tokenDebugChecked: false,
    tokenValid: false,
    tokenTypeIsPage: false,
    tokenBelongsToConfiguredApp: false,
    tokenExpiryStatus: "not_checked",
    tokenExpiresAt: null,
    dataAccessExpiryStatus: "not_checked",
    dataAccessExpiresAt: null,
    permissionsChecked: false,
    leadRetrievalPermission: false,
    pageSubscriptionPermission: false,
    pageIdentityChecked: false,
    pageIdentityMatches: false,
    subscriptionChecked: false,
    appInstalled: false,
    leadgenSubscribed: false,
    formAccessChecked: false,
    formAccessGranted: false,
    hasAccessibleForm: false,
    approvedFormAllowlistStatus: allowlist.status,
    approvedFormCount: allowlist.count,
    formCheckStatus: "not_checked",
    accessibleApprovedFormCount: 0,
    inaccessibleApprovedFormCount: null,
    allApprovedFormsAccessible: null,
    safeCode: null,
  };
}

function readExpiry(value: unknown, nowSeconds: number): {
  status: ExpiryStatus;
  timestamp: string | null;
  passes: boolean;
} {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { status: "unknown", timestamp: null, passes: false };
  }
  if (value === 0) {
    return { status: "never_expires", timestamp: null, passes: true };
  }
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) {
    return { status: "unknown", timestamp: null, passes: false };
  }
  return {
    status: value > nowSeconds ? "valid" : "expired",
    timestamp: date.toISOString(),
    passes: value > nowSeconds,
  };
}

function hasPermissionForPage(
  scope: string,
  scopes: Set<string>,
  granularScopes: unknown,
  pageId: string,
): boolean {
  if (!scopes.has(scope)) return false;
  if (!Array.isArray(granularScopes)) return true;
  const entries = granularScopes.filter((entry) =>
    isRecord(entry) && entry.scope === scope,
  );
  if (entries.length === 0) return true;
  return entries.some((entry) =>
    isRecord(entry) &&
    Array.isArray(entry.target_ids) &&
    entry.target_ids.includes(pageId),
  );
}

function setFirstSafeCode(
  report: MetaLeadAdsReadinessReport,
  code: SafeFailureCode,
) {
  report.safeCode ??= code;
}

async function inspectApprovedForms(
  pageId: string,
  graphVersion: string,
  pageToken: string,
  approvedFormIds: ReadonlySet<string>,
  fetcher: MetaGraphFetch,
  report: MetaLeadAdsReadinessReport,
): Promise<void> {
  const found = new Set<string>();
  let after: string | undefined;

  for (let page = 0; page < MAX_FORM_LIST_PAGES; page += 1) {
    const url = graphUrl(graphVersion, `${pageId}/leadgen_forms`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", String(FORM_LIST_PAGE_SIZE));
    if (after) url.searchParams.set("after", after);

    const result = await graphGetJson(url, pageToken, fetcher);
    if (!result.ok) {
      report.formCheckStatus = "failed";
      report.formAccessChecked = true;
      report.formAccessGranted = false;
      report.accessibleApprovedFormCount = found.size;
      report.hasAccessibleForm = found.size > 0;
      report.inaccessibleApprovedFormCount = null;
      report.allApprovedFormsAccessible = false;
      setFirstSafeCode(report, result.code);
      return;
    }
    if (!isRecord(result.body) || !Array.isArray(result.body.data)) {
      report.formCheckStatus = "failed";
      report.formAccessChecked = true;
      report.formAccessGranted = false;
      report.accessibleApprovedFormCount = found.size;
      report.hasAccessibleForm = found.size > 0;
      report.inaccessibleApprovedFormCount = null;
      report.allApprovedFormsAccessible = false;
      setFirstSafeCode(report, "invalid_graph_response");
      return;
    }

    for (const form of result.body.data) {
      if (!isRecord(form) || typeof form.id !== "string" || !/^[0-9]{1,40}$/.test(form.id)) {
        report.formCheckStatus = "failed";
        report.formAccessChecked = true;
        report.formAccessGranted = false;
        report.accessibleApprovedFormCount = found.size;
        report.hasAccessibleForm = found.size > 0;
        report.inaccessibleApprovedFormCount = null;
        report.allApprovedFormsAccessible = false;
        setFirstSafeCode(report, "invalid_graph_response");
        return;
      }
      if (approvedFormIds.has(form.id)) found.add(form.id);
    }
    if (found.size === approvedFormIds.size) {
      report.formCheckStatus = "complete";
      report.formAccessChecked = true;
      report.formAccessGranted = true;
      report.accessibleApprovedFormCount = found.size;
      report.hasAccessibleForm = found.size > 0;
      report.inaccessibleApprovedFormCount = 0;
      report.allApprovedFormsAccessible = true;
      return;
    }

    const paging = isRecord(result.body.paging) ? result.body.paging : null;
    const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null;
    const hasNext = !!paging && typeof paging.next === "string" && paging.next.length > 0;
    if (!hasNext) {
      const inaccessible = approvedFormIds.size - found.size;
      report.formCheckStatus = "complete";
      report.formAccessChecked = true;
      report.formAccessGranted = inaccessible === 0;
      report.accessibleApprovedFormCount = found.size;
      report.hasAccessibleForm = found.size > 0;
      report.inaccessibleApprovedFormCount = inaccessible;
      report.allApprovedFormsAccessible = inaccessible === 0;
      if (inaccessible > 0) setFirstSafeCode(report, "approved_form_not_accessible");
      return;
    }
    if (!cursors || typeof cursors.after !== "string" || !cursors.after || cursors.after.length > 2_000) {
      report.formCheckStatus = "incomplete";
      report.formAccessChecked = true;
      report.formAccessGranted = false;
      report.accessibleApprovedFormCount = found.size;
      report.hasAccessibleForm = found.size > 0;
      report.inaccessibleApprovedFormCount = null;
      report.allApprovedFormsAccessible = false;
      setFirstSafeCode(report, "form_list_incomplete");
      return;
    }
    after = cursors.after;
  }

  report.formCheckStatus = "incomplete";
  report.formAccessChecked = true;
  report.formAccessGranted = false;
  report.accessibleApprovedFormCount = found.size;
  report.hasAccessibleForm = found.size > 0;
  report.inaccessibleApprovedFormCount = null;
  report.allApprovedFormsAccessible = false;
  setFirstSafeCode(report, "form_list_incomplete");
}

export async function runMetaLeadAdsReadinessDiagnostic(
  environment: MetaLeadAdsReadinessEnvironment,
  options: {
    fetcher?: MetaGraphFetch;
    now?: () => Date;
  } = {},
): Promise<MetaLeadAdsReadinessReport> {
  const now = options.now ?? (() => new Date());
  const report = initialReport(environment, now());
  const pageId = environment.META_PAGE_ID?.trim() ?? "";
  const appId = environment.META_APP_ID?.trim() ?? "";
  const appSecret = environment.META_APP_SECRET?.trim() ?? "";
  const pageToken = environment.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
  const graphVersion = environment.META_GRAPH_API_VERSION?.trim() ?? "";
  const approvedFormIds = parseMetaAllowedFormIds(environment.META_ALLOWED_FORM_IDS);
  const fetcher = options.fetcher ?? fetch;

  if (!pageId || !appId || !appSecret || !pageToken || !graphVersion) {
    setFirstSafeCode(report, "missing_configuration");
    return report;
  }
  if (!/^[0-9]{1,32}$/.test(pageId) || !/^[0-9]{1,32}$/.test(appId) ||
      !/^v[0-9]+\.[0-9]+$/.test(graphVersion)) {
    setFirstSafeCode(report, "invalid_configuration");
    return report;
  }
  if (!report.configuredPageIsAichmPage) {
    setFirstSafeCode(report, "configured_page_mismatch");
    return report;
  }

  const appAccessToken = `${appId}|${appSecret}`;
  const debugUrl = graphUrl(graphVersion, "debug_token");
  debugUrl.searchParams.set("input_token", pageToken);
  const debugResult = await graphGetJson(debugUrl, appAccessToken, fetcher);
  if (!debugResult.ok) {
    setFirstSafeCode(report, debugResult.code);
    return report;
  }
  if (!isRecord(debugResult.body) || !isRecord(debugResult.body.data)) {
    setFirstSafeCode(report, "invalid_graph_response");
    return report;
  }

  const token = debugResult.body.data;
  report.tokenDebugChecked = true;
  report.tokenValid = token.is_valid === true;
  report.tokenTypeIsPage = token.type === "PAGE";
  report.tokenBelongsToConfiguredApp = token.app_id === appId;
  const nowSeconds = Math.floor(now().getTime() / 1_000);
  const tokenExpiry = readExpiry(token.expires_at, nowSeconds);
  const dataAccessExpiry = readExpiry(token.data_access_expires_at, nowSeconds);
  report.tokenExpiryStatus = tokenExpiry.status;
  report.tokenExpiresAt = tokenExpiry.timestamp;
  report.dataAccessExpiryStatus = dataAccessExpiry.status;
  report.dataAccessExpiresAt = dataAccessExpiry.timestamp;

  if (Array.isArray(token.scopes) && token.scopes.every((scope) => typeof scope === "string")) {
    const scopes = new Set(token.scopes as string[]);
    report.permissionsChecked = true;
    report.leadRetrievalPermission = hasPermissionForPage(
      "leads_retrieval", scopes, token.granular_scopes, pageId,
    );
    report.pageSubscriptionPermission = hasPermissionForPage(
      "pages_manage_metadata", scopes, token.granular_scopes, pageId,
    );
  }

  if (!report.tokenValid) {
    setFirstSafeCode(report, "authentication_rejected");
    return report;
  }
  if (!report.tokenTypeIsPage) {
    setFirstSafeCode(report, "authentication_rejected");
    return report;
  }
  if (!report.tokenBelongsToConfiguredApp) {
    setFirstSafeCode(report, "authentication_rejected");
    return report;
  }
  if (!tokenExpiry.passes || !dataAccessExpiry.passes) {
    setFirstSafeCode(report, tokenExpiry.status === "expired" || dataAccessExpiry.status === "expired"
      ? "authentication_rejected"
      : "invalid_graph_response");
    return report;
  }

  const identityUrl = graphUrl(graphVersion, "me");
  identityUrl.searchParams.set("fields", "id");
  const identityResult = await graphGetJson(identityUrl, pageToken, fetcher);
  if (!identityResult.ok) {
    setFirstSafeCode(report, identityResult.code);
    return report;
  }
  if (!isRecord(identityResult.body) || typeof identityResult.body.id !== "string") {
    setFirstSafeCode(report, "invalid_graph_response");
    return report;
  }
  report.pageIdentityChecked = true;
  report.pageIdentityMatches = identityResult.body.id === pageId;
  if (!report.pageIdentityMatches) {
    setFirstSafeCode(report, "configured_page_mismatch");
    return report;
  }

  const subscriptionUrl = graphUrl(graphVersion, `${pageId}/subscribed_apps`);
  subscriptionUrl.searchParams.set("fields", "id,subscribed_fields");
  const subscriptionResult = await graphGetJson(subscriptionUrl, pageToken, fetcher);
  if (!subscriptionResult.ok) {
    setFirstSafeCode(report, subscriptionResult.code);
  } else if (!isRecord(subscriptionResult.body) || !Array.isArray(subscriptionResult.body.data)) {
    setFirstSafeCode(report, "invalid_graph_response");
  } else {
    report.subscriptionChecked = true;
    const app = subscriptionResult.body.data.find((item) =>
      isRecord(item) && item.id === appId,
    );
    if (app && isRecord(app) && Array.isArray(app.subscribed_fields)) {
      report.appInstalled = true;
      report.leadgenSubscribed = app.subscribed_fields.includes("leadgen");
    }
    if (!report.leadgenSubscribed) setFirstSafeCode(report, "leadgen_subscription_missing");
  }

  if (approvedFormIds) {
    await inspectApprovedForms(
      pageId, graphVersion, pageToken, approvedFormIds, fetcher, report,
    );
  }
  return report;
}
