import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  LegacySchemaGuardError,
  buildGuardedDrizzleConfigUrl,
  legacySchemaIdentityFingerprint,
  verifyLegacySchemaChangeTarget,
  type LegacySchemaGuardDependencies,
  type SchemaDatabaseIdentity,
} from "./legacy-schema-change-guard";

const sourceUrl =
  "postgresql://source-user:source-password@prod.example.test:5432/neondb?sslmode=require";
const developmentUrl =
  "postgresql://dev-user:dev-password@dev.example.test:5432/aichm_development?sslmode=require";

const productionIdentity: SchemaDatabaseIdentity = {
  database: "neondb",
  role: "source_role",
  serverAddress: "192.0.2.10",
  serverPort: 5432,
  serverVersionNum: 160015,
  inRecovery: false,
  transactionReadOnly: true,
};

const developmentIdentity: SchemaDatabaseIdentity = {
  database: "aichm_development",
  role: "development_role",
  serverAddress: "192.0.2.20",
  serverPort: 5432,
  serverVersionNum: 160015,
  inRecovery: false,
  transactionReadOnly: true,
};

function baseEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "development",
    AICHM_SCHEMA_CHANGE_INTENT: "development",
    AICHM_SOURCE_PROD_DATABASE_URL: sourceUrl,
    AICHM_DEVELOPMENT_DATABASE_URL: developmentUrl,
    AICHM_DEVELOPMENT_DATABASE_ID: legacySchemaIdentityFingerprint(
      developmentIdentity,
      "dev.example.test",
      5432,
    ),
    DATABASE_URL: sourceUrl,
    ...overrides,
  };
}

function dependencies(
  options: {
    production?: SchemaDatabaseIdentity;
    target?: SchemaDatabaseIdentity;
    productionError?: boolean;
    targetError?: boolean;
  } = {},
): LegacySchemaGuardDependencies {
  return {
    async readProductionIdentity() {
      if (options.productionError) throw new Error("unsafe raw error");
      return {
        identity: options.production ?? productionIdentity,
        endpointHost: "prod.example.test",
        endpointPort: 5432,
      };
    },
    async readDevelopmentIdentity() {
      if (options.targetError) throw new Error("unsafe raw error");
      return options.target ?? developmentIdentity;
    },
  };
}

function assertGuardCode(operation: () => unknown, code: string) {
  assert.throws(operation, (error: unknown) =>
    error instanceof LegacySchemaGuardError && error.code === code,
  );
}

test("legacy schema changes require explicit development intent", async () => {
  await assert.rejects(
    verifyLegacySchemaChangeTarget(
      baseEnvironment({ AICHM_SCHEMA_CHANGE_INTENT: undefined }),
      dependencies(),
    ),
    /SCHEMA_GUARD_EXPLICIT_DEVELOPMENT_INTENT_REQUIRED/,
  );
});

test("legacy schema changes fail closed when the production identity is missing or unreadable", async () => {
  await assert.rejects(
    verifyLegacySchemaChangeTarget(
      baseEnvironment({ AICHM_SOURCE_PROD_DATABASE_URL: undefined }),
      dependencies(),
    ),
    /SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE/,
  );
  await assert.rejects(
    verifyLegacySchemaChangeTarget(baseEnvironment(), dependencies({ productionError: true })),
    /SCHEMA_GUARD_PRODUCTION_IDENTITY_UNAVAILABLE/,
  );
});

test("a production DATABASE_URL or matching production target is never used as the development target", async () => {
  let targetReads = 0;
  const noTargetRead = dependencies();
  noTargetRead.readDevelopmentIdentity = async () => {
    targetReads += 1;
    return developmentIdentity;
  };
  await assert.rejects(
    verifyLegacySchemaChangeTarget(
      baseEnvironment({
        AICHM_DEVELOPMENT_DATABASE_URL: sourceUrl,
        AICHM_DEVELOPMENT_DATABASE_ID: undefined,
      }),
      noTargetRead,
      { allowMissingDevelopmentId: true },
    ),
    /SCHEMA_GUARD_PRODUCTION_TARGET_REJECTED/,
  );
  assert.equal(targetReads, 0);
  assertGuardCode(
    () =>
      buildGuardedDrizzleConfigUrl({
        DATABASE_URL: sourceUrl,
        AICHM_DEVELOPMENT_DATABASE_ID: undefined,
        AICHM_SCHEMA_CHANGE_VERIFIED_TARGET_ID: undefined,
      }),
    "SCHEMA_GUARD_CONFIG_MUST_BE_INVOKED_BY_VERIFIED_WRAPPER",
  );
});

