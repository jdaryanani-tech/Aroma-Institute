import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { stopConfirmAndRemoveScratchPostgres, type ScratchPostgresState } from "../server/db/aichm-scratch-postgres-cleanup";

type ToolResult = { code: number; stdout: string };
type ScratchProof = {
  version: 1;
  instanceId: string;
  databaseName: string;
  port: number;
  dataDirectory: string;
  systemIdentifier: string;
  postmasterPid: number;
};

function runTool(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  mode: "ignore" | "capture" | "inherit" = "ignore",
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
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
    let stdout = "";
    if (mode === "capture") {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    }
    child.once("error", () => reject(new Error("CRM_TEST_SCRATCH_TOOL_UNAVAILABLE")));
    child.once("close", code => resolve({ code: code ?? 1, stdout: stdout.trim() }));
  });
}

async function localPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error("CRM_TEST_SCRATCH_PORT_UNAVAILABLE")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("CRM_TEST_SCRATCH_PORT_UNAVAILABLE"));
        return;
      }
      server.close(error => error
        ? reject(new Error("CRM_TEST_SCRATCH_PORT_UNAVAILABLE"))
        : resolve(address.port));
    });
  });
}

async function scratchState(dataDirectory: string, env: NodeJS.ProcessEnv): Promise<ScratchPostgresState> {
  try {
    const result = await runTool("pg_ctl", ["--pgdata", dataDirectory, "status"], env);
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

async function verifyScratchIdentity(
  connectionString: string,
  proof: ScratchProof,
): Promise<void> {
  const pool = new Pool({ connectionString, ssl: false, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const { rows: [identity] } = await pool.query<{
      database_name: string;
      database_user: string;
      data_directory: string;
      host: string | null;
      port: number;
      system_identifier: string;
      in_recovery: boolean;
    }>(`
      SELECT current_database() AS database_name,current_user AS database_user,
        current_setting('data_directory') AS data_directory,inet_server_addr()::text AS host,
        inet_server_port() AS port,(pg_control_system()).system_identifier::text AS system_identifier,
        pg_is_in_recovery() AS in_recovery
    `);
    if (
      !identity ||
      identity.database_name !== proof.databaseName ||
      identity.database_user !== "postgres" ||
      (await realpath(identity.data_directory)) !== proof.dataDirectory ||
      identity.host !== "127.0.0.1" ||
      identity.port !== proof.port ||
      identity.system_identifier !== proof.systemIdentifier ||
      identity.in_recovery
    ) {
      throw new Error("CRM_TEST_SCRATCH_IDENTITY_MISMATCH");
    }
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

  const versions = await Promise.all(
    ["initdb", "pg_ctl", "createdb", "pg_controldata"].map(tool =>
      runTool(tool, ["--version"], process.env, true),
    ),
  );
  if (versions.some(result => result.code !== 0)) {
    throw new Error("CRM_TEST_SCRATCH_TOOLS_UNAVAILABLE");
  }

  const instanceId = randomBytes(16).toString("hex");
  const databaseName = `aichm_test_${instanceId}`;
  const scratchRoot = await mkdtemp("/dev/shm/aichm-crm-test-");
  await chmod(scratchRoot, 0o700);
  const dataDirectory = path.join(scratchRoot, "data");
  const socketDirectory = path.join(scratchRoot, "socket");
  await mkdir(socketDirectory, { mode: 0o700 });
  const port = await localPort();
  const localEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: scratchRoot,
    TMPDIR: scratchRoot,
    LANG: "C",
    LC_ALL: "C",
  };
  let failureCode: string | undefined;
  try {
    const init = await runTool("initdb", [
      "--pgdata", dataDirectory,
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-instructions",
    ], localEnv);
    if (init.code !== 0) throw new Error("CRM_TEST_SCRATCH_INITDB_FAILED");

    const start = await runTool("pg_ctl", [
      "--pgdata", dataDirectory,
      "--log", path.join(scratchRoot, "postgres.log"),
      "--options", `-h 127.0.0.1 -p ${port} -k ${socketDirectory} -c listen_addresses=127.0.0.1`,
      "--wait", "start",
    ], localEnv);
    if (start.code !== 0) throw new Error("CRM_TEST_SCRATCH_START_FAILED");

    const createdb = await runTool("createdb", [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--template=template0",
      databaseName,
    ], localEnv);
    if (createdb.code !== 0) throw new Error("CRM_TEST_SCRATCH_DATABASE_CREATE_FAILED");

    const control = await runTool("pg_controldata", ["--pgdata", dataDirectory], localEnv, true);
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
    await verifyScratchIdentity(
      `postgresql://postgres@127.0.0.1:${port}/${databaseName}`,
      proof,
    );
    const proofPath = path.join(scratchRoot, "identity.json");
    await writeFile(proofPath, `${JSON.stringify(proof)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

    const testEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: scratchRoot,
      TMPDIR: scratchRoot,
      LANG: "C",
      LC_ALL: "C",
      NODE_ENV: "test",
      CRM_TEST_DB_WRITE_APPROVED: "ISOLATED_EPHEMERAL_POSTGRES_ONLY",
      CRM_TEST_DATABASE_NAME: databaseName,
      CRM_TEST_EPHEMERAL_ROOT: scratchRoot,
      CRM_TEST_EPHEMERAL_PROOF: proofPath,
      AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
      AICHM_DEVELOPMENT_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/${databaseName}`,
    };
    const testResult = await runTool(
      path.resolve("node_modules/.bin/tsx"),
      ["--test", "server/crm/persistence.test.ts"],
      testEnv,
      "inherit",
    );
    if (testResult.code !== 0) throw new Error("CRM_TEST_PERSISTENCE_SUITE_FAILED");
  } catch (error) {
    failureCode = error instanceof Error && /^CRM_TEST_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "CRM_TEST_ISOLATED_RUN_FAILED";
  } finally {
    const cleanup = await stopConfirmAndRemoveScratchPostgres({
      inspectState: () => scratchState(dataDirectory, localEnv),
      stop: async () => {
        const result = await runTool(
          "pg_ctl",
          ["--pgdata", dataDirectory, "--mode=fast", "--wait", "stop"],
          localEnv,
        );
        if (result.code !== 0) throw new Error("CRM_TEST_SCRATCH_STOP_FAILED");
      },
      removeScratch: async () => rm(scratchRoot, { recursive: true, force: true }),
    });
    if (!cleanup.ok) {
      failureCode = cleanup.errorCode;
      console.error(JSON.stringify({
        status: "failed",
        code: failureCode,
        scratchPreserved: cleanup.scratchPreserved,
        scratchPath: cleanup.scratchPreserved ? scratchRoot : undefined,
      }));
    }
  }
  if (failureCode) {
    if (!failureCode.startsWith("local_postgres_") && !failureCode.startsWith("scratch_directory_")) {
      console.error(JSON.stringify({ status: "failed", code: failureCode }));
    }
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ status: "passed", isolatedInstance: true }));
    console.log(JSON.stringify({ cleanup: "postgres-stopped-and-scratch-removed" }));
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ status: "failed", code: "CRM_TEST_ISOLATED_RUN_FAILED" }));
  process.exitCode = 1;
});
