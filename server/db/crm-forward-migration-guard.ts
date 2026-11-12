import { isIP } from "node:net";

export type CrmForwardDatabaseIdentity = {
  databaseName: string;
  databaseOid: string;
  databaseUser: string;
  systemIdentifier: string;
  inRecovery: boolean;
  defaultTransactionReadOnly: boolean;
};

export type CrmForwardEnvironment = Record<string, string | undefined>;

export const CRM_FORWARD_GUARD_ERROR_CODES = Object.freeze({
  dedicatedUrlRequired: "CRM_FORWARD_INTERNAL_DEVELOPMENT_AICHM_URL_REQUIRED",
  runtimeUrlRequired: "CRM_FORWARD_INTERNAL_DEVELOPMENT_RUNTIME_URL_REQUIRED",
  dedicatedUrlInvalid: "CRM_FORWARD_INTERNAL_DEVELOPMENT_AICHM_URL_INVALID",
  runtimeUrlInvalid: "CRM_FORWARD_INTERNAL_DEVELOPMENT_RUNTIME_URL_INVALID",
  endpointMustBeInternal: "CRM_FORWARD_INTERNAL_DEVELOPMENT_ENDPOINT_REQUIRED",
  endpointMismatch: "CRM_FORWARD_INTERNAL_DEVELOPMENT_ENDPOINT_MISMATCH",
  nonTlsOnly: "CRM_FORWARD_INTERNAL_DEVELOPMENT_SSLMODE_DISABLE_REQUIRED",
});

export const CRM_FORWARD_DEVELOPMENT_IDENTITY = Object.freeze({
  databaseName: "heliumdb",
  databaseOid: "16384",
  databaseUser: "postgres",
  systemIdentifier: "7609038573599248406",
});

const KNOWN_PRODUCTION_IDENTITY = Object.freeze({
  databaseName: "neondb",
  databaseOid: "16395",
  databaseUser: "neondb_owner",
});

function fail(code: string): never {
  const error = new Error(code) as Error & { code: string };
  Object.defineProperty(error, "code", { value: code, enumerable: false });
  throw error;
}

export function crmForwardEffectivePort(url: URL): number {
  if (url.port === "") return 5432;
  if (!/^\d+$/.test(url.port)) fail(CRM_FORWARD_GUARD_ERROR_CODES.dedicatedUrlInvalid);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(CRM_FORWARD_GUARD_ERROR_CODES.dedicatedUrlInvalid);
  }
  return port;
}

type ParsedEndpoint = {
  url: URL;
  host: string;
  port: number;
  username: string;
  database: string;
};

const ENDPOINT_OVERRIDE_PARAMETERS = new Set([
  "host",
  "port",
  "user",
  "username",
  "database",
  "db",
  "password",
]);

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isInternalPrivateHost(host: string): boolean {
  const normalized = normalizeHost(host);
  const ipVersion = isIP(normalized);

  if (ipVersion === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }

  if (ipVersion === 6) return false;

  const labels = normalized.split(".");
  if (
    !normalized ||
    normalized.length > 253 ||
    labels.some(label =>
      label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  ) {
    return false;
  }

  return normalized === "helium" || normalized.endsWith(".internal");
}

function parseEndpoint(
  raw: string | undefined,
  source: "dedicated" | "runtime",
): ParsedEndpoint {
  const invalidCode = source === "dedicated"
    ? CRM_FORWARD_GUARD_ERROR_CODES.dedicatedUrlInvalid
    : CRM_FORWARD_GUARD_ERROR_CODES.runtimeUrlInvalid;
  const requiredCode = source === "dedicated"
    ? CRM_FORWARD_GUARD_ERROR_CODES.dedicatedUrlRequired
    : CRM_FORWARD_GUARD_ERROR_CODES.runtimeUrlRequired;
  if (!raw || raw.trim() !== raw || /[\r\n]/.test(raw)) fail(requiredCode);

  let url: URL;
  try {
    if (raw.includes("#")) fail(invalidCode);
    url = new URL(raw);
  } catch {
    return fail(invalidCode);
  }

  let database: string;
  let username: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    username = decodeURIComponent(url.username);
  } catch {
    return fail(invalidCode);
  }

  if (url.protocol !== "postgresql:" || !url.hostname || url.hash) fail(invalidCode);

  if (
    source === "runtime" &&
    Array.from(url.searchParams.keys()).some(key => ENDPOINT_OVERRIDE_PARAMETERS.has(key))
  ) {
    fail(invalidCode);
  }

  const host = normalizeHost(url.hostname);
  let port: number;
  try {
    port = crmForwardEffectivePort(url);
  } catch {
    fail(invalidCode);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) fail(invalidCode);
  return { url, host, port, username, database };
}

export function requireCrmForwardConnectionUrl(
  environment: CrmForwardEnvironment = process.env,
): string {
  // DATABASE_URL is a compare-only reference; the returned connection source is
  // always the dedicated AICHM variable.
  const dedicatedRaw = environment.AICHM_CRM_FORWARD_DATABASE_URL;
  const runtimeRaw = environment.DATABASE_URL;
  const dedicated = parseEndpoint(dedicatedRaw, "dedicated");
  const runtime = parseEndpoint(runtimeRaw, "runtime");

  const queryEntries = Array.from(dedicated.url.searchParams.entries());
  if (
    queryEntries.length !== 1 ||
    queryEntries[0][0] !== "sslmode" ||
    queryEntries[0][1] !== "disable"
  ) {
    fail(CRM_FORWARD_GUARD_ERROR_CODES.nonTlsOnly);
  }

  if (
    !isInternalPrivateHost(dedicated.host) ||
    !isInternalPrivateHost(runtime.host)
  ) {
    fail(CRM_FORWARD_GUARD_ERROR_CODES.endpointMustBeInternal);
  }

  if (
    dedicated.host !== runtime.host ||
    dedicated.port !== runtime.port ||
    dedicated.username !== runtime.username ||
    dedicated.database !== runtime.database
  ) {
    fail(CRM_FORWARD_GUARD_ERROR_CODES.endpointMismatch);
  }

  if (
    dedicated.username !== CRM_FORWARD_DEVELOPMENT_IDENTITY.databaseUser ||
    dedicated.database !== CRM_FORWARD_DEVELOPMENT_IDENTITY.databaseName
  ) {
    fail(CRM_FORWARD_GUARD_ERROR_CODES.endpointMismatch);
  }

  return dedicatedRaw!;
}

export function assertCrmForwardDevelopmentIdentity(
  identity: CrmForwardDatabaseIdentity,
): void {
  if (
    identity.databaseName === KNOWN_PRODUCTION_IDENTITY.databaseName &&
    identity.databaseOid === KNOWN_PRODUCTION_IDENTITY.databaseOid &&
    identity.databaseUser === KNOWN_PRODUCTION_IDENTITY.databaseUser
  ) {
    fail("CRM_FORWARD_PRODUCTION_IDENTITY_REJECTED");
  }

  const expected = CRM_FORWARD_DEVELOPMENT_IDENTITY;
  if (
    identity.databaseName !== expected.databaseName ||
    identity.databaseOid !== expected.databaseOid ||
    identity.databaseUser !== expected.databaseUser ||
    identity.systemIdentifier !== expected.systemIdentifier ||
    identity.inRecovery ||
    identity.defaultTransactionReadOnly
  ) {
    fail("CRM_FORWARD_DEVELOPMENT_IDENTITY_MISMATCH");
  }
}
