import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requireAichmForwardScratchDatabaseUrl } from "./aichm-forward-migration-guard";

const scratchUrl =
  "postgresql://postgres@127.0.0.1:55432/aichm_forward_scratch_rehearsal";

test("forward migration configuration accepts only an explicit local scratch target", () => {
  assert.equal(
    requireAichmForwardScratchDatabaseUrl(scratchUrl, "scratch"),
    scratchUrl,
  );
});

test("forward migration configuration rejects missing or non-scratch target intent", () => {
  assert.throws(
    () => requireAichmForwardScratchDatabaseUrl(undefined, "scratch"),
    /AICHM_FORWARD_SCRATCH_DATABASE_URL_REQUIRED/,
  );
  assert.throws(
    () => requireAichmForwardScratchDatabaseUrl(scratchUrl, undefined),
    /AICHM_FORWARD_SCRATCH_TARGET_REQUIRED/,
  );
  assert.throws(
    () => requireAichmForwardScratchDatabaseUrl(scratchUrl, "production"),
    /AICHM_FORWARD_SCRATCH_TARGET_REQUIRED/,
  );
});

test("forward migration configuration rejects remote and non-dedicated databases", () => {
  assert.throws(
    () =>
      requireAichmForwardScratchDatabaseUrl(
        "postgresql://postgres@db.example.test:5432/aichm_forward_scratch_x",
        "scratch",
      ),
    /AICHM_FORWARD_SCRATCH_TARGET_REJECTED/,
  );
  assert.throws(
    () =>
      requireAichmForwardScratchDatabaseUrl(
        "postgresql://postgres@127.0.0.1:5432/neondb",
        "scratch",
      ),
    /AICHM_FORWARD_SCRATCH_TARGET_REJECTED/,
  );
  assert.throws(
    () =>
      requireAichmForwardScratchDatabaseUrl(
        "postgresql://postgres@127.0.0.1:5432/aichm_forward_scratch_x?sslmode=require&ssl=true",
        "scratch",
      ),
    /AICHM_FORWARD_SCRATCH_TARGET_REJECTED/,
  );
});

test("forward baseline is a separate comment-only migration stream", () => {
  const journal = JSON.parse(
    readFileSync("migrations/aichm-forward/meta/_journal.json", "utf8"),
  );
  const sql = readFileSync(
    "migrations/aichm-forward/0000_aichm_forward_baseline.sql",
    "utf8",
  );
  const config = readFileSync("drizzle.aichm-forward.config.ts", "utf8");

  assert.deepEqual(
    journal.entries.map((entry: { idx: number; tag: string }) => ({
      idx: entry.idx,
      tag: entry.tag,
    })),
    [{ idx: 0, tag: "0000_aichm_forward_baseline" }],
  );
  assert.ok(
    sql
      .split(/\r?\n/)
      .every((line) => !line.trim() || line.trim().startsWith("--")),
  );
  assert.match(config, /out:\s*"\.\/migrations\/aichm-forward"/);
  assert.match(config, /schema:\s*"aichm_forward_migration_meta"/);
  assert.match(config, /table:\s*"__drizzle_migrations"/);
});
