import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertCrmForwardDevelopmentIdentity,
  CRM_FORWARD_DEVELOPMENT_IDENTITY,
  requireCrmForwardConnectionUrl,
  type CrmForwardDatabaseIdentity,
} from "./crm-forward-migration-guard";

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
