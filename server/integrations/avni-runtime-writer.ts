import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { Pool, type PoolConfig } from "pg";
import type { AvniHmacKeyringConfig } from "./avni-provider-reference-hmac-config";
import { AvniPilotSupabaseWriter, type AvniPilotSupabasePool, type AvniPilotSupabaseReader, type AvniPilotSupabaseWriterContract } from "./avni-pilot-supabase-writer";
import { normalizeSupabaseCaCertificate } from "../db/supabase-migration";
import { SUPABASE_AVNI_POOLER_HOST, SUPABASE_AVNI_PROJECT_REF } from "../db/supabase-avni-readonly";

export const AVNI_RUNTIME_WRITER_ENABLED_ENV = "AVNI_RUNTIME_WRITER_ENABLED";
export const SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV = "SUPABASE_AVNI_RUNTIME_DATABASE_URL";

const CA_ENV = "SUPABASE_DB_SSL_CA";
const runtimeLoginName = /^aichm_[a-z0-9_]{1,55}$/;
const reservedLoginNames = new Set([
  "aichm_conversation_owner",
  "aichm_conversation_runtime",
  "aichm_crm_reader",
  "aichm_crm_owner",
  "aichm_app_runtime",
  "aichm_app_login",
]);

export type AvniRuntimeWriterState =
  | "disabled"
  | "runtime_url_missing"
  | "runtime_ca_missing"
  | "hmac_keyring_missing"
  | "hmac_keyring_invalid"
  | "runtime_role_unverified"
  | "runtime_schema_unverified"
  | "runtime_configuration_invalid"
  | "runtime_pool_unavailable"
  | "ready";

type RuntimeWriterPool = AvniPilotSupabasePool & AvniPilotSupabaseReader & {
  end?: () => Promise<void>;
};

type RuntimeWriterEnvironment = Record<string, string | undefined>;

export type AvniRuntimeWriterInitialization = {
  state: AvniRuntimeWriterState;
  writerAvailable: boolean;
  poolWired: boolean;
  writer: AvniPilotSupabaseWriterContract | null;
  /** Pool creation is lazy; initialization does not open a socket. */
  pool: RuntimeWriterPool | null;
};

export type AvniRuntimeWriterSafeStatus = Pick<
  AvniRuntimeWriterInitialization,
  "state" | "writerAvailable" | "poolWired"
>;

export function avniRuntimeWriterSafeStatus(
  initialization: AvniRuntimeWriterInitialization,
): AvniRuntimeWriterSafeStatus {
  return {
    state: initialization.state,
    writerAvailable: initialization.writerAvailable,
    poolWired: initialization.poolWired,
  };
}

function configurationError(): never {
  throw new Error("AVNI_RUNTIME_DATABASE_CONFIGURATION_INVALID");
}

/**
 * Validates the dedicated runtime login URI without opening a connection.
 * The login name must be explicitly approved by the caller and is checked
 * against the exact Supabase project, pooler, database and TLS contract.
 */
export function buildAvniRuntimeWriterPoolConfig(
  environment: RuntimeWriterEnvironment,
  approvedRuntimeLoginRole: string,
): PoolConfig {
  if (
    !runtimeLoginName.test(approvedRuntimeLoginRole)
    || reservedLoginNames.has(approvedRuntimeLoginRole)
  ) return configurationError();

  const raw = environment[SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV]?.trim();
  if (!raw) return configurationError();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return configurationError();
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    || url.hostname.toLowerCase() !== SUPABASE_AVNI_POOLER_HOST
    || url.port !== "5432"
    || url.pathname !== "/postgres"
    || url.hash
    || !url.password
    || (raw.match(/\?/g) ?? []).length !== 1
  ) return configurationError();

  let username: string;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    return configurationError();
  }
  if (username !== `${approvedRuntimeLoginRole}.${SUPABASE_AVNI_PROJECT_REF}`) return configurationError();

  const queryEntries = Array.from(url.searchParams.entries());
  if (
    queryEntries.length !== 1
    || queryEntries[0][0] !== "sslmode"
    || queryEntries[0][1] !== "require"
  ) return configurationError();

  const rawQuery = raw.slice(raw.indexOf("?") + 1);
  if (!rawQuery || rawQuery.startsWith("&") || rawQuery.endsWith("&") || rawQuery.includes("&&")) {
    return configurationError();
  }

  const caValue = environment[CA_ENV]?.trim();
  if (!caValue) throw new Error("AVNI_RUNTIME_DATABASE_CA_MISSING");
  let ca: string;
  try {
    ca = normalizeSupabaseCaCertificate(caValue);
  } catch {
    return configurationError();
  }

  const connectionUrl = new URL(url.toString());
  connectionUrl.searchParams.delete("sslmode");
  const ssl: ConnectionOptions = Object.freeze({
    ca,
    rejectUnauthorized: true,
    checkServerIdentity,
    minVersion: "TLSv1.2",
  });
  return Object.freeze({
    connectionString: connectionUrl.toString(),
    ssl,
    options: "-c timezone=UTC",
    application_name: "aichm-avni-runtime-writer",
    connectionTimeoutMillis: 3_000,
    max: 4,
  });
}

