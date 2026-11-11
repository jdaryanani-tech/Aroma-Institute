import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { stopConfirmAndRemoveScratchPostgres, type ScratchPostgresState } from "../server/db/aichm-scratch-postgres-cleanup";

type ToolResult = { code: number; stdout: string };
export type ScratchProof = {
  version: 1;
  instanceId: string;
  databaseName: string;
  port: number;
  dataDirectory: string;
  systemIdentifier: string;
  postmasterPid: number;
};
type ScratchServerIdentity = {
  database_name: string;
  database_user: string;
  data_directory: string;
  host: string | null;
  port: number;
  system_identifier: string;
  in_recovery: boolean;
};

export type ScratchIdentityMismatch = {
  field: string;
  expected: string | number | boolean;
  observed: string | number | boolean;
};

const IDENTITY_MISMATCH_CODE = "CRM_TEST_SCRATCH_IDENTITY_MISMATCH";
type ScratchIdentityDiagnostic = {
  status: "failed";
  code: typeof IDENTITY_MISMATCH_CODE;
  mismatches: ScratchIdentityMismatch[];
};
type ScratchIdentityDiagnosticWriter = (line: string) => void;

const activeChildren = new Set<ChildProcess>();
let terminationSignal: NodeJS.Signals | undefined;
let escalationTimer: NodeJS.Timeout | undefined;

function onTermination(signal: NodeJS.Signals): void {
  if (terminationSignal) {
    for (const child of activeChildren) child.kill("SIGKILL");
    return;
  }
  terminationSignal = signal;
  for (const child of activeChildren) child.kill("SIGTERM");
  escalationTimer = setTimeout(() => {
    for (const child of activeChildren) child.kill("SIGKILL");
  }, 2_000);
  escalationTimer.unref();
}

function ensureNotInterrupted(): void {
  if (terminationSignal) throw new Error("CRM_TEST_INTERRUPTED");
}

function runTool(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  mode: "ignore" | "capture" | "inherit" = "ignore",
  timeoutMs = 30_000,
  allowDuringTermination = false,
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (terminationSignal && !allowDuringTermination) {
      reject(new Error("CRM_TEST_INTERRUPTED"));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: mode === "capture" ? ["ignore", "pipe", "ignore"] : mode,
      });
    } catch {
      reject(new Error("CRM_TEST_SCRATCH_TOOL_UNAVAILABLE"));
      return;
    }
    activeChildren.add(child);
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, result?: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      activeChildren.delete(child);
      if (terminationSignal && !allowDuringTermination) reject(new Error("CRM_TEST_INTERRUPTED"));
      else if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    }, timeoutMs);
    if (mode === "capture") {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    }
    child.once("error", () => finish(new Error("CRM_TEST_SCRATCH_TOOL_UNAVAILABLE")));
    child.once("close", code => {
      if (timedOut) finish(new Error("CRM_TEST_SCRATCH_TOOL_TIMEOUT"));
      else finish(undefined, { code: code ?? 1, stdout: stdout.trim() });
    });
  });
}

async function localPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("CRM_TEST_SCRATCH_PORT_TIMEOUT"));
    }, 5_000);
    server.once("error", () => {
      clearTimeout(timer);
      reject(new Error("CRM_TEST_SCRATCH_PORT_UNAVAILABLE"));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timer);
        server.close();
        reject(new Error("CRM_TEST_SCRATCH_PORT_UNAVAILABLE"));
        return;
      }
      server.close(error => {
        clearTimeout(timer);
        if (error) reject(new Error("CRM_TEST_SCRATCH_PORT_UNAVAILABLE"));
        else resolve(address.port);
      });
    });
  });
}

