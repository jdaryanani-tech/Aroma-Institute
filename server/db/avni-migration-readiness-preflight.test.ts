import assert from "node:assert/strict";
import test from "node:test";
import {
  AVNI_MIGRATION_SOURCE_ORDER,
  inspectAvniMigrationReadiness,
  validateAvniMigrationSourceOrder,
  type AvniDatabaseIdentityExpectation,
} from "./avni-migration-readiness-preflight";

const identity: AvniDatabaseIdentityExpectation = {
  databaseName: "synthetic_crm",
  serverAddress: "127.0.0.1",
  serverPort: 55432,
  sessionUser: "synthetic_login",
  currentUser: "synthetic_runtime",
};

function fakeClient(
  statements: string[],
  identityMatches = true,
) {
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      statements.push(sql.trim().toUpperCase());
      if (["BEGIN READ ONLY", "COMMIT", "ROLLBACK"].includes(sql.trim().toUpperCase())) {
        return { rows: [] };
      }
      if (sql.includes("current_setting('transaction_read_only')")) {
        return { rows: [{ read_only: "on" } as T] };
      }
      if (sql.includes("current_database")) {
        return { rows: [{
          database_name: identityMatches ? identity.databaseName : "wrong",
          server_address: identity.serverAddress,
          server_port: identity.serverPort,
          session_user: identity.sessionUser,
          current_user: identity.currentUser,
          in_recovery: false,
        } as T] };
      }
      throw new Error("mock_catalog_checker_must_be_injected");
    },
  };
}

const sourceOrder = {
  replit: [...AVNI_MIGRATION_SOURCE_ORDER.replit],
  supabase: [...AVNI_MIGRATION_SOURCE_ORDER.supabase],
};

test("AVNI migration source order requires both targets and explicit prerequisites", () => {
  assert.equal(validateAvniMigrationSourceOrder(sourceOrder), true);
  assert.equal(validateAvniMigrationSourceOrder({
    ...sourceOrder,
    supabase: [...sourceOrder.supabase].reverse(),
  }), false);
  assert.equal(validateAvniMigrationSourceOrder({
    ...sourceOrder,
    replit: [sourceOrder.replit[1]!, sourceOrder.replit[0]!],
  }), false);
});

test("preflight does not connect when target identity is not explicitly approved", async () => {
  const statements: string[] = [];
  const report = await inspectAvniMigrationReadiness({
    replit: { client: fakeClient(statements), expectedIdentity: null, sourceOrder: sourceOrder.replit },
    supabase: { client: null, expectedIdentity: null, sourceOrder: sourceOrder.supabase },
    crmMigrationSqlRegisteredInDrizzleJournal: false,
  });
  assert.equal(report.replit.status, "not_checked");
  assert.equal(report.supabase.status, "not_checked");
  assert.deepEqual(statements, []);
  assert.equal(report.dispatchEnabled, false);
  assert.equal(report.appliedMigrationState, "not_checked");
});

test("read-only preflight blocks an identity mismatch without running catalog checks", async () => {
  const statements: string[] = [];
  const report = await inspectAvniMigrationReadiness({
    replit: {
      client: fakeClient(statements, false),
      expectedIdentity: identity,
      runtimeMigrationSql: "-- synthetic migration source",
      sourceOrder: sourceOrder.replit,
    },
    supabase: { client: null, expectedIdentity: null, sourceOrder: sourceOrder.supabase },
    crmMigrationSqlRegisteredInDrizzleJournal: false,
  });
  assert.equal(report.replit.targetIdentity, "mismatch");
  assert.equal(report.replit.catalog, "not_checked");
  assert.ok(statements.every(sql =>
    sql === "BEGIN READ ONLY" || sql.includes("CURRENT_SETTING") ||
    sql.includes("CURRENT_DATABASE") || sql === "COMMIT" || sql === "ROLLBACK",
  ), JSON.stringify(statements));
});

test("preflight target adapter is SELECT-only and reports only safe status codes", async () => {
  const statements: string[] = [];
  const forbidden = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|CALL)\b/i;
  const client = {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      statements.push(sql);
      if (sql === "BEGIN READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("current_setting('transaction_read_only')")) {
        return { rows: [{ read_only: "on" } as T] };
      }
      if (sql.includes("current_database")) return { rows: [{
        database_name: identity.databaseName,
        server_address: identity.serverAddress,
        server_port: identity.serverPort,
        session_user: identity.sessionUser,
        current_user: identity.currentUser,
        in_recovery: false,
      } as T] };
      throw new Error("synthetic catalog checker unavailable");
    },
  };
  const report = await inspectAvniMigrationReadiness({
    replit: { client, expectedIdentity: identity, runtimeMigrationSql: "-- source", sourceOrder: sourceOrder.replit },
    supabase: { client: null, expectedIdentity: null, sourceOrder: sourceOrder.supabase },
    crmMigrationSqlRegisteredInDrizzleJournal: false,
  });
  assert.equal(report.replit.status, "blocked");
  assert.equal(report.replit.safeCode, "CRM_RUNTIME_CATALOG_CHECK_FAILED");
  assert.equal(report.replit.targetIdentity, "matched_primary");
  assert.equal(report.dispatchEnabled, false);
  assert.ok(statements.every(sql => !forbidden.test(sql)));
  assert.ok(statements.includes("BEGIN READ ONLY"));
  assert.ok(statements.includes("COMMIT") === false);
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(JSON.stringify(report).includes("synthetic_crm"), false);
});

test("unapproved migration order blocks both targets without querying either", async () => {
  const statements: string[] = [];
  const report = await inspectAvniMigrationReadiness({
    replit: {
      client: fakeClient(statements),
      expectedIdentity: identity,
      runtimeMigrationSql: "-- no execution",
      sourceOrder: sourceOrder.replit,
    },
    supabase: {
      client: fakeClient(statements),
      expectedIdentity: identity,
      sourceOrder: ["not-the-approved-migration"],
    },
    crmMigrationSqlRegisteredInDrizzleJournal: false,
  });
  assert.equal(report.sourceMigrationOrder, "mismatch");
  assert.equal(report.replit.safeCode, "AVNI_MIGRATION_SOURCE_ORDER_MISMATCH");
  assert.equal(report.supabase.safeCode, "AVNI_MIGRATION_SOURCE_ORDER_MISMATCH");
  assert.equal(report.dispatchEnabled, false);
  assert.deepEqual(statements, [], "order failure must stop before either DB is queried");
});
