import { createHash } from "node:crypto";
import path from "node:path";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { Pool, type PoolConfig } from "pg";
import { buildAichmSourcePoolConfig } from "./aichm-source-migration";

export type LegacySchemaChangeIntent = "development" | "disposable-test";

export type SchemaDatabaseIdentity = {
  database: string;
  role: string;
  serverAddress: string | null;
  serverPort: number | null;
  serverVersionNum: number;
  inRecovery: boolean;
  transactionReadOnly: boolean;
};

export type DevelopmentTarget = {
  url: string;
  config: PoolConfig;
  database: string;
  endpointHost: string;
  endpointPort: number;
  socketOnly: boolean;
};

export type LegacySchemaGuardEnvironment = Record<string, string | undefined>;

export type LegacySchemaGuardDependencies = {
  readProductionIdentity: (
    environment: LegacySchemaGuardEnvironment,
  ) => Promise<{ identity: SchemaDatabaseIdentity; endpointHost: string; endpointPort: number }>;
  readDevelopmentIdentity: (
    target: DevelopmentTarget,
  ) => Promise<SchemaDatabaseIdentity>;
};

export class LegacySchemaGuardError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacySchemaGuardError";
  }
}

const LOCAL_TEST_DATABASES = new Set([
  "admin_session_test",
  "first_owner_test",
  "follow_up_test",
]);
const SAFE_ID_PATTERN = /^[0-9a-f]{64}$/;

function fail(code: string): never {
  throw new LegacySchemaGuardError(code);
}

function parseDatabasePath(url: URL): string {
  try {
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!database || database.includes("/")) fail("SCHEMA_GUARD_TARGET_URL_INVALID");
    return database;
  } catch {
    return fail("SCHEMA_GUARD_TARGET_URL_INVALID");
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9]\d{0,4}$/.test(value)) fail("SCHEMA_GUARD_TARGET_URL_INVALID");
  const port = Number(value);
  if (port > 65535) fail("SCHEMA_GUARD_TARGET_URL_INVALID");
  return port;
}

function validateIntent(environment: LegacySchemaGuardEnvironment): LegacySchemaChangeIntent {
  const intent = environment.AICHM_SCHEMA_CHANGE_INTENT;
  if (intent !== "development" && intent !== "disposable-test") {
    fail("SCHEMA_GUARD_EXPLICIT_DEVELOPMENT_INTENT_REQUIRED");
  }
  if (environment.NODE_ENV === "production") {
    fail("SCHEMA_GUARD_PRODUCTION_RUNTIME_REJECTED");
  }
  if (intent === "disposable-test" && environment.NODE_ENV !== "test") {
    fail("SCHEMA_GUARD_DISPOSABLE_TEST_INTENT_REQUIRES_TEST_MODE");
  }
  return intent;
}

function parseDevelopmentTarget(
  environment: LegacySchemaGuardEnvironment,
): DevelopmentTarget {
  const raw = environment.AICHM_DEVELOPMENT_DATABASE_URL;
  if (!raw || raw.trim() !== raw || /[\r\n]/.test(raw)) {
    return fail("SCHEMA_GUARD_DEVELOPMENT_DATABASE_URL_REQUIRED");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("SCHEMA_GUARD_TARGET_URL_INVALID");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !url.username ||
    url.hash
  ) {
    return fail("SCHEMA_GUARD_TARGET_URL_INVALID");
  }

  const database = parseDatabasePath(url);
  const queryEntries = Array.from(url.searchParams.entries());
  const socketPath = url.searchParams.get("host");
  const socketOnly = url.hostname === "localhost" && socketPath !== null;

  if (socketOnly) {
    const expectedRoot = path.resolve(process.cwd(), "generated-artifacts") + path.sep;
    const resolvedSocketPath = path.resolve(socketPath);
    const socketPort = url.searchParams.get("port");
    const allowedKeys = queryEntries.every(([key]) => key === "host" || key === "port");
    if (
      environment.AICHM_SCHEMA_CHANGE_INTENT !== "disposable-test" ||
      !LOCAL_TEST_DATABASES.has(database) ||
      url.password ||
      !resolvedSocketPath.startsWith(expectedRoot) ||
      !socketPort ||
      !allowedKeys ||
      queryEntries.filter(([key]) => key === "host").length !== 1 ||
      queryEntries.filter(([key]) => key === "port").length !== 1
    ) {
      fail("SCHEMA_GUARD_LOCAL_SOCKET_TARGET_REJECTED");
    }
    const endpointPort = parsePort(socketPort, 0);
    return {
      url: raw,
      config: { connectionString: raw, application_name: "aichm-guarded-disposable-test" },
      database,
      endpointHost: `unix:${resolvedSocketPath}`,
      endpointPort,
      socketOnly: true,
    };
  }

  const sslModes = queryEntries.filter(([key]) => key.toLowerCase() === "sslmode");
  const otherSslOptions = queryEntries.filter(
    ([key]) => /^ssl(?:_|$)/i.test(key) && key.toLowerCase() !== "sslmode",
  );
  if (
    !url.password ||
    sslModes.length !== 1 ||
    sslModes[0][0] !== "sslmode" ||
    sslModes[0][1] !== "require" ||
    otherSslOptions.length > 0 ||
    queryEntries.some(([key]) => key !== "sslmode")
  ) {
    fail("SCHEMA_GUARD_REMOTE_TARGET_TLS_OR_QUERY_REJECTED");
  }

  url.searchParams.delete("sslmode");
  const ssl: ConnectionOptions = Object.freeze({
    rejectUnauthorized: true,
    checkServerIdentity,
    minVersion: "TLSv1.2",
  });
  return {
    url: raw,
    config: {
      connectionString: url.toString(),
      ssl,
      application_name: "aichm-guarded-development-schema-change",
    },
    database,
    endpointHost: url.hostname.toLowerCase(),
    endpointPort: parsePort(url.port, 5432),
    socketOnly: false,
  };
}

