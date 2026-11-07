import assert from "node:assert/strict";
import test from "node:test";
import { assertLegacyImportApplyGate } from "./supabase-legacy-import-runner";

test("legacy import defaults to dry-run and refuses apply without every explicit gate", () => {
  assert.doesNotThrow(() => assertLegacyImportApplyGate({ apply: false }, {}));
  assert.throws(() => assertLegacyImportApplyGate({ apply: true, manifestPath: "review.json" }, {}), /apply_prerequisites_missing/);
  assert.throws(() => assertLegacyImportApplyGate({
    apply: true, manifestPath: "review.json",
  }, {
    AICHM_SUPABASE_LEGACY_IMPORT_ENABLED: "true",
    AICHM_MIGRATION_APPROVAL_PUBLIC_KEY: "public-key",
  }), /apply_prerequisites_missing/);
  assert.doesNotThrow(() => assertLegacyImportApplyGate({
    apply: true, manifestPath: "review.json",
  }, {
    AICHM_SUPABASE_LEGACY_IMPORT_ENABLED: "true",
    AICHM_MIGRATION_APPROVAL_PUBLIC_KEY: "public-key",
    AICHM_SUPABASE_LEGACY_IMPORT_TARGET: "production",
    NODE_ENV: "production",
  }));
});