async function scratchState(
  dataDirectory: string,
  env: NodeJS.ProcessEnv,
  allowDuringTermination = false,
): Promise<ScratchPostgresState> {
  try {
    const result = await runTool(
      "pg_ctl", ["--pgdata", dataDirectory, "status"], env, "ignore", 10_000, allowDuringTermination,
    );
    if (result.code === 0) return "running";
    if (result.code === 3) return "stopped";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function parseSystemIdentifier(output: string): string {
  const match = output.match(/Database system identifier:\s*(\d+)/i);
  if (!match) throw new Error("CRM_TEST_SCRATCH_SYSTEM_IDENTIFIER_UNAVAILABLE");
  return match[1];
}

function safeIdentityValue(field: string, value: unknown): string | number | boolean {
  if (field === "dataDirectory") {
    return typeof value === "string" ? value : "<unavailable>";
  }
  if (field === "port") {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
      ? value
      : "<invalid-port>";
  }
  if (field === "recoveryState") {
    return typeof value === "boolean" ? value : "<invalid-boolean>";
  }
  if (typeof value !== "string") return "<unavailable>";
  if (
    value.includes("://") ||
    /(?:token|secret|password|passwd|credential|bearer|api[_-]?key)/i.test(value)
  ) {
    return "<redacted>";
  }
  const allowed = field === "serverAddress"
    ? /^[0-9a-fA-F:.]{1,64}$/
    : field === "systemIdentifier"
      ? /^\d{1,32}$/
      : /^[A-Za-z0-9_-]{1,80}$/;
  return allowed.test(value) ? value : "<invalid-value>";
}

function safeScratchPath(value: string | undefined, scratchRoot: string): string {
  if (!value) return "<unavailable>";
  const resolved = path.resolve(value);
  const relative = path.relative(scratchRoot, resolved);
  if (!relative) return "<scratch-root>";
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    if (relative === "data" || relative === "socket") return `<scratch-root>/${relative}`;
    return "<scratch-root>/<other-path>";
  }
  return "<outside-scratch>";
}

export function buildScratchIdentityMismatchDiagnostic(
  proof: ScratchProof,
  identity: ScratchServerIdentity | undefined,
  resolvedObservedDataDirectory: string | undefined,
): ScratchIdentityDiagnostic {
  const scratchRoot = path.dirname(proof.dataDirectory);
  const checks: Array<{
    field: string;
    expected: unknown;
    observed: unknown;
    matches: boolean;
  }> = [
    {
      field: "databaseName",
      expected: proof.databaseName,
      observed: identity?.database_name,
      matches: identity?.database_name === proof.databaseName,
    },
    {
      field: "databaseUser",
      expected: "postgres",
      observed: identity?.database_user,
      matches: identity?.database_user === "postgres",
    },
    {
      field: "dataDirectory",
      expected: proof.dataDirectory,
      observed: resolvedObservedDataDirectory,
      matches: resolvedObservedDataDirectory === proof.dataDirectory,
    },
    {
      field: "serverAddress",
      expected: "127.0.0.1",
      observed: identity?.host,
      matches: identity?.host === "127.0.0.1",
    },
    {
      field: "port",
      expected: proof.port,
      observed: identity?.port,
      matches: identity?.port === proof.port,
    },
    {
      field: "systemIdentifier",
      expected: proof.systemIdentifier,
      observed: identity?.system_identifier,
      matches: identity?.system_identifier === proof.systemIdentifier,
    },
    {
      field: "recoveryState",
      expected: false,
      observed: identity?.in_recovery,
      matches: identity?.in_recovery === false,
    },
  ];

  return {
    status: "failed",
    code: IDENTITY_MISMATCH_CODE,
    mismatches: checks
      .filter(check => !check.matches)
      .map(check => ({
        field: check.field,
        expected: check.field === "dataDirectory"
          ? safeScratchPath(check.expected as string, scratchRoot)
          : safeIdentityValue(check.field, check.expected),
        observed: check.field === "dataDirectory"
          ? safeScratchPath(check.observed as string | undefined, scratchRoot)
          : safeIdentityValue(check.field, check.observed),
      })),
  };
}

export function verifyScratchIdentityObservation(
  proof: ScratchProof,
  identity: ScratchServerIdentity | undefined,
  resolvedObservedDataDirectory: string | undefined,
  writeDiagnostic: ScratchIdentityDiagnosticWriter = line => console.error(line),
): void {
  const diagnostic = buildScratchIdentityMismatchDiagnostic(
    proof,
    identity,
    resolvedObservedDataDirectory,
  );
  if (diagnostic.mismatches.length > 0) {
    writeDiagnostic(JSON.stringify(diagnostic));
    throw new Error(IDENTITY_MISMATCH_CODE);
  }
}

export async function runAfterScratchIdentityVerification<T>(
  verify: () => Promise<void>,
  launchTestChild: () => Promise<T>,
): Promise<T> {
  await verify();
  return launchTestChild();
}

async function verifyScratchIdentity(
  connectionString: string,
  proof: ScratchProof,
): Promise<void> {
  const pool = new Pool({ connectionString, ssl: false, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const { rows: [identity] } = await pool.query<ScratchServerIdentity>(`
      SELECT current_database() AS database_name,current_user AS database_user,
        current_setting('data_directory') AS data_directory,host(inet_server_addr()) AS host,
        inet_server_port() AS port,(pg_control_system()).system_identifier::text AS system_identifier,
        pg_is_in_recovery() AS in_recovery
    `);
    let resolvedObservedDataDirectory: string | undefined;
    if (identity) {
      try {
        resolvedObservedDataDirectory = await realpath(identity.data_directory);
      } catch {
        // Preserve the failure as an unavailable path value without logging the raw path.
      }
    }
    verifyScratchIdentityObservation(
      proof,
      identity,
      resolvedObservedDataDirectory,
    );
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] !== "--run-isolated-ephemeral-postgres") {
    console.log(JSON.stringify({
      status: "skipped",
      reason: "Pass --run-isolated-ephemeral-postgres to create a fresh local test cluster.",
    }));
    return;
  }

  let failureCode: string | undefined;
  let scratchRoot: string | undefined;
  let dataDirectory: string | undefined;
  let localEnv: NodeJS.ProcessEnv | undefined;
  let databaseName: string | undefined;

  process.on("SIGINT", onTermination);
  process.on("SIGTERM", onTermination);
  try {
    const versions = await Promise.all(
      ["initdb", "pg_ctl", "createdb", "pg_controldata"].map(tool =>
        runTool(tool, ["--version"], process.env, "capture", 10_000),
      ),
    );
    if (versions.some(result => result.code !== 0)) throw new Error("CRM_TEST_SCRATCH_TOOLS_UNAVAILABLE");
    ensureNotInterrupted();

    const port = await localPort();
    ensureNotInterrupted();
    const instanceId = randomBytes(16).toString("hex");
    databaseName = `aichm_test_${instanceId}`;
    scratchRoot = await mkdtemp("/dev/shm/aichm-crm-test-");
    dataDirectory = path.join(scratchRoot, "data");
    const socketDirectory = path.join(scratchRoot, "socket");
    localEnv = {
      PATH: process.env.PATH,
      HOME: scratchRoot,
      TMPDIR: scratchRoot,
      LANG: "C",
      LC_ALL: "C",
    };
    await chmod(scratchRoot, 0o700);
    await mkdir(socketDirectory, { mode: 0o700 });

    const init = await runTool("initdb", [
      "--pgdata", dataDirectory,
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-instructions",
    ], localEnv, "ignore", 60_000);
    if (init.code !== 0) throw new Error("CRM_TEST_SCRATCH_INITDB_FAILED");

    const start = await runTool("pg_ctl", [
      "--pgdata", dataDirectory,
      "--log", path.join(scratchRoot, "postgres.log"),
      "--options", `-h 127.0.0.1 -p ${port} -k ${socketDirectory} -c listen_addresses=127.0.0.1`,
      "--wait", "start",
    ], localEnv, "ignore", 45_000);
    if (start.code !== 0) throw new Error("CRM_TEST_SCRATCH_START_FAILED");

    const createdb = await runTool("createdb", [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--template=template0",
      databaseName,
    ], localEnv, "ignore", 20_000);
    if (createdb.code !== 0) throw new Error("CRM_TEST_SCRATCH_DATABASE_CREATE_FAILED");

    const control = await runTool("pg_controldata", ["--pgdata", dataDirectory], localEnv, "capture", 10_000);
    if (control.code !== 0) throw new Error("CRM_TEST_SCRATCH_CONTROL_DATA_FAILED");
    const pidText = await readFile(path.join(dataDirectory, "postmaster.pid"), "utf8");
    const proof: ScratchProof = {
      version: 1,
      instanceId,
      databaseName,
      port,
      dataDirectory: await realpath(dataDirectory),
      systemIdentifier: parseSystemIdentifier(control.stdout),
      postmasterPid: Number(pidText.split(/\r?\n/, 1)[0]),
    };
    if (!Number.isSafeInteger(proof.postmasterPid)) {
      throw new Error("CRM_TEST_SCRATCH_POSTMASTER_PID_INVALID");
    }
    ensureNotInterrupted();
    await runAfterScratchIdentityVerification(
      () => verifyScratchIdentity(
        `postgresql://postgres@127.0.0.1:${port}/${databaseName}`,
        proof,
      ),
      async () => {
        const proofPath = path.join(scratchRoot!, "identity.json");
        await writeFile(proofPath, `${JSON.stringify(proof)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });

        const testEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: scratchRoot,
          TMPDIR: scratchRoot,
          LANG: "C",
          LC_ALL: "C",
          NODE_ENV: "test",
          CRM_TEST_DB_WRITE_APPROVED: "ISOLATED_EPHEMERAL_POSTGRES_ONLY",
          CRM_TEST_DATABASE_NAME: databaseName!,
          CRM_TEST_EPHEMERAL_ROOT: scratchRoot!,
          CRM_TEST_EPHEMERAL_PROOF: proofPath,
          AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
          AICHM_DEVELOPMENT_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/${databaseName}`,
        };
        const testResult = await runTool(
          path.resolve("node_modules/.bin/tsx"),
          ["--test", "server/crm/persistence.test.ts"],
          testEnv,
          "inherit",
          240_000,
        );
        if (testResult.code !== 0) throw new Error("CRM_TEST_PERSISTENCE_SUITE_FAILED");
        return testResult;
      },
    );
  } catch (error) {
    failureCode = error instanceof Error && /^CRM_TEST_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "CRM_TEST_ISOLATED_RUN_FAILED";
  } finally {
    if (scratchRoot && dataDirectory && localEnv) {
      const cleanup = await stopConfirmAndRemoveScratchPostgres({
        inspectState: () => scratchState(dataDirectory!, localEnv!, true),
        stop: async () => {
          const result = await runTool(
            "pg_ctl",
            ["--pgdata", dataDirectory!, "--mode=fast", "--wait", "stop"],
            localEnv!,
            "ignore",
            30_000,
            true,
          );
          if (result.code !== 0) throw new Error("CRM_TEST_SCRATCH_STOP_FAILED");
        },
        removeScratch: async () => rm(scratchRoot!, { recursive: true, force: true }),
      });
      if (cleanup.ok) {
        console.log(JSON.stringify({ cleanup: "postgres-stopped-and-scratch-removed" }));
      } else {
        failureCode = cleanup.errorCode;
        console.error(JSON.stringify({
          status: "failed",
          code: failureCode,
          scratchPreserved: cleanup.scratchPreserved,
          scratchPath: cleanup.scratchPreserved ? scratchRoot : undefined,
          diagnostics: "postgres.log and scratch identity files retained when stop is unconfirmed",
        }));
      }
    }
    process.removeListener("SIGINT", onTermination);
    process.removeListener("SIGTERM", onTermination);
    if (escalationTimer) clearTimeout(escalationTimer);
  }
  if (failureCode) {
    if (!failureCode.startsWith("local_postgres_") && !failureCode.startsWith("scratch_directory_")) {
      console.error(JSON.stringify({ status: "failed", code: failureCode }));
    }
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({
      status: "passed",
      isolatedInstance: true,
      scratchDatabase: databaseName,
      migrationsApplied: ["0014_crm_canonical_assignments.sql", "0015_crm_assignment_audit_invariants.sql"],
    }));
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error && /^CRM_TEST_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "CRM_TEST_ISOLATED_RUN_FAILED";
    console.error(JSON.stringify({ status: "failed", code }));
    process.exitCode = 1;
  });
}
