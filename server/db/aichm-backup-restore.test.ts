import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stopConfirmAndRemoveScratchPostgres } from "./aichm-scratch-postgres-cleanup";

test("isolated restore preserves template0 public schema and all archived source objects", () => {
  const scriptPath = fileURLToPath(
    new URL("../../script/create-aichm-encrypted-backups.ts", import.meta.url),
  );
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /createdb", \["--template=template0", dbName\]/);
  assert.doesNotMatch(source, /DROP SCHEMA IF EXISTS public CASCADE/);
  assert.match(source, /"--exit-on-error", "--single-transaction", "--no-owner", "--no-acl"/);
  assert.match(source, /const expectedNames = manifest\.source\.tables\.map/);
  assert.match(source, /JSON\.stringify\(restored\.tables\) === JSON\.stringify\(manifest\.source\.tables\)/);
  assert.match(source, /delete manifest\.restore\.errorCode/);
  assert.match(source, /target: "isolated_restore_cleanup", errorCode: cleanup\.errorCode/);
  assert.match(source, /if \(failures\.length > 0 \|\| diagnostics\.length > 0\) process\.exitCode = 2/);
});
test("scratch restore cleanup removes files after stop is confirmed", async (t) => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "aichm-cleanup-test-"));
  t.after(() => rm(scratchRoot, { recursive: true, force: true }));
  const marker = path.join(scratchRoot, "postgres.log");
  await writeFile(marker, "local diagnostic");
  const states = ["running", "stopped"] as const;
  let inspections = 0;
  let stopCalls = 0;

  const result = await stopConfirmAndRemoveScratchPostgres({
    inspectState: async () => states[inspections++] ?? "unknown",
    stop: async () => {
      stopCalls += 1;
    },
    removeScratch: async () => rm(scratchRoot, { recursive: true, force: true }),
  });

  assert.deepEqual(result, { ok: true, scratchRemoved: true });
  assert.equal(inspections, 2);
  assert.equal(stopCalls, 1);
  await assert.rejects(access(scratchRoot));
});

test("failed shutdown preserves scratch data and reports cleanup failure", async (t) => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "aichm-cleanup-test-"));
  t.after(() => rm(scratchRoot, { recursive: true, force: true }));
  const marker = path.join(scratchRoot, "postgres.log");
  await writeFile(marker, "local diagnostic");
  let removeCalls = 0;

  const result = await stopConfirmAndRemoveScratchPostgres({
    inspectState: async () => "running",
    stop: async () => {
      throw new Error("shutdown failed");
    },
    removeScratch: async () => {
      removeCalls += 1;
      await rm(scratchRoot, { recursive: true, force: true });
    },
  });

  assert.deepEqual(result, {
    ok: false,
    scratchRemoved: false,
    scratchPreserved: true,
    errorCode: "local_postgres_stop_failed",
  });
  assert.equal(removeCalls, 0);
  assert.equal(await readFile(marker, "utf8"), "local diagnostic");
});
test("uncertain PostgreSQL state preserves scratch data and reports cleanup failure", async (t) => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "aichm-cleanup-test-"));
  t.after(() => rm(scratchRoot, { recursive: true, force: true }));
  const marker = path.join(scratchRoot, "postgres.log");
  await writeFile(marker, "local diagnostic");
  let stopCalls = 0;
  let removeCalls = 0;

  const result = await stopConfirmAndRemoveScratchPostgres({
    inspectState: async () => "unknown",
    stop: async () => {
      stopCalls += 1;
    },
    removeScratch: async () => {
      removeCalls += 1;
      await rm(scratchRoot, { recursive: true, force: true });
    },
  });

  assert.deepEqual(result, {
    ok: false,
    scratchRemoved: false,
    scratchPreserved: true,
    errorCode: "local_postgres_state_uncertain",
  });
  assert.equal(stopCalls, 0);
  assert.equal(removeCalls, 0);
  assert.equal(await readFile(marker, "utf8"), "local diagnostic");
});
test("PostgreSQL still running after shutdown preserves scratch data and fails", async (t) => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "aichm-cleanup-test-"));
  t.after(() => rm(scratchRoot, { recursive: true, force: true }));
  const marker = path.join(scratchRoot, "postgres.log");
  await writeFile(marker, "local diagnostic");
  const states = ["running", "running"] as const;
  let inspections = 0;
  let removeCalls = 0;

  const result = await stopConfirmAndRemoveScratchPostgres({
    inspectState: async () => states[inspections++] ?? "unknown",
    stop: async () => undefined,
    removeScratch: async () => {
      removeCalls += 1;
      await rm(scratchRoot, { recursive: true, force: true });
    },
  });

  assert.deepEqual(result, {
    ok: false,
    scratchRemoved: false,
    scratchPreserved: true,
    errorCode: "local_postgres_stop_unconfirmed",
  });
  assert.equal(removeCalls, 0);
  assert.equal(await readFile(marker, "utf8"), "local diagnostic");
});
// This file intentionally tests cleanup with disposable temporary directories.
