import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { Pool, type PoolConfig } from "pg";
import { migrationPgTypes } from "./migration-pg-types";

export type AichmSourceMigrationEnvironment = Record<string, string | undefined>;

function requiredSourceUri(environment: AichmSourceMigrationEnvironment): string {
  const value = environment.AICHM_SOURCE_PROD_DATABASE_URL?.trim();
  if (!value) throw new Error("AICHM_SOURCE_PROD_DATABASE_URL is required for source migration access.");
  return value;
}

export function buildAichmSourcePoolConfig(
  environment: AichmSourceMigrationEnvironment = process.env,
): PoolConfig {
  const connectionString = requiredSourceUri(environment);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("AICHM_SOURCE_PROD_DATABASE_URL must be a valid PostgreSQL URI.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("AICHM_SOURCE_PROD_DATABASE_URL must use PostgreSQL.");
  }
  if (!url.hostname || !url.password || !url.pathname || url.pathname === "/") {
    throw new Error("AICHM_SOURCE_PROD_DATABASE_URL is missing required connection components.");
  }
  if (url.pathname !== "/neondb") {
    throw new Error("AICHM_SOURCE_PROD_DATABASE_URL does not identify the audited production database.");
  }
  const sslModeEntries = Array.from(url.searchParams.entries()).filter(([key]) => key.toLowerCase() === "sslmode");
  if (
    sslModeEntries.length !== 1 ||
    sslModeEntries[0][0] !== "sslmode" ||
    sslModeEntries[0][1] !== "require"
  ) {
    throw new Error("AICHM_SOURCE_PROD_DATABASE_URL must include exactly one sslmode=require.");
  }
  const otherSslOptions = Array.from(url.searchParams.keys()).filter((key) => /^ssl(?:_|$)/i.test(key) && key.toLowerCase() !== "sslmode");
  if (otherSslOptions.length) {
    throw new Error("AICHM_SOURCE_PROD_DATABASE_URL must not override strict TLS settings.");
  }
  const queryIndex = connectionString.indexOf("?");
  const rawQuery = queryIndex >= 0 ? connectionString.slice(queryIndex + 1) : "";
  if (
    (connectionString.match(/\?/g) ?? []).length !== 1 ||
    rawQuery.startsWith("&") ||
    rawQuery.endsWith("&") ||
    rawQuery.includes("&&")
  ) {
    throw new Error("AICHM_SOURCE_PROD_DATABASE_URL has malformed query separators.");
  }

  url.searchParams.delete("sslmode");
  const ssl: ConnectionOptions = Object.freeze({
    rejectUnauthorized: true,
    checkServerIdentity,
    minVersion: "TLSv1.2",
  });
  return Object.freeze({
    connectionString: url.toString(),
    ssl,
    options: "-c timezone=UTC",
    types: migrationPgTypes,
    application_name: "aichm-production-source-migration",
  });
}

/**
 * This is deliberately separate from server/db.ts. It is only used by the
 * migration CLI after the operator explicitly opts into live access.
 */
export function createAichmSourceMigrationPool(
  environment: AichmSourceMigrationEnvironment = process.env,
): Pool {
  return new Pool(buildAichmSourcePoolConfig(environment));
}
