import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { validateLegacySchemaChangeTarget } from "../db/legacy-schema-change-guard";

const APPROVAL = "ISOLATED_EPHEMERAL_POSTGRES_ONLY";
const DATABASE_PREFIX = /^aichm_test_[a-f0-9]{32}$/;

export type CrmPersistenceScratchProof = {
  version: 1;
  instanceId: string;
  databaseName: string;
  port: number;
  dataDirectory: string;
  systemIdentifier: string;
  postmasterPid: number;
};

export function validateCrmPersistenceTestTargetConfiguration(
  environment: Record<string, string | undefined> = process.env,
) {
  if (environment.NODE_ENV !== "test" || environment.CRM_TEST_DB_WRITE_APPROVED !== APPROVAL) {
    throw new Error("CRM persistence tests require explicit disposable-database approval.");
  }

  const target = validateLegacySchemaChangeTarget(environment);
  const databaseName = environment.CRM_TEST_DATABASE_NAME;
  const url = new URL(target.url);
  const rootInput = environment.CRM_TEST_EPHEMERAL_ROOT;
  const proofInput = environment.CRM_TEST_EPHEMERAL_PROOF;
  if (
    target.intent !== "disposable-test" ||
    !databaseName ||
    !DATABASE_PREFIX.test(databaseName) ||
    target.database !== databaseName ||
    url.hostname !== "127.0.0.1" ||
    decodeURIComponent(url.username) !== "postgres" ||
    url.password !== "" ||
    url.searchParams.has("host") ||
    !rootInput ||
    !proofInput
  ) {
    throw new Error("CRM persistence tests require a verified ephemeral loopback PostgreSQL instance.");
  }

  return { ...target, proofPath: proofInput, rootPath: rootInput };
}

export async function validateCrmPersistenceTestTarget(
  environment: Record<string, string | undefined> = process.env,
) {
  const target = validateCrmPersistenceTestTargetConfiguration(environment);
  const databaseName = environment.CRM_TEST_DATABASE_NAME!;
  const url = new URL(target.url);
  const rootInput = target.rootPath;
  const proofInput = target.proofPath;
  const root = await realpath(rootInput);
  const proofPath = await realpath(proofInput);
  if (
    path.dirname(root) !== "/dev/shm" ||
    !/^aichm-crm-test-[A-Za-z0-9_-]+$/.test(path.basename(root)) ||
    proofPath !== path.join(root, "identity.json")
  ) {
    throw new Error("CRM persistence scratch proof path is invalid.");
  }

  const [rootInfo, dataInfo, proofInfo, proofLink] = await Promise.all([
    stat(root),
    stat(path.join(root, "data")),
    stat(proofPath),
    lstat(proofInput),
  ]);
  if (
    (rootInfo.mode & 0o777) !== 0o700 ||
    (dataInfo.mode & 0o777) !== 0o700 ||
    (proofInfo.mode & 0o777) !== 0o600 ||
    proofLink.isSymbolicLink()
  ) {
    throw new Error("CRM persistence scratch permissions are invalid.");
  }

  const proof = JSON.parse(await readFile(proofPath, "utf8")) as CrmPersistenceScratchProof;
  const dataDirectory = await realpath(path.join(root, "data"));
  if (
    proof.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(proof.instanceId) ||
    proof.databaseName !== databaseName ||
    databaseName !== `aichm_test_${proof.instanceId}` ||
    !Number.isSafeInteger(proof.port) ||
    proof.port !== Number(url.port) ||
    proof.dataDirectory !== dataDirectory ||
    !/^\d+$/.test(proof.systemIdentifier) ||
    !Number.isSafeInteger(proof.postmasterPid)
  ) {
    throw new Error("CRM persistence scratch identity proof does not match the target.");
  }
  const pidFile = await readFile(path.join(dataDirectory, "postmaster.pid"), "utf8");
  if (Number(pidFile.split(/\r?\n/, 1)[0]) !== proof.postmasterPid) {
    throw new Error("CRM persistence PostgreSQL process proof does not match.");
  }

  return { ...target, proof };
}

export async function assertCrmPersistenceTestServerIdentity(
  pool: Pick<Pool, "query">,
  proof: CrmPersistenceScratchProof,
): Promise<void> {
  const { rows: [identity] } = await pool.query<{
    database_name: string;
    database_user: string;
    data_directory: string;
    host: string | null;
    port: number;
    system_identifier: string;
    in_recovery: boolean;
  }>(`
    SELECT current_database() AS database_name,
      current_user AS database_user,
      current_setting('data_directory') AS data_directory,
      host(inet_server_addr()) AS host,
      inet_server_port() AS port,
      (pg_control_system()).system_identifier::text AS system_identifier,
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
    throw new Error("CRM persistence PostgreSQL identity does not match the isolated scratch instance.");
  }
}
