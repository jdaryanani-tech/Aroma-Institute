import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertCrmForwardDevelopmentIdentity,
  crmForwardEffectivePort,
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

test("CRM forward guard requires its named URL and never falls back to DATABASE_URL", () => {
  assert.throws(
    () => requireCrmForwardConnectionUrl({ DATABASE_URL: "postgresql://example.invalid/neondb" }),
    /CRM_FORWARD_EXPLICIT_DEVELOPMENT_URL_REQUIRED/,
  );
});

test("CRM forward guard requires an explicit URL; live identity validation remains mandatory", () => {
  const url = "postgresql://postgres:placeholder@dev.example.invalid:5432/heliumdb?sslmode=verify-full";
  assert.equal(requireCrmForwardConnectionUrl({
    AICHM_CRM_FORWARD_DATABASE_URL: url,
    DATABASE_URL: "postgresql://ignored.invalid/neondb",
  }), url);
  assert.throws(
    () => requireCrmForwardConnectionUrl({
      AICHM_CRM_FORWARD_DATABASE_URL: "postgresql://postgres:placeholder@dev.example.invalid:5432/heliumdb?sslmode=require&sslmode=verify-full",
    }),
    /CRM_FORWARD_CONNECTION_URL_REJECTED/,
  );
  assert.throws(
    () => requireCrmForwardConnectionUrl({
      AICHM_CRM_FORWARD_DATABASE_URL: "postgresql://postgres:placeholder@dev.example.invalid:5432/neondb",
    }),
    /CRM_FORWARD_CONNECTION_URL_REJECTED/,
  );
});

test("CRM forward URL uses fixed port 5432 only when the URI omits its port", () => {
  const url = "postgresql://postgres:placeholder@dev.example.invalid/heliumdb?sslmode=verify-full";
  assert.equal(requireCrmForwardConnectionUrl({ AICHM_CRM_FORWARD_DATABASE_URL: url }), url);
  assert.equal(crmForwardEffectivePort(new URL(url)), 5432);
});

test("CRM forward URL honors an explicit valid port exactly", () => {
  const url = "postgresql://postgres:placeholder@dev.example.invalid:6543/heliumdb?sslmode=require";
  assert.equal(requireCrmForwardConnectionUrl({ AICHM_CRM_FORWARD_DATABASE_URL: url }), url);
  assert.equal(crmForwardEffectivePort(new URL(url)), 6543);
});

test("CRM forward URL rejects explicit invalid ports", () => {
  for (const port of ["0", "65536", "not-a-port"]) {
    const url = `postgresql://postgres:placeholder@dev.example.invalid:${port}/heliumdb`;
    assert.throws(
      () => requireCrmForwardConnectionUrl({ AICHM_CRM_FORWARD_DATABASE_URL: url }),
      /CRM_FORWARD_CONNECTION_URL_(?:INVALID|REJECTED)/,
      `port ${port} must be rejected`,
    );
  }
});

test("CRM forward port default does not weaken the pinned live identity check", () => {
  const url = "postgresql://postgres:placeholder@dev.example.invalid/heliumdb";
  assert.equal(crmForwardEffectivePort(new URL(url)), 5432);
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
  assert.match(runner, /port:\s*effectivePort/);
  assert.match(runner, /effectivePort,/);
  assert.doesNotMatch(runner, /process\.env\.PGPORT/);
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
  ]);
  assert.ok(registry.migrations.every(migration => migration.file.startsWith("../")));
  assert.equal(mainJournalText.includes("0014_crm_canonical_assignments"), false);
  assert.equal(mainJournalText.includes("0015_crm_assignment_audit_invariants"), false);
  assert.equal(aichmJournalText.includes("0014_crm_canonical_assignments"), false);
  assert.equal(aichmJournalText.includes("0015_crm_assignment_audit_invariants"), false);
});

test("CRM forward runner previews by default and applies only under explicit confirmation and lock", async () => {
  const source = await readFile("script/crm-forward-migrate.ts", "utf8");
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
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
