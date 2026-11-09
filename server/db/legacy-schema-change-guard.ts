import path from "node:path";

export type LegacySchemaChangeIntent = "development" | "disposable-test";
export type LegacySchemaGuardEnvironment = Record<string, string | undefined>;

export class LegacySchemaGuardError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacySchemaGuardError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const SOCKET_TEST_DATABASES = new Set([
  "admin_session_test",
  "first_owner_test",
  "follow_up_test",
]);
const DEVELOPMENT_DATABASES = new Set(["aichm_dev_local"]);
const LOOPBACK_TEST_DATABASE = /^aichm_test_[a-z0-9_]+$/;

function fail(code: string): never {
  throw new LegacySchemaGuardError(code);
}

function databaseName(url: URL): string {
  try {
    const value = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!value || value.includes("/")) fail("SCHEMA_GUARD_TARGET_REJECTED");
    return value;
  } catch {
    return fail("SCHEMA_GUARD_TARGET_REJECTED");
  }
}

function isLoopbackTarget(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

function requireLocalPort(value: string | undefined): void {
  if (value === undefined || value === "") return;
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
    fail("SCHEMA_GUARD_TARGET_REJECTED");
  }
}

function validateLocalQuery(url: URL): void {
  const entries = Array.from(url.searchParams.entries());
  const sslModes = entries.filter(([key]) => key.toLowerCase() === "sslmode");
  if (
    entries.some(([key]) => key !== "sslmode") ||
    sslModes.length > 1 ||
    (sslModes.length === 1 &&
      (sslModes[0][0] !== "sslmode" || sslModes[0][1] !== "disable"))
  ) {
    fail("SCHEMA_GUARD_TARGET_REJECTED");
  }
}

/**
 * Only local loopback development databases and known socket-only disposable
 * test clusters are accepted. This deliberately rejects remote development
 * hosts: URL shape alone cannot prove that an arbitrary remote is non-production.
 */
export function validateLegacySchemaChangeTarget(
  environment: LegacySchemaGuardEnvironment = process.env,
): { url: string; database: string; intent: LegacySchemaChangeIntent } {
  const intent = environment.AICHM_SCHEMA_CHANGE_INTENT;
  if (intent !== "development" && intent !== "disposable-test") {
    fail("SCHEMA_GUARD_EXPLICIT_DEVELOPMENT_INTENT_REQUIRED");
  }
  if (environment.NODE_ENV === "production") {
    fail("SCHEMA_GUARD_PRODUCTION_RUNTIME_REJECTED");
  }

  const raw = environment.AICHM_DEVELOPMENT_DATABASE_URL;
  if (!raw || raw.trim() !== raw || /[\r\n]/.test(raw)) {
    fail("SCHEMA_GUARD_DEVELOPMENT_DATABASE_URL_REQUIRED");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("SCHEMA_GUARD_TARGET_REJECTED");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !url.username ||
    url.hash
  ) {
    fail("SCHEMA_GUARD_TARGET_REJECTED");
  }

  const database = databaseName(url);
  const socketPath = url.searchParams.get("host");
  const isSocketUrl = url.hostname.toLowerCase() === "localhost" && socketPath !== null;

  if (isSocketUrl) {
    const expectedRoot = path.resolve(process.cwd(), "generated-artifacts") + path.sep;
    const resolvedSocketPath = path.resolve(socketPath);
    const queryEntries = Array.from(url.searchParams.entries());
    const socketPort = url.searchParams.get("port");
    const queryIsValid =
      queryEntries.every(([key]) => key === "host" || key === "port") &&
      queryEntries.filter(([key]) => key === "host").length === 1 &&
      queryEntries.filter(([key]) => key === "port").length === 1;
    requireLocalPort(socketPort ?? undefined);
    if (
      intent !== "disposable-test" ||
      environment.NODE_ENV !== "test" ||
      !SOCKET_TEST_DATABASES.has(database) ||
      url.password ||
      !resolvedSocketPath.startsWith(expectedRoot) ||
      !socketPort ||
      !queryIsValid
    ) {
      fail("SCHEMA_GUARD_TARGET_REJECTED");
    }
    return { url: raw, database, intent };
  }

  if (!isLoopbackTarget(url)) fail("SCHEMA_GUARD_NON_LOOPBACK_TARGET_REJECTED");
  if (url.searchParams.has("host")) fail("SCHEMA_GUARD_TARGET_REJECTED");
  validateLocalQuery(url);
  requireLocalPort(url.port || undefined);

  if (intent === "development" && !DEVELOPMENT_DATABASES.has(database)) {
    fail("SCHEMA_GUARD_UNKNOWN_DEVELOPMENT_DATABASE");
  }
  if (intent === "disposable-test") {
    if (environment.NODE_ENV !== "test" || !LOOPBACK_TEST_DATABASE.test(database)) {
      fail("SCHEMA_GUARD_TARGET_REJECTED");
    }
  }

  return { url: raw, database, intent };
}

export function requireGuardedDrizzleConfigUrl(
  environment: LegacySchemaGuardEnvironment = process.env,
): string {
  return validateLegacySchemaChangeTarget(environment).url;
}
