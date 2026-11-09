import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  LegacySchemaGuardError,
  requireGuardedDrizzleConfigUrl,
  validateLegacySchemaChangeTarget,
} from "./legacy-schema-change-guard.js";

const localDevelopmentUrl =
  "postgresql://dev_user:dev_password@127.0.0.1:5432/aichm_dev_local";
const productionUrl =
  "postgresql://production_user:production_password@db.example.invalid:5432/neondb";

function devEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "development",
    AICHM_SCHEMA_CHANGE_INTENT: "development",
    AICHM_DEVELOPMENT_DATABASE_URL: localDevelopmentUrl,
    DATABASE_URL: productionUrl,
    ...overrides,
  };
}

function assertGuardCode(
  operation: () => unknown,
  expectedCode: string,
): void {
  assert.throws(operation, (error: unknown) =>
    error instanceof LegacySchemaGuardError && error.code === expectedCode,
  );
}

test("legacy db:migrate and db:push reject the default environment", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const tsxCli = path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: productionUrl,
    NODE_ENV: "development",
  };

  for (const action of ["migrate", "push"]) {
    const result = spawnSync(
      process.execPath,
      [tsxCli, "script/guarded-drizzle.ts", action],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 1, `${action} should fail before Drizzle starts`);
    assert.match(result.stderr, /SCHEMA_GUARD_EXPLICIT_DEVELOPMENT_INTENT_REQUIRED/);
    assert.doesNotMatch(result.stderr, /production_password|db\.example\.invalid/);
  }

  assert.match(packageJson.scripts["db:migrate"], /guarded-drizzle\.ts migrate/);
  assert.match(packageJson.scripts["db:push"], /guarded-drizzle\.ts push/);
});

test("explicit intent and dedicated URL are required; ambient DATABASE_URL is ignored", () => {
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget(
        devEnvironment({ AICHM_SCHEMA_CHANGE_INTENT: undefined }),
      ),
    "SCHEMA_GUARD_EXPLICIT_DEVELOPMENT_INTENT_REQUIRED",
  );
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget(
        devEnvironment({ AICHM_DEVELOPMENT_DATABASE_URL: undefined }),
      ),
    "SCHEMA_GUARD_DEVELOPMENT_DATABASE_URL_REQUIRED",
  );
  assertGuardCode(
    () =>
      requireGuardedDrizzleConfigUrl({
        NODE_ENV: "development",
        DATABASE_URL: localDevelopmentUrl,
      }),
    "SCHEMA_GUARD_EXPLICIT_DEVELOPMENT_INTENT_REQUIRED",
  );
});

test("production, unknown, mismatched, and non-loopback targets fail closed", () => {
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget(
        devEnvironment({ AICHM_DEVELOPMENT_DATABASE_URL: productionUrl }),
      ),
    "SCHEMA_GUARD_NON_LOOPBACK_TARGET_REJECTED",
  );
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget(
        devEnvironment({
          AICHM_DEVELOPMENT_DATABASE_URL:
            "postgresql://local_user@127.0.0.1:5432/neondb",
        }),
      ),
    "SCHEMA_GUARD_UNKNOWN_DEVELOPMENT_DATABASE",
  );
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget(
        devEnvironment({
          AICHM_DEVELOPMENT_DATABASE_URL:
            "postgresql://local_user@127.0.0.1:5432/aichm_dev_unlisted",
        }),
      ),
    "SCHEMA_GUARD_UNKNOWN_DEVELOPMENT_DATABASE",
  );
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget(
        devEnvironment({ NODE_ENV: "production" }),
      ),
    "SCHEMA_GUARD_PRODUCTION_RUNTIME_REJECTED",
  );
});

test("direct Drizzle config accepts only the explicit local development database", () => {
  const environment = devEnvironment();
  const validated = validateLegacySchemaChangeTarget(environment);
  assert.equal(validated.database, "aichm_dev_local");
  assert.equal(validated.url, localDevelopmentUrl);
  assert.equal(requireGuardedDrizzleConfigUrl(environment), localDevelopmentUrl);
});

test("disposable TCP test targets must be loopback and use aichm_test names", () => {
  const environment = {
    NODE_ENV: "test",
    AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
    AICHM_DEVELOPMENT_DATABASE_URL:
      "postgresql://test_user@127.0.0.1:5432/aichm_test_guard",
    DATABASE_URL: productionUrl,
  };
  assert.equal(
    validateLegacySchemaChangeTarget(environment).database,
    "aichm_test_guard",
  );
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget({
        ...environment,
        AICHM_DEVELOPMENT_DATABASE_URL:
          "postgresql://test_user@test.example.invalid:5432/aichm_test_guard",
      }),
    "SCHEMA_GUARD_NON_LOOPBACK_TARGET_REJECTED",
  );
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget({
        ...environment,
        AICHM_DEVELOPMENT_DATABASE_URL:
          "postgresql://test_user@127.0.0.1:5432/neondb",
      }),
    "SCHEMA_GUARD_TARGET_REJECTED",
  );
});

test("socket-only disposable test targets remain limited to known generated-artifacts paths", () => {
  const socketRoot = path.join(
    process.cwd(),
    "generated-artifacts",
    "first-owner-db-test",
  );
  const socketUrl = `postgresql://first_owner_test@localhost/first_owner_test?host=${encodeURIComponent(socketRoot)}&port=55448`;
  const environment = {
    NODE_ENV: "test",
    AICHM_SCHEMA_CHANGE_INTENT: "disposable-test",
    AICHM_DEVELOPMENT_DATABASE_URL: socketUrl,
    DATABASE_URL: productionUrl,
  };
  assert.equal(
    validateLegacySchemaChangeTarget(environment).database,
    "first_owner_test",
  );
  assertGuardCode(
    () =>
      validateLegacySchemaChangeTarget({
        ...environment,
        AICHM_DEVELOPMENT_DATABASE_URL:
          "postgresql://first_owner_test@localhost/first_owner_test?host=%2Ftmp%2Fnot-allowed&port=55448",
      }),
    "SCHEMA_GUARD_TARGET_REJECTED",
  );
});

test("post-merge skips schema changes and the forward baseline keeps its scratch config", () => {
  const postMerge = readFileSync("script/post-merge.sh", "utf8");
  const replitConfig = readFileSync(".replit", "utf8");
  const drizzleConfig = readFileSync("drizzle.config.ts", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const wrapper = readFileSync("script/guarded-drizzle.ts", "utf8");

  assert.match(postMerge, /Skipping post-merge schema sync/);
  assert.doesNotMatch(postMerge, /npm run db:push|npm run db:migrate|drizzle-kit (?:push|migrate)/);
  assert.match(replitConfig, /path = "script\/post-merge\.sh"/);
  assert.match(drizzleConfig, /requireGuardedDrizzleConfigUrl/);
  assert.doesNotMatch(drizzleConfig, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(wrapper, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(wrapper, /^\s*DATABASE_URL\s*:/m);
  assert.match(wrapper, /AICHM_DEVELOPMENT_DATABASE_URL/);
  assert.match(packageJson.scripts["db:aichm-forward:migrate"], /drizzle\.aichm-forward\.config\.ts/);
  assert.match(packageJson.scripts["db:generate"], /drizzle\.generate\.config\.ts/);
});