test("unknown, mismatched, and unreachable development targets fail closed", async () => {
  await assert.rejects(
    verifyLegacySchemaChangeTarget(
      baseEnvironment({ AICHM_DEVELOPMENT_DATABASE_ID: undefined }),
      dependencies(),
    ),
    /SCHEMA_GUARD_DEVELOPMENT_ID_ALLOWLIST_REQUIRED/,
  );
  await assert.rejects(
    verifyLegacySchemaChangeTarget(
      baseEnvironment({ AICHM_DEVELOPMENT_DATABASE_ID: "0".repeat(64) }),
      dependencies(),
    ),
    /SCHEMA_GUARD_DEVELOPMENT_TARGET_NOT_ALLOWLISTED/,
  );
  await assert.rejects(
    verifyLegacySchemaChangeTarget(baseEnvironment(), dependencies({ targetError: true })),
    /SCHEMA_GUARD_TARGET_IDENTITY_UNAVAILABLE/,
  );
});

test("an explicitly allowlisted development database passes and config cannot fall back to DATABASE_URL", async () => {
  const environment = baseEnvironment();
  const verified = await verifyLegacySchemaChangeTarget(environment, dependencies());
  assert.equal(verified.targetUrl, developmentUrl);
  assert.equal(verified.targetIdentityId, environment.AICHM_DEVELOPMENT_DATABASE_ID);
  assert.equal(
    buildGuardedDrizzleConfigUrl({
      AICHM_DEVELOPMENT_DATABASE_URL: developmentUrl,
      AICHM_DEVELOPMENT_DATABASE_ID: verified.targetIdentityId,
      AICHM_SCHEMA_CHANGE_VERIFIED_TARGET_ID: verified.targetIdentityId,
      DATABASE_URL: sourceUrl,
    }),
    developmentUrl,
  );
});

test("socket-only disposable database tests pass only for known generated-artifacts targets", async () => {
  const socketRoot = path.join(process.cwd(), "generated-artifacts", "first-owner-db-test");
  const url =
    `postgresql://first_owner_test@localhost/first_owner_test?host=${encodeURIComponent(socketRoot)}&port=55448`;
  const socketIdentity: SchemaDatabaseIdentity = {
    database: "first_owner_test",
    role: "first_owner_test",
    serverAddress: null,
    serverPort: null,
    serverVersionNum: 160015,
    inRecovery: false,
    transactionReadOnly: true,
  };
  const verified = await verifyLegacySchemaChangeTarget(
    baseEnvironment({
      NODE_ENV: "test",
      AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
      AICHM_DEVELOPMENT_DATABASE_URL: url,
      AICHM_DEVELOPMENT_DATABASE_ID: undefined,
    }),
    dependencies({ target: socketIdentity }),
  );
  assert.equal(verified.targetUrl, url);
  assert.equal(verified.intent, "disposable-test");

  await assert.rejects(
    verifyLegacySchemaChangeTarget(
      baseEnvironment({
        NODE_ENV: "test",
        AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
        AICHM_DEVELOPMENT_DATABASE_URL:
          "postgresql://first_owner_test@localhost/first_owner_test?host=/tmp/not-generated-artifacts&port=55448",
        AICHM_DEVELOPMENT_DATABASE_ID: undefined,
      }),
      dependencies({ target: socketIdentity }),
    ),
    /SCHEMA_GUARD_LOCAL_SOCKET_TARGET_REJECTED/,
  );
});

test("default Drizzle config and post-merge hook route through the fail-closed guard", () => {
  const config = readFileSync("drizzle.config.ts", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const postMerge = readFileSync("script/post-merge.sh", "utf8");

  assert.doesNotMatch(config, /process\.env\.DATABASE_URL/);
  assert.match(config, /buildGuardedDrizzleConfigUrl/);
  assert.match(packageJson.scripts["db:migrate"], /guarded-drizzle\.ts migrate/);
  assert.match(packageJson.scripts["db:push"], /guarded-drizzle\.ts push/);
  assert.match(postMerge, /AICHM_SCHEMA_CHANGE_INTENT/);
  assert.match(postMerge, /npm run db:push/);
});
