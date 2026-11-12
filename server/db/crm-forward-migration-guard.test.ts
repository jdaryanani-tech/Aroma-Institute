import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertCrmForwardDevelopmentIdentity,
  crmForwardEffectivePort,
  CRM_FORWARD_GUARD_ERROR_CODES,
  CRM_FORWARD_DEVELOPMENT_IDENTITY,
  requireCrmForwardConnectionUrl,
  type CrmForwardDatabaseIdentity,
} from "./crm-forward-migration-guard";
import {
  CRM_FORWARD_APPLY_CONFIRM_ENV,
  CRM_FORWARD_APPLY_CONFIRM_VALUE,
  CRM_FORWARD_APPLY_FLAG,
  parseCrmForwardMigrationMode,
} from "./crm-forward-migration-mode";

const expectedIdentity: CrmForwardDatabaseIdentity = {
  ...CRM_FORWARD_DEVELOPMENT_IDENTITY,
  inRecovery: false,
  defaultTransactionReadOnly: false,
};

const dedicatedUrl = "postgresql://postgres:dedicated-placeholder@helium:5432/heliumdb?sslmode=disable";
const runtimeUrl = "postgresql://postgres:runtime-placeholder@helium/heliumdb?sslmode=disable";

test("CRM forward guard requires both the dedicated URL and runtime comparison reference", () => {
  assert.throws(
    () => requireCrmForwardConnectionUrl({ DATABASE_URL: "postgresql://example.invalid/neondb" }),
    (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.dedicatedUrlRequired,
  );
  assert.throws(
    () => requireCrmForwardConnectionUrl({ AICHM_CRM_FORWARD_DATABASE_URL: dedicatedUrl }),
    (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.runtimeUrlRequired,
  );
  assert.throws(
    () => requireCrmForwardConnectionUrl({
      AICHM_CRM_FORWARD_DATABASE_URL: dedicatedUrl,
      DATABASE_URL: "not a PostgreSQL URL",
    }),
    (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.runtimeUrlInvalid,
  );
});

test("matching internal Development endpoints pass and return only the dedicated URL", () => {
  assert.equal(requireCrmForwardConnectionUrl({
    AICHM_CRM_FORWARD_DATABASE_URL: dedicatedUrl,
    DATABASE_URL: runtimeUrl,
  }), dedicatedUrl);
});

test("CRM forward rejects each endpoint mismatch before connecting", () => {
  const mismatches = [
    "postgresql://postgres:runtime-placeholder@helium-other/heliumdb?sslmode=disable",
    "postgresql://postgres:runtime-placeholder@helium:6543/heliumdb?sslmode=disable",
    "postgresql://other:runtime-placeholder@helium/heliumdb?sslmode=disable",
    "postgresql://postgres:runtime-placeholder@helium/otherdb?sslmode=disable",
  ];
  for (const DATABASE_URL of mismatches) {
    assert.throws(
      () => requireCrmForwardConnectionUrl({
        AICHM_CRM_FORWARD_DATABASE_URL: dedicatedUrl,
        DATABASE_URL,
      }),
      (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.endpointMismatch,
    );
  }
});

test("CRM forward rejects external hosts in either URL", () => {
  for (const [AICHM_CRM_FORWARD_DATABASE_URL, DATABASE_URL] of [
    ["postgresql://postgres:dedicated-placeholder@db.example.com/heliumdb?sslmode=disable", "postgresql://postgres:runtime-placeholder@db.example.com/heliumdb"],
    [dedicatedUrl, "postgresql://postgres:runtime-placeholder@db.example.com/heliumdb"],
  ]) {
    assert.throws(
      () => requireCrmForwardConnectionUrl({ AICHM_CRM_FORWARD_DATABASE_URL, DATABASE_URL }),
      (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.endpointMustBeInternal,
    );
  }
});

test("CRM forward accepts private IP endpoints but rejects public IP endpoints", () => {
  const privateUrl = "postgresql://postgres:placeholder@10.24.16.8/heliumdb?sslmode=disable";
  assert.equal(requireCrmForwardConnectionUrl({
    AICHM_CRM_FORWARD_DATABASE_URL: privateUrl,
    DATABASE_URL: "postgresql://postgres:placeholder@10.24.16.8:5432/heliumdb",
  }), privateUrl);

  const publicUrl = "postgresql://postgres:placeholder@8.8.8.8/heliumdb?sslmode=disable";
  assert.throws(
    () => requireCrmForwardConnectionUrl({
      AICHM_CRM_FORWARD_DATABASE_URL: publicUrl,
      DATABASE_URL: "postgresql://postgres:placeholder@8.8.8.8/heliumdb",
    }),
    (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.endpointMustBeInternal,
  );
});

test("CRM forward requires the exact dedicated non-TLS mode and rejects ambiguous options", () => {
  const rejectedUrls = [
    "postgresql://postgres:placeholder@helium/heliumdb",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=require",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=verify-full",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=allow",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=prefer",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=verify-ca",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=no-verify",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=disable&sslmode=disable",
    "postgresql://postgres:placeholder@helium/heliumdb?ssl=1",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=disable&sslrootcert=ca.pem",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=disable&channel_binding=require",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=disable&application_name=test",
    "postgresql://postgres:placeholder@helium/heliumdb?sslmode=",
  ];
  for (const AICHM_CRM_FORWARD_DATABASE_URL of rejectedUrls) {
    assert.throws(
      () => requireCrmForwardConnectionUrl({ AICHM_CRM_FORWARD_DATABASE_URL, DATABASE_URL: runtimeUrl }),
      (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.nonTlsOnly,
    );
  }
});

test("CRM forward rejects URL fragments before endpoint comparison", () => {
  assert.throws(
    () => requireCrmForwardConnectionUrl({
      AICHM_CRM_FORWARD_DATABASE_URL: "postgresql://postgres:placeholder@helium/heliumdb?sslmode=disable#",
      DATABASE_URL: runtimeUrl,
    }),
    (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.dedicatedUrlInvalid,
  );
});

test("CRM forward rejects runtime endpoint override parameters", () => {
  for (const parameter of ["host=helium", "port=5432", "user=postgres", "password=placeholder", "database=heliumdb"]) {
    assert.throws(
      () => requireCrmForwardConnectionUrl({
        AICHM_CRM_FORWARD_DATABASE_URL: dedicatedUrl,
        DATABASE_URL: `${runtimeUrl}&${parameter}`,
      }),
      (error: unknown) => (error as Error & { code?: string }).code === CRM_FORWARD_GUARD_ERROR_CODES.runtimeUrlInvalid,
    );
  }
});

test("CRM forward uses fixed port 5432 for omitted ports and honors explicit ports", () => {
  const omitted = new URL(runtimeUrl);
  const explicit = new URL("postgresql://postgres:placeholder@helium:6543/heliumdb?sslmode=disable");
  assert.equal(crmForwardEffectivePort(omitted), 5432);
  assert.equal(crmForwardEffectivePort(explicit), 6543);
  assert.equal(requireCrmForwardConnectionUrl({
    AICHM_CRM_FORWARD_DATABASE_URL: "postgresql://postgres:placeholder@helium/heliumdb?sslmode=disable",
    DATABASE_URL: runtimeUrl,
  }), "postgresql://postgres:placeholder@helium/heliumdb?sslmode=disable");
});

test("CRM forward URL rejects explicit invalid ports", () => {
  for (const port of ["0", "65536", "not-a-port"]) {
    const url = `postgresql://postgres:placeholder@helium:${port}/heliumdb?sslmode=disable`;
    assert.throws(
      () => requireCrmForwardConnectionUrl({ AICHM_CRM_FORWARD_DATABASE_URL: url, DATABASE_URL: runtimeUrl }),
      /CRM_FORWARD_INTERNAL_DEVELOPMENT_/,
      `port ${port} must be rejected`,
    );
  }
});

test("CRM forward port default does not weaken the pinned live identity check", () => {
  assert.equal(crmForwardEffectivePort(new URL(dedicatedUrl)), 5432);
  assert.throws(
    () => assertCrmForwardDevelopmentIdentity({
      ...expectedIdentity,
      systemIdentifier: "1",
    }),
    /CRM_FORWARD_DEVELOPMENT_IDENTITY_MISMATCH/,
  );
});

test("CRM forward runner uses the resolved port explicitly and reports it", async () => {
  const runner = await readFile(new URL("../../script/crm-forward-migrate.ts", import.meta.url), "utf8");
  const guard = await readFile(new URL("./crm-forward-migration-guard.ts", import.meta.url), "utf8");
  assert.match(runner, /port:\s*effectivePort/);
  assert.match(runner, /ssl:\s*false/);
  assert.doesNotMatch(runner, /crmForwardTlsOptions/);
  assert.match(runner, /effectivePort,/);
  assert.doesNotMatch(runner, /process\.env\.PGPORT/);
  assert.doesNotMatch(runner, /process\.env\.NEON_DATABASE_URL/);
  assert.match(guard, /environment\.AICHM_CRM_FORWARD_DATABASE_URL/);
  assert.match(guard, /environment\.DATABASE_URL/);
  assert.doesNotMatch(guard, /environment\.(?:NEON_DATABASE_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD)/);
  assert.ok(
    runner.indexOf("requireCrmForwardConnectionUrl(process.env)") <
      runner.indexOf("new Pool(pgConfig(connectionUrl, effectivePort))"),
    "both URL checks must finish before pool construction",
  );
});

test("CRM forward identity accepts the pinned Development tuple", () => {
  assert.doesNotThrow(() => assertCrmForwardDevelopmentIdentity(expectedIdentity));
});

test("CRM forward identity rejects the known Production tuple", () => {
  assert.throws(
    () => assertCrmForwardDevelopmentIdentity({
      databaseName: "neondb",
      databaseOid: "16395",
      databaseUser: "neondb_owner",
      systemIdentifier: "7609038573599248406",
      inRecovery: false,
      defaultTransactionReadOnly: false,
    }),
    /CRM_FORWARD_PRODUCTION_IDENTITY_REJECTED/,
  );
});

test("CRM forward identity rejects unknown database, OID, user, system, replica, or read-only mode", () => {
  for (const change of [
    { databaseName: "unknown" },
    { databaseOid: "16395" },
    { databaseUser: "unknown_user" },
    { systemIdentifier: "1" },
    { inRecovery: true },
    { defaultTransactionReadOnly: true },
  ]) {
    assert.throws(
      () => assertCrmForwardDevelopmentIdentity({ ...expectedIdentity, ...change }),
      /CRM_FORWARD_(?:DEVELOPMENT_IDENTITY_MISMATCH|PRODUCTION_IDENTITY_REJECTED)/,
    );
  }
});

test("CRM forward runner defaults to read-only preview", () => {
  assert.equal(parseCrmForwardMigrationMode([], {}), "preview");
  assert.equal(parseCrmForwardMigrationMode(["--preview"], {}), "preview");
  assert.equal(
    parseCrmForwardMigrationMode([], { [CRM_FORWARD_APPLY_CONFIRM_ENV]: CRM_FORWARD_APPLY_CONFIRM_VALUE }),
    "preview",
  );
});

test("CRM forward runner requires both the apply flag and exact confirmation value", () => {
  assert.throws(
    () => parseCrmForwardMigrationMode([CRM_FORWARD_APPLY_FLAG], {}),
    /CRM_FORWARD_EXPLICIT_APPLY_CONFIRMATION_REQUIRED/,
  );
  assert.throws(
    () => parseCrmForwardMigrationMode([CRM_FORWARD_APPLY_FLAG], {
      [CRM_FORWARD_APPLY_CONFIRM_ENV]: "wrong",
    }),
    /CRM_FORWARD_EXPLICIT_APPLY_CONFIRMATION_REQUIRED/,
  );
  assert.equal(
    parseCrmForwardMigrationMode([CRM_FORWARD_APPLY_FLAG], {
      [CRM_FORWARD_APPLY_CONFIRM_ENV]: CRM_FORWARD_APPLY_CONFIRM_VALUE,
    }),
    "apply",
  );
  assert.throws(
    () => parseCrmForwardMigrationMode(["--apply-crm-migrations", "--preview"], {
      [CRM_FORWARD_APPLY_CONFIRM_ENV]: CRM_FORWARD_APPLY_CONFIRM_VALUE,
    }),
    /CRM_FORWARD_ARGUMENTS_REJECTED/,
  );
});

test("CRM migrations are registered only in their separate forward stream", async () => {
  const [registryText, mainJournalText, aichmJournalText] = await Promise.all([
    readFile("migrations/crm-forward/registry.json", "utf8"),
    readFile("migrations/meta/_journal.json", "utf8"),
    readFile("migrations/aichm-forward/meta/_journal.json", "utf8"),
  ]);
  const registry = JSON.parse(registryText) as {
    stream: string;
    ledger: { schema: string; table: string };
    migrations: Array<{ id: string; file: string }>;
  };
  assert.equal(registry.stream, "aichm-crm-forward");
  assert.deepEqual(registry.ledger, {
    schema: "aichm_crm_forward_meta",
    table: "schema_migrations",
  });
  assert.deepEqual(registry.migrations.map(migration => migration.id), [
    "0014_crm_canonical_assignments",
    "0015_crm_assignment_audit_invariants",
    "0016_crm_runtime_role_separation",
  ]);
  assert.ok(registry.migrations.every(migration => migration.file.startsWith("../")));
  assert.equal(mainJournalText.includes("0014_crm_canonical_assignments"), false);
  assert.equal(mainJournalText.includes("0015_crm_assignment_audit_invariants"), false);
  assert.equal(aichmJournalText.includes("0014_crm_canonical_assignments"), false);
  assert.equal(aichmJournalText.includes("0015_crm_assignment_audit_invariants"), false);
  assert.equal(mainJournalText.includes("0016_crm_runtime_role_separation"), false);
  assert.equal(aichmJournalText.includes("0016_crm_runtime_role_separation"), false);
});

test("CRM forward runner previews by default and applies only under explicit confirmation and lock", async () => {
  const source = await readFile("script/crm-forward-migrate.ts", "utf8");
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
  assert.match(source, /requireCrmForwardConnectionUrl\(process\.env\)/);
  assert.match(source, /parseCrmForwardMigrationMode/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /pg_advisory_lock/);
  assert.match(source, /pg_advisory_unlock/);
  assert.match(source, /assertCrmForwardDevelopmentIdentity/);
  assert.match(source, /assertCrmAssignmentSchemaPostconditions/);
  assert.match(source, /CRM_FORWARD_DEVELOPMENT_IDENTITY/);
});

test("isolated CRM test launcher bounds child work and cleans up after signals", async () => {
  const source = await readFile("script/test-crm-persistence.ts", "utf8");
  assert.match(source, /process\.on\("SIGINT", onTermination\)/);
  assert.match(source, /process\.on\("SIGTERM", onTermination\)/);
  assert.match(source, /CRM_TEST_SCRATCH_TOOL_TIMEOUT/);
  assert.match(source, /240_000/);
  assert.match(source, /allowDuringTermination/);
  assert.match(source, /stopConfirmAndRemoveScratchPostgres/);
  assert.match(source, /scratchPreserved/);
});
