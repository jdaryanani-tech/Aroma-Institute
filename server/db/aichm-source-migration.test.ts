import assert from "node:assert/strict";
import test from "node:test";
import { buildAichmSourcePoolConfig } from "./aichm-source-migration";

const VALID_SOURCE =
  "postgresql://migration-user:placeholder@replit-prod.example:5432/neondb?sslmode=require";

test("production source factory requires the dedicated source secret and strict TLS options", () => {
  assert.throws(
    () => buildAichmSourcePoolConfig({ AICHM_SOURCE_PROD_DATABASE_URL: undefined }),
    /AICHM_SOURCE_PROD_DATABASE_URL is required/,
  );
  const config = buildAichmSourcePoolConfig({ AICHM_SOURCE_PROD_DATABASE_URL: VALID_SOURCE });
  assert.equal(config.connectionString?.includes("sslmode"), false);
  assert.equal(config.application_name, "aichm-production-source-migration");
  assert.equal(config.options, "-c timezone=UTC");
  assert.equal(
    config.types?.getTypeParser(1184, "text")("2026-11-06 01:02:03.123456+00"),
    "2026-11-06 01:02:03.123456+00",
  );
  assert.ok(config.ssl && typeof config.ssl === "object");
  if (!config.ssl || typeof config.ssl !== "object") return;
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.minVersion, "TLSv1.2");
  assert.equal(typeof config.ssl.checkServerIdentity, "function");
});

test("source factory rejects wrong database, missing SSL, duplicate SSL and malformed URI", () => {
  const build = (url: string) => buildAichmSourcePoolConfig({ AICHM_SOURCE_PROD_DATABASE_URL: url });
  assert.throws(() => build(VALID_SOURCE.replace("/neondb?", "/heliumdb?")), /audited production database/);
  assert.throws(() => build(VALID_SOURCE.replace("?sslmode=require", "")), /exactly one sslmode=require/);
  assert.throws(() => build(`${VALID_SOURCE}&sslmode=require`), /exactly one sslmode=require/);
  assert.throws(() => build(VALID_SOURCE.replace("sslmode=require", "sslmode=disable")), /exactly one sslmode=require/);
  assert.throws(() => build(VALID_SOURCE.replace("postgresql://", "https://")), /PostgreSQL/);
  assert.throws(() => build("not a database URL"), /valid PostgreSQL URI/);
});