export function legacySchemaIdentityFingerprint(
  identity: SchemaDatabaseIdentity,
  endpointHost: string,
  endpointPort: number,
): string {
  const canonical = JSON.stringify({
    database: identity.database,
    role: identity.role,
    endpointHost,
    endpointPort,
    serverAddress: identity.serverAddress,
    serverPort: identity.serverPort,
    serverVersionNum: identity.serverVersionNum,
    inRecovery: identity.inRecovery,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function identitiesMatchProduction(
  production: { identity: SchemaDatabaseIdentity; endpointHost: string; endpointPort: number },
  target: DevelopmentTarget,
  development: SchemaDatabaseIdentity,
): boolean {
  if (production.identity.database !== development.database) return false;
  const sameEndpoint =
    production.endpointHost.toLowerCase() === target.endpointHost.toLowerCase() &&
    production.endpointPort === target.endpointPort;
  const sameServer =
    production.identity.serverAddress !== null &&
    development.serverAddress !== null &&
    production.identity.serverAddress === development.serverAddress &&
    production.identity.serverPort === development.serverPort;
  return sameEndpoint || sameServer;
}

async function readIdentityFromPool(pool: Pool): Promise<SchemaDatabaseIdentity> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    const result = await client.query<{
      database: string;
      role: string;
      server_address: string | null;
      server_port: number | null;
      server_version_num: number;
      in_recovery: boolean;
      transaction_read_only: string;
    }>(`
      SELECT current_database() AS database,
             current_user AS role,
             inet_server_addr()::text AS server_address,
             inet_server_port() AS server_port,
             current_setting('server_version_num')::integer AS server_version_num,
             pg_is_in_recovery() AS in_recovery,
             current_setting('transaction_read_only') AS transaction_read_only
    `);
    const row = result.rows[0];
    if (!row) fail("SCHEMA_GUARD_DATABASE_IDENTITY_UNAVAILABLE");
    return {
      database: row.database,
      role: row.role,
      serverAddress: row.server_address,
      serverPort: row.server_port,
      serverVersionNum: Number(row.server_version_num),
      inRecovery: row.in_recovery,
      transactionReadOnly: row.transaction_read_only === "on",
    };
  } catch (error) {
    if (error instanceof LegacySchemaGuardError) throw error;
    return fail("SCHEMA_GUARD_DATABASE_IDENTITY_UNAVAILABLE");
  } finally {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function readProductionIdentity(
  environment: LegacySchemaGuardEnvironment,
): Promise<{ identity: SchemaDatabaseIdentity; endpointHost: string; endpointPort: number }> {
  let pool: Pool;
  let sourceUrl: URL;
  try {
    const raw = environment.AICHM_SOURCE_PROD_DATABASE_URL;
    if (!raw) fail("SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE");
    sourceUrl = new URL(raw);
    pool = new Pool(buildAichmSourcePoolConfig(environment));
  } catch {
    return fail("SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE");
  }

  try {
    const identity = await readIdentityFromPool(pool);
    if (
      identity.database !== "neondb" ||
      identity.inRecovery ||
      !identity.transactionReadOnly
    ) {
      fail("SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE");
    }
    return {
      identity,
      endpointHost: sourceUrl.hostname.toLowerCase(),
      endpointPort: parsePort(sourceUrl.port, 5432),
    };
  } catch {
    return fail("SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function readDevelopmentIdentity(target: DevelopmentTarget): Promise<SchemaDatabaseIdentity> {
  const pool = new Pool(target.config);
  try {
    const identity = await readIdentityFromPool(pool);
    if (identity.inRecovery || !identity.transactionReadOnly) {
      fail("SCHEMA_GUARD_TARGET_IDENTITY_UNAVAILABLE");
    }
    return identity;
  } catch {
    return fail("SCHEMA_GUARD_TARGET_IDENTITY_UNAVAILABLE");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const defaultDependencies: LegacySchemaGuardDependencies = {
  readProductionIdentity,
  readDevelopmentIdentity,
};

export async function verifyLegacySchemaChangeTarget(
  environment: LegacySchemaGuardEnvironment = process.env,
  dependencies: LegacySchemaGuardDependencies = defaultDependencies,
  options: { allowMissingDevelopmentId?: boolean } = {},
): Promise<{ targetUrl: string; targetIdentityId: string; intent: LegacySchemaChangeIntent }> {
  const intent = validateIntent(environment);
  const target = parseDevelopmentTarget(environment);

  let production: Awaited<ReturnType<typeof readProductionIdentity>>;
  try {
    production = await dependencies.readProductionIdentity(environment);
  } catch {
    return fail("SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE");
  }

  const sourceUri = environment.AICHM_SOURCE_PROD_DATABASE_URL;
  let sourceUrl: URL;
  try {
    if (!sourceUri) fail("SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE");
    sourceUrl = new URL(sourceUri);
  } catch {
    return fail("SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE");
  }
  const sameConfiguredEndpoint =
    sourceUrl.hostname.toLowerCase() === target.endpointHost.toLowerCase() &&
    parsePort(sourceUrl.port, 5432) === target.endpointPort &&
    decodeURIComponent(sourceUrl.pathname.replace(/^\/+/, "")) === target.database;
  if (sameConfiguredEndpoint) fail("SCHEMA_GUARD_PRODUCTION_TARGET_REJECTED");

  let targetIdentity: SchemaDatabaseIdentity;
  try {
    targetIdentity = await dependencies.readDevelopmentIdentity(target);
  } catch {
    return fail("SCHEMA_GUARD_TARGET_IDENTITY_UNAVAILABLE");
  }
  if (
    identitiesMatchProduction(production, target, targetIdentity) ||
    targetIdentity.database === "neondb"
  ) {
    fail("SCHEMA_GUARD_PRODUCTION_TARGET_REJECTED");
  }

  const targetIdentityId = legacySchemaIdentityFingerprint(
    targetIdentity,
    target.endpointHost,
    target.endpointPort,
  );

  if (intent === "development") {
    const expectedId = environment.AICHM_DEVELOPMENT_DATABASE_ID?.toLowerCase();
    if (!options.allowMissingDevelopmentId) {
      if (!expectedId || !SAFE_ID_PATTERN.test(expectedId)) {
        fail("SCHEMA_GUARD_DEVELOPMENT_ID_ALLOWLIST_REQUIRED");
      }
      if (expectedId !== targetIdentityId) {
        fail("SCHEMA_GUARD_DEVELOPMENT_TARGET_NOT_ALLOWLISTED");
      }
    }
  } else if (
    !target.socketOnly ||
    !LOCAL_TEST_DATABASES.has(target.database) ||
    environment.NODE_ENV !== "test"
  ) {
    fail("SCHEMA_GUARD_DISPOSABLE_TEST_TARGET_REJECTED");
  }

  return { targetUrl: target.url, targetIdentityId, intent };
}

export function buildGuardedDrizzleConfigUrl(environment: LegacySchemaGuardEnvironment): string {
  const url = environment.AICHM_DEVELOPMENT_DATABASE_URL;
  const expectedId = environment.AICHM_DEVELOPMENT_DATABASE_ID?.toLowerCase();
  const verifiedId = environment.AICHM_SCHEMA_CHANGE_VERIFIED_TARGET_ID?.toLowerCase();
  if (
    !url ||
    !expectedId ||
    !verifiedId ||
    !SAFE_ID_PATTERN.test(expectedId) ||
    verifiedId !== expectedId
  ) {
    fail("SCHEMA_GUARD_CONFIG_MUST_BE_INVOKED_BY_VERIFIED_WRAPPER");
  }
  return url;
}