function unavailable(state: AvniRuntimeWriterState): AvniRuntimeWriterInitialization {
  return { state, writerAvailable: false, poolWired: false, writer: null, pool: null };
}

/**
 * Initializes the existing fixed-RPC writer only after explicit opt-in,
 * valid HMAC configuration, a connection-free URL/TLS validation, and a
 * separately verified least-privilege runtime-role preflight. The default
 * dependencies only construct a lazy pg Pool; they never connect here.
 */
export function initializeAvniRuntimeWriter(input: {
  environment: RuntimeWriterEnvironment;
  keyring: AvniHmacKeyringConfig;
  approvedRuntimeLoginRole?: string | null;
  runtimeRolePreflightPassed?: boolean;
  runtimeSchemaPreflightPassed?: boolean;
  dependencies?: {
    buildPoolConfig?: (environment: RuntimeWriterEnvironment, role: string) => PoolConfig;
    createPool?: (config: PoolConfig) => RuntimeWriterPool;
    createWriter?: (
      pool: RuntimeWriterPool,
      reader: AvniPilotSupabaseReader,
    ) => AvniPilotSupabaseWriterContract;
  };
}): AvniRuntimeWriterInitialization {
  const { environment, keyring } = input;
  if (environment[AVNI_RUNTIME_WRITER_ENABLED_ENV] !== "true") return unavailable("disabled");

  const rawUrl = environment[SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV];
  if (!rawUrl?.trim()) return unavailable("runtime_url_missing");
  if (!environment[CA_ENV]?.trim()) return unavailable("runtime_ca_missing");
  if (keyring.state === "missing") return unavailable("hmac_keyring_missing");
  if (keyring.state !== "ready" || !keyring.provider) return unavailable("hmac_keyring_invalid");

  const role = input.approvedRuntimeLoginRole;
  if (!role || input.runtimeRolePreflightPassed !== true) {
    return unavailable("runtime_role_unverified");
  }
  if (input.runtimeSchemaPreflightPassed !== true) {
    return unavailable("runtime_schema_unverified");
  }

  const buildPoolConfig = input.dependencies?.buildPoolConfig ?? buildAvniRuntimeWriterPoolConfig;
  const createPool = input.dependencies?.createPool
    ?? ((config) => new Pool(config) as unknown as RuntimeWriterPool);
  const createWriter = input.dependencies?.createWriter
    ?? ((pool, reader) => new AvniPilotSupabaseWriter(
      pool,
      reader,
    ) as AvniPilotSupabaseWriterContract);

  let pool: RuntimeWriterPool | null = null;
  try {
    const config = buildPoolConfig(environment, role);
    pool = createPool(config);
    const reader: AvniPilotSupabaseReader = {
      query: (text, values) => pool!.query(text, values),
    };
    const writer = createWriter(pool, reader);
    return { state: "ready", writerAvailable: true, poolWired: true, writer, pool };
  } catch {
    void pool?.end?.().catch(() => undefined);
    return unavailable("runtime_configuration_invalid");
  }
}
