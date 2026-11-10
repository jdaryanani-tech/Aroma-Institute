import { validateLegacySchemaChangeTarget } from "../db/legacy-schema-change-guard";

const APPROVAL = "TEMPORARY_DEVELOPMENT_SCHEMA_ONLY";
const DEDICATED_DATABASE = /^aichm_test_[a-f0-9]{16,}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function validateCrmPersistenceTestTarget(
  environment: Record<string, string | undefined> = process.env,
) {
  if (environment.NODE_ENV !== "test" || environment.CRM_TEST_DB_WRITE_APPROVED !== APPROVAL) {
    throw new Error("CRM persistence tests require explicit disposable-database approval.");
  }

  const target = validateLegacySchemaChangeTarget(environment);
  const dedicatedName = environment.CRM_TEST_DATABASE_NAME;
  const url = new URL(target.url);
  if (
    target.intent !== "disposable-test" ||
    !dedicatedName ||
    !DEDICATED_DATABASE.test(dedicatedName) ||
    target.database !== dedicatedName ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.searchParams.has("host")
  ) {
    throw new Error("CRM persistence tests require the named, dedicated loopback test database.");
  }

  return target;
}
