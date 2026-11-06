import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkServerIdentity } from "node:tls";
import test from "node:test";
import type { PoolConfig } from "pg";
import { buildSupabaseMigrationPoolConfig } from "./supabase-migration";

const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUFfudmdrK9wmI/y55NQlEzt4nbN4wDQYJKoZIhvcNAQEL
BQAwIjEgMB4GA1UEAwwXQUlDSE0gbWlncmF0aW9uIHRlc3QgQ0EwHhcNMjYxMTA2
MDYwMDMwWhcNMzYxMTAzMDYwMDMwWjAiMSAwHgYDVQQDDBdBSUNITSBtaWdyYXRp
b24gdGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKWNPCud
fu3uexBhIRYCtgYi8tm5zdKRZc6aZ7LRnW1Wb5ehvXwIXctLWX0fgYvIA3X1HnPw
gdlSAcgcr1euvCDGU3g1x8//gDnNThD+BsjQuZgCDPNL8Pi5P+D5rmNghbvXC1aj
UnIQqTLJBiWqUaEH3eTSSLAw9jQbsmoWQCAhA0iRQysS3k7selhYxF7Msy9NB75d
n16DEs4S0CsfAsqiBJjOnpatTUiHTmuXbjXTFyAudRsratI/ohYSSN9CWhicm49e
iVXEqrXiia0jUQtLRR64saAGwNiHhBNLQ8LwYY0QTVKzjGliQzrnR+1UAJ2VcdDF
1igDobjCWxsmcYECAwEAAaNTMFEwHQYDVR0OBBYEFJwgtYOkGuJ+FlN7i2ROcVvv
PmtVMB8GA1UdIwQYMBaAFJwgtYOkGuJ+FlN7i2ROcVvvPmtVMA8GA1UdEwEB/wQF
MAMBAf8wDQYJKoZIhvcNAQELBQADggEBADi+lZFh5w0FJJaCitdQRQwjbVZ4Dcrh
JBsG9mPSIrBWbP5XVozBRkO43Eos9HV4Tfd/bY5P2CQs6LLVBhdMcXzTnCnyycO6
QoL++2BlKfWG29xrrvLZKxZxt5dUjXF2RXqhKJoguR+91p2TR+tVtyMzFu1sUP4V
NutqNkyYKIu2gAivT5ihSrQak5VzMh+7+8T17GMNjgpD4COI8dsMiaq34ZF6Mrpo
EpVrSxW3ixsN1ZD5Cyf6mTrhODxmfPo5+Fgf4+zZFi5hw1yFyE8tkd3PTBfenr3h
79RZVFW4DdULgp9i0Pk2r4k7jqsaxuDiKGukpesKcYPJNnwjpgAkJ1E=
-----END CERTIFICATE-----`;

const VALID_URI =
  "postgresql://postgres.xylqezjvqqqjozenuygh:placeholder@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require";

function buildConfig(overrides: {
  url?: string;
  ca?: string;
} = {}): PoolConfig {
  return buildSupabaseMigrationPoolConfig({
    SUPABASE_DATABASE_URL: overrides.url ?? VALID_URI,
    SUPABASE_DB_SSL_CA: overrides.ca ?? TEST_CA,
  });
}

test("separate Supabase migration pool requires its CA secret", () => {
  assert.throws(
    () =>
      buildSupabaseMigrationPoolConfig({
        SUPABASE_DATABASE_URL: VALID_URI,
        SUPABASE_DB_SSL_CA: undefined,
      }),
    /SUPABASE_DB_SSL_CA is required/,
  );
});

test("invalid or non-PEM CA material is rejected without exposing its contents", () => {
  assert.throws(() => buildConfig({ ca: "not a certificate" }), /PEM-encoded certificate/);
  assert.throws(
    () => buildConfig({ ca: "-----BEGIN CERTIFICATE-----invalid-----END CERTIFICATE-----" }),
    /invalid PEM certificate/,
  );
  assert.throws(
    () =>
      buildConfig({
        ca: "-----BEGIN CERTIFICATE-----\nnot-valid-base64!?\n-----END CERTIFICATE-----",
      }),
    /invalid PEM certificate/,
  );
  assert.throws(
    () => buildConfig({ ca: "-----BEGIN CERTIFICATE-----valid-base64-body" }),
    /PEM-encoded certificate/,
  );
});

test("multiline and flattened CA PEM are normalized to valid certificate blocks", () => {
  const expectedPem = TEST_CA.replace(/\r\n/g, "\n").trim();
  const multilineConfig = buildConfig({ ca: TEST_CA });
  const flattenedConfig = buildConfig({ ca: TEST_CA.replace(/[\r\n]/g, "") });

  assert.equal(multilineConfig.ssl && typeof multilineConfig.ssl === "object" ? multilineConfig.ssl.ca : null, expectedPem);
  assert.equal(flattenedConfig.ssl && typeof flattenedConfig.ssl === "object" ? flattenedConfig.ssl.ca : null, expectedPem);
});

test("migration URI must explicitly require SSL", () => {
  assert.throws(
    () => buildConfig({ url: VALID_URI.replace("?sslmode=require", "") }),
    /sslmode=require/,
  );
  assert.throws(
    () => buildConfig({ url: VALID_URI.replace("sslmode=require", "sslmode=disable") }),
    /sslmode=require/,
  );
  assert.throws(
    () =>
      buildConfig({
        url: `${VALID_URI}&sslmode=require`,
      }),
    /exactly one sslmode=require/,
  );
});

test("Supabase pooler target is restricted to the expected project, host, port, and database", () => {
  assert.throws(
    () => buildConfig({ url: VALID_URI.replace("aws-0-ap-northeast-1", "other") }),
    /approved Supavisor session-pooler host/,
  );
  assert.throws(
    () => buildConfig({ url: VALID_URI.replace(":5432", ":6543") }),
    /unexpected session-pooler port/,
  );
  assert.throws(
    () => buildConfig({ url: VALID_URI.replace("/postgres?", "/other?") }),
    /unexpected session-pooler port or database path/,
  );
  assert.throws(
    () => buildConfig({ url: VALID_URI.replace("postgres.xylqezjvqqqjozenuygh", "postgres.other") }),
    /approved Supabase project/,
  );
});

test("the pg config keeps strict CA and hostname verification while stripping only sslmode", () => {
  const config = buildConfig();
  assert.equal(config.connectionString?.includes("sslmode"), false);

  if (!config.ssl || typeof config.ssl !== "object") {
    assert.fail("Expected an explicit TLS configuration.");
  }
  assert.equal(config.ssl.ca, TEST_CA.replace(/\r\n/g, "\n").trim());
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.checkServerIdentity, checkServerIdentity);
  assert.equal(config.ssl.minVersion, "TLSv1.2");
  assert.equal(config.options, "-c timezone=UTC");
  assert.equal(
    config.types?.getTypeParser(1184, "text")("2026-11-06 01:02:03.123456+00"),
    "2026-11-06 01:02:03.123456+00",
  );
  assert.equal(Reflect.set(config.ssl, "rejectUnauthorized", false), false);
  assert.equal(Reflect.set(config, "ssl", false), false);

  const require = createRequire(import.meta.url);
  const ConnectionParameters = require("pg/lib/connection-parameters") as new (
    config: PoolConfig,
  ) => { ssl: { ca?: string; rejectUnauthorized?: boolean } };
  const actualPgParameters = new ConnectionParameters(config);
  assert.equal(actualPgParameters.ssl.ca, TEST_CA.replace(/\r\n/g, "\n").trim());
  assert.equal(actualPgParameters.ssl.rejectUnauthorized, true);
});

test("the existing app runtime still creates its default pool from DATABASE_URL only", () => {
  const sourcePath = fileURLToPath(new URL("../db.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /connectionString:\s*process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /SUPABASE_DATABASE_URL|SUPABASE_DB_SSL_CA/);
});
