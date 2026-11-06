import { checkServerIdentity, createSecureContext, type ConnectionOptions } from "node:tls";
import { X509Certificate } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as siteSchema from "@shared/schema";
import * as lmsSchema from "@shared/lms-schema";
import * as calendarSchema from "@shared/calendar-schema";

const EXPECTED_PROJECT_REF = "xylqezjvqqqjozenuygh";
const EXPECTED_SESSION_POOLER_HOST = "aws-0-ap-northeast-1.pooler.supabase.com";
const EXPECTED_SESSION_POOLER_PORT = "5432";
const EXPECTED_DATABASE_PATH = "/postgres";

export type SupabaseMigrationEnvironment = Record<string, string | undefined>;

function requiredValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required to create the separate Supabase migration connection.`);
  }
  return trimmed;
}

function validateCertificate(certificate: string): string {
  const blocks = certificate.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  const remainder = certificate.replace(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    "",
  );

  if (!blocks?.length || remainder.trim()) {
    throw new Error("SUPABASE_DB_SSL_CA must contain PEM-encoded certificate text.");
  }

  try {
    for (const block of blocks) {
      if (!new X509Certificate(block).ca) {
        throw new Error("Certificate is not a CA.");
      }
    }
    createSecureContext({ ca: certificate, minVersion: "TLSv1.2" });
  } catch {
    throw new Error("SUPABASE_DB_SSL_CA contains an invalid PEM certificate.");
  }

  return certificate;
}

function validateConnectionUrl(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("SUPABASE_DATABASE_URL must be a valid PostgreSQL connection URI.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("SUPABASE_DATABASE_URL must use the PostgreSQL protocol.");
  }

  if (url.hostname.toLowerCase() !== EXPECTED_SESSION_POOLER_HOST) {
    throw new Error("SUPABASE_DATABASE_URL must use the approved Supavisor session-pooler host.");
  }

  if (url.port !== EXPECTED_SESSION_POOLER_PORT || url.pathname !== EXPECTED_DATABASE_PATH) {
    throw new Error("SUPABASE_DATABASE_URL has an unexpected session-pooler port or database path.");
  }

  if (!url.password) {
    throw new Error("SUPABASE_DATABASE_URL must include database authentication.");
  }

  let username: string;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error("SUPABASE_DATABASE_URL has an invalid username encoding.");
  }

  if (username !== `postgres.${EXPECTED_PROJECT_REF}`) {
    throw new Error("SUPABASE_DATABASE_URL must identify the approved Supabase project.");
  }

  const sslModeEntries = Array.from(url.searchParams.entries()).filter(
    ([key]) => key.toLowerCase() === "sslmode",
  );
  if (
    sslModeEntries.length !== 1 ||
    sslModeEntries[0][0] !== "sslmode" ||
    sslModeEntries[0][1] !== "require"
  ) {
    throw new Error("SUPABASE_DATABASE_URL must include exactly one sslmode=require parameter.");
  }

  const unsupportedSslParameters = Array.from(url.searchParams.keys()).filter(
    (key) => /^ssl(?:_|$)/i.test(key) && key.toLowerCase() !== "sslmode",
  );
  if (unsupportedSslParameters.length) {
    throw new Error("SUPABASE_DATABASE_URL must not include other SSL parameters.");
  }

  const queryIndex = connectionString.indexOf("?");
  const rawQuery = queryIndex >= 0 ? connectionString.slice(queryIndex + 1) : "";
  if (
    (connectionString.match(/\?/g) ?? []).length !== 1 ||
    !rawQuery ||
    rawQuery.startsWith("&") ||
    rawQuery.endsWith("&") ||
    rawQuery.includes("&&")
  ) {
    throw new Error("SUPABASE_DATABASE_URL has malformed query separators.");
  }

  return url;
}

/**
 * Build a separately guarded configuration for migration tooling.
 *
 * The required sslmode is validated on the original URI, then removed from
 * an in-memory copy because pg's connection-string parser replaces explicit
 * TLS options when an SSL query parameter is present. TLS remains mandatory
 * through the explicit, verified SSL options below.
 */
export function buildSupabaseMigrationPoolConfig(
  environment: SupabaseMigrationEnvironment = process.env,
): PoolConfig {
  const connectionString = requiredValue(
    environment.SUPABASE_DATABASE_URL,
    "SUPABASE_DATABASE_URL",
  );
  const certificate = validateCertificate(
    requiredValue(environment.SUPABASE_DB_SSL_CA, "SUPABASE_DB_SSL_CA"),
  );
  const parsedUrl = validateConnectionUrl(connectionString);

  const poolUrl = new URL(parsedUrl.toString());
  poolUrl.searchParams.delete("sslmode");

  const ssl: ConnectionOptions = Object.freeze({
    ca: certificate,
    rejectUnauthorized: true,
    checkServerIdentity,
    minVersion: "TLSv1.2",
  });

  return Object.freeze({
    connectionString: poolUrl.toString(),
    ssl,
    application_name: "aichm-supabase-migration",
  });
}

/**
 * Create an opt-in Supabase Pool and Drizzle client for migration work.
 * This factory is not imported by the app's default runtime database module.
 */
export function createSupabaseMigrationConnection(
  environment: SupabaseMigrationEnvironment = process.env,
) {
  const pool = new Pool(buildSupabaseMigrationPoolConfig(environment));
  const db = drizzle(pool, {
    schema: { ...siteSchema, ...lmsSchema, ...calendarSchema },
  });

  return { pool, db };
}
