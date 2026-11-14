import assert from "node:assert/strict";
import test from "node:test";
import {
  createStartupFailureRecord,
  runStartupWithDiagnostics,
} from "./startup-diagnostics";

test("startup diagnostics include a safe allowlisted code and mapped stack frames", () => {
  const error = new TypeError("sensitive message is never emitted");
  (error as TypeError & { code?: string }).code =
    "APP_DATABASE_ENDPOINT_MISMATCH";
  error.stack = [
    "TypeError: sensitive message is never emitted",
    "    at start (/srv/app/server/application.ts:42:9)",
  ].join("\n");

  const record = createStartupFailureRecord(
    "server-start",
    error,
    "test-correlation",
  );

  assert.deepEqual(record, {
    event: "application_startup_failed",
    correlationId: "test-correlation",
    stage: "server-start",
    errorClass: "TypeError",
    safeErrorCode: "APP_DATABASE_ENDPOINT_MISMATCH",
    stackFrames: ["at start (application.ts:42:9)"],
  });
});

test("startup stack output keeps only safe frame names and source locations", () => {
  const error = new TypeError("do not include this message");
  error.stack = [
    "TypeError: do not include this message",
    "    at connect (postgresql://db-user:db-password@private-host/app?token=query-secret:1:1)",
    "    at authenticate (password=pass-value api_key=key-value)",
    "    at authorize (Bearer.bearer-value-long-enough.token-value:2:3)",
    "    at opaque (ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789)",
    "    at mapped (/srv/app/server/auth.ts:29:17)",
  ].join("\n");

  const record = createStartupFailureRecord(
    "module-load",
    error,
    "test-correlation",
  );
  const serialized = JSON.stringify(record);

  for (const secretLike of [
    "db-user",
    "db-password",
    "private-host",
    "query-secret",
    "pass-value",
    "key-value",
    "Bearer.bearer-value-long-enough.token-value",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "do not include this message",
  ]) {
    assert.equal(serialized.includes(secretLike), false);
  }
  assert.deepEqual(record.stackFrames, ["at mapped (auth.ts:29:17)"]);
});

test("unknown error codes and unsafe class names are omitted or normalized", () => {
  const error = new Error("not logged");
  (error as Error & { code?: string }).code = "PRIVATE_VALUE";
  Object.defineProperty(error, "name", { value: "TypeError https://private.invalid" });
  error.stack = "TypeError: not logged\n    at load (/srv/app/server/index.ts:4:2)";

  const record = createStartupFailureRecord(
    "module-load",
    error,
    "test-correlation",
  );

  assert.equal(record.errorClass, "Error");
  assert.equal("safeErrorCode" in record, false);
  assert.deepEqual(record.stackFrames, [
    "at load (index.ts:4:2)",
  ]);
});

test("outer wrapper reports module-load failures and sets failure exit status", async () => {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  const error = new TypeError("private error text");

  await runStartupWithDiagnostics(
    async () => {
      throw error;
    },
    {
      correlationId: "test-correlation",
      logger: (line) => lines.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
  );

  assert.equal(lines.length, 1);
  assert.equal(exitCodes[0], 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.stage, "module-load");
  assert.equal(record.errorClass, "TypeError");
  assert.equal(record.correlationId, "test-correlation");
  assert.equal(lines[0].includes("private error text"), false);
});

test("outer wrapper reports server-start failures and leaves successful startup untouched", async () => {
  const lines: string[] = [];
  const exitCodes: number[] = [];

  await runStartupWithDiagnostics(
    async () => ({
      startApplication: async () => {
        throw new Error("startup failure");
      },
    }),
    {
      correlationId: "server-start-correlation",
      logger: (line) => lines.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
  );

  assert.equal(JSON.parse(lines[0]).stage, "server-start");
  assert.deepEqual(exitCodes, [1]);

  lines.length = 0;
  exitCodes.length = 0;
  await runStartupWithDiagnostics(
    async () => ({ startApplication: async () => undefined }),
    {
      logger: (line) => lines.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
  );
  assert.deepEqual(lines, []);
  assert.deepEqual(exitCodes, []);
});
