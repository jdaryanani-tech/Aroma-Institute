export const META_PAGE_SUBSCRIBE_CONFIRM_ENV = "AICHM_META_PAGE_SUBSCRIBE_CONFIRM";
export const META_PAGE_SUBSCRIBE_CONFIRM_VALUE =
  "SUBSCRIBE_LEADGEN_FOR_CONFIGURED_DEVELOPMENT_PAGE";

const GRAPH_ORIGIN = "https://graph.facebook.com";
const GRAPH_TIMEOUT_MS = 8_000;

const ERROR_CATEGORIES = [
  "missing_configuration",
  "invalid_configuration",
  "confirmation_required",
  "page_identity_mismatch",
  "permission_denied",
  "authentication_rejected",
  "rate_limited",
  "request_rejected",
  "graph_unavailable",
  "network_error",
  "invalid_response",
  "subscribe_rejected",
  "verification_failed",
  "unexpected_failure",
] as const;

export type MetaPageSubscriptionErrorCategory = (typeof ERROR_CATEGORIES)[number];

type SubscriptionEnvironment = Pick<
  NodeJS.ProcessEnv,
  "META_PAGE_ID" | "META_APP_ID" | "META_PAGE_ACCESS_TOKEN" | "META_GRAPH_API_VERSION"
>;

type GraphResponse = Pick<Response, "ok" | "status" | "json">;
export type MetaGraphFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<GraphResponse>;

export type MetaPageSubscriptionResult = {
  pageIdPresent: boolean;
  appIdPresent: boolean;
  pageAccessTokenPresent: boolean;
  graphApiVersionPresent: boolean;
  graphApiVersionValid: boolean;
  configurationReady: boolean;
  pageIdentityChecked: boolean;
  pageIdentityMatches: boolean;
  subscriptionChecked: boolean;
  appInstalled: boolean;
  leadgenSubscribed: boolean;
  postAttempted: boolean;
  postSucceeded: boolean;
  verificationChecked: boolean;
  verified: boolean;
  errorCategory?: MetaPageSubscriptionErrorCategory;
};

type Config = {
  pageId: string;
  appId: string;
  accessToken: string;
  graphVersion: string;
};

type ExistingSubscription = {
  appInstalled: boolean;
  fields: string[];
};

type SafeFailure = {
  safeMetaPageSubscriptionFailure: true;
  category: MetaPageSubscriptionErrorCategory;
};

function throwSafe(category: MetaPageSubscriptionErrorCategory): never {
  const error: SafeFailure = { safeMetaPageSubscriptionFailure: true, category };
  throw error;
}

function safeFailureCategory(error: unknown): MetaPageSubscriptionErrorCategory {
  if (!error || typeof error !== "object") return "unexpected_failure";
  const candidate = error as Partial<SafeFailure>;
  return candidate.safeMetaPageSubscriptionFailure === true &&
    typeof candidate.category === "string" &&
    ERROR_CATEGORIES.includes(candidate.category as MetaPageSubscriptionErrorCategory)
    ? candidate.category as MetaPageSubscriptionErrorCategory
    : "unexpected_failure";
}

function readConfig(environment: SubscriptionEnvironment): {
  config: Config | null;
  result: MetaPageSubscriptionResult;
} {
  const pageId = environment.META_PAGE_ID?.trim() ?? "";
  const appId = environment.META_APP_ID?.trim() ?? "";
  const accessToken = environment.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
  const graphVersion = environment.META_GRAPH_API_VERSION?.trim() ?? "";
  const graphApiVersionValid = /^v[0-9]+\.[0-9]+$/.test(graphVersion);
  const pageIdValid = /^[0-9]{1,32}$/.test(pageId);
  const appIdValid = /^[0-9]{1,32}$/.test(appId);
  const configurationReady =
    !!pageId && !!appId && !!accessToken && graphApiVersionValid && pageIdValid && appIdValid;

  return {
    config: configurationReady ? { pageId, appId, accessToken, graphVersion } : null,
    result: {
      pageIdPresent: !!pageId,
      appIdPresent: !!appId,
      pageAccessTokenPresent: !!accessToken,
      graphApiVersionPresent: !!graphVersion,
      graphApiVersionValid,
      configurationReady,
      pageIdentityChecked: false,
      pageIdentityMatches: false,
      subscriptionChecked: false,
      appInstalled: false,
      leadgenSubscribed: false,
      postAttempted: false,
      postSucceeded: false,
      verificationChecked: false,
      verified: false,
    },
  };
}

function graphUrl(version: string, path: string): URL {
  return new URL(`${GRAPH_ORIGIN}/${version}/${path}`);
}

async function graphGet(
  url: URL,
  accessToken: string,
  fetcher: MetaGraphFetch,
): Promise<unknown> {
  url.searchParams.set("access_token", accessToken);
  let response: GraphResponse;
  try {
    response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch {
    throwSafe("network_error");
  }
  if (!response.ok) throwSafe(classifyHttpFailure(response.status));
  try {
    return await response.json();
  } catch {
    throwSafe("invalid_response");
  }
}

function classifyHttpFailure(status: number): MetaPageSubscriptionErrorCategory {
  if (status === 401) return "authentication_rejected";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "graph_unavailable";
  return "request_rejected";
}

async function verifyPageIdentity(
  config: Config,
  fetcher: MetaGraphFetch,
): Promise<boolean> {
  const url = graphUrl(config.graphVersion, "me");
  url.searchParams.set("fields", "id");
  const body = await graphGet(url, config.accessToken, fetcher);
  if (!body || typeof body !== "object" || typeof (body as { id?: unknown }).id !== "string") {
    throwSafe("invalid_response");
  }
  return (body as { id: string }).id === config.pageId;
}

async function readExistingSubscription(
  config: Config,
  fetcher: MetaGraphFetch,
): Promise<ExistingSubscription> {
  const url = graphUrl(config.graphVersion, `${config.pageId}/subscribed_apps`);
  url.searchParams.set("fields", "subscribed_fields");
  const body = await graphGet(
    url,
    config.accessToken,
    fetcher,
  );
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throwSafe("invalid_response");
  }

  const apps = (body as { data: unknown[] }).data;
  const app = apps.find((item) =>
    !!item && typeof item === "object" &&
    (item as { id?: unknown }).id === config.appId,
  );
  if (!app) return { appInstalled: false, fields: [] };

  const fields = (app as { subscribed_fields?: unknown }).subscribed_fields;
  if (!Array.isArray(fields) || fields.some(
    (field) => typeof field !== "string" || !/^[a-z_]{1,64}$/.test(field),
  ) || fields.length > 100) {
    throwSafe("invalid_response");
  }
  const uniqueFields = (fields as string[]).filter(
    (field, index, values) => values.indexOf(field) === index,
  );
  return { appInstalled: true, fields: uniqueFields };
}

async function postSubscription(
  config: Config,
  fields: string[],
  fetcher: MetaGraphFetch,
): Promise<void> {
  const body = new URLSearchParams({
    access_token: config.accessToken,
    subscribed_fields: fields.join(","),
  });
  let response: GraphResponse;
  try {
    response = await fetcher(
      graphUrl(config.graphVersion, `${config.pageId}/subscribed_apps`),
      {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      },
    );
  } catch {
    throwSafe("network_error");
  }
  if (!response.ok) throwSafe(classifyHttpFailure(response.status));

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throwSafe("invalid_response");
  }
  if (!result || typeof result !== "object" || (result as { success?: unknown }).success !== true) {
    throwSafe("subscribe_rejected");
  }
}

export async function runMetaPageSubscription(
  environment: SubscriptionEnvironment,
  options: {
    apply: boolean;
    confirmationMatches: boolean;
    fetcher?: MetaGraphFetch;
  },
): Promise<MetaPageSubscriptionResult> {
  const { config, result: initial } = readConfig(environment);
  if (!config) {
    const hasMissingValue = !initial.pageIdPresent || !initial.appIdPresent ||
      !initial.pageAccessTokenPresent || !initial.graphApiVersionPresent;
    return {
      ...initial,
      errorCategory: hasMissingValue ? "missing_configuration" : "invalid_configuration",
    };
  }
  if (options.apply && !options.confirmationMatches) {
    return { ...initial, errorCategory: "confirmation_required" };
  }

  const fetcher = options.fetcher ?? fetch;
  let result = initial;
  try {
    const pageIdentityMatches = await verifyPageIdentity(config, fetcher);
    result = { ...result, pageIdentityChecked: true, pageIdentityMatches };
    if (!pageIdentityMatches) {
      return { ...result, errorCategory: "page_identity_mismatch" };
    }

    const existing = await readExistingSubscription(config, fetcher);
    const leadgenSubscribed = existing.appInstalled && existing.fields.includes("leadgen");
    result = {
      ...result,
      subscriptionChecked: true,
      appInstalled: existing.appInstalled,
      leadgenSubscribed,
      verified: leadgenSubscribed,
    };
    if (leadgenSubscribed || !options.apply) return result;

    // Preserve existing subscriptions while adding leadgen.
    const fields = existing.fields.includes("leadgen")
      ? existing.fields
      : existing.fields.concat("leadgen");
    result = { ...result, postAttempted: true };
    await postSubscription(config, fields, fetcher);
    result = { ...result, postSucceeded: true };

    const verified = await readExistingSubscription(config, fetcher);
    const postVerified = verified.appInstalled && verified.fields.includes("leadgen");
    result = {
      ...result,
      subscriptionChecked: true,
      appInstalled: verified.appInstalled,
      leadgenSubscribed: postVerified,
      verificationChecked: true,
      verified: postVerified,
    };
    return postVerified ? result : { ...result, errorCategory: "verification_failed" };
  } catch (error) {
    return { ...result, errorCategory: safeFailureCategory(error) };
  }
}

