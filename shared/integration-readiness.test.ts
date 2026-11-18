import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMetaDiagnosticToChecklist,
  applySupabaseReaderDiagnosticToChecklist,
  buildIntegrationReadinessChecklist,
  type IntegrationReadinessInput,
} from "./integration-readiness";

const base: IntegrationReadinessInput = {
  environment: "production",
  crm: {
    runtimeDatabaseVerified: true,
    schemaReady: true,
    schemaSafeCode: "crm_schema_ready",
  },
  avni: {
    operationalSchemaReady: true,
    registrationWebhook: {
      urlValid: true,
      secretPresent: true,
      dispatcherActive: true,
    },
    supabaseReaderConfigured: true,
    supabaseWriterAvailable: false,
    evolutionTransportConfigured: true,
    evolutionMissingConfigurationNames: [],
    hmacKeyringState: "ready",
    followUpReadSecretPresent: true,
    pilotHardDisabled: true,
  },
  meta: {
    missingConfigurationNames: [],
    graphApiVersionValid: true,
  },
};

function find(
  checklist: ReturnType<typeof buildIntegrationReadinessChecklist>,
  area: "crm" | "avni" | "meta",
  id: string,
) {
  const result = checklist[area].checks.find((item) => item.id === id);
  assert.ok(result, `${area}.${id} exists`);
  return result;
}

test("Development configuration and local schema checks never claim Production PASS", () => {
  const checklist = buildIntegrationReadinessChecklist({
    ...base,
    environment: "development",
  });
  assert.equal(checklist.crm.status, "NOT CHECKED");
  assert.equal(find(checklist, "crm", "database-role").status, "NOT CHECKED");
  assert.equal(find(checklist, "crm", "crm-schema").status, "NOT CHECKED");
  assert.equal(find(checklist, "crm", "migration-ledger").status, "NOT CHECKED");
  assert.equal(checklist.meta.status, "NOT CHECKED");
  assert.equal(find(checklist, "meta", "meta-config").status, "NOT CHECKED");
});

test("live CRM role and schema checks pass but the unchecked migration ledger blocks overall readiness", () => {
  const checklist = buildIntegrationReadinessChecklist(base);
  assert.equal(checklist.crm.status, "NOT CHECKED");
  assert.equal(find(checklist, "crm", "database-role").status, "PASS");
  assert.equal(find(checklist, "crm", "crm-schema").status, "PASS");
  assert.equal(find(checklist, "crm", "migration-ledger").status, "NOT CHECKED");
});

test("Production CRM role or schema failures are blocked with actions", () => {
  const roleBlocked = buildIntegrationReadinessChecklist({
    ...base,
    crm: { ...base.crm, runtimeDatabaseVerified: false },
  });
  assert.equal(find(roleBlocked, "crm", "database-role").status, "BLOCKED");
  assert.match(find(roleBlocked, "crm", "database-role").requiredActions.join(" "), /AICHM_APP_DATABASE_URL/);

  const schemaBlocked = buildIntegrationReadinessChecklist({
    ...base,
    crm: { ...base.crm, schemaReady: false, schemaSafeCode: "crm_schema_or_assignment_migration_required" },
  });
  assert.equal(find(schemaBlocked, "crm", "crm-schema").status, "BLOCKED");
  assert.match(find(schemaBlocked, "crm", "crm-schema").detail, /crm_schema_or_assignment_migration_required/);
});

test("configuration presence, valid HMAC parsing, and source gates do not make AVNI ready", () => {
  const checklist = buildIntegrationReadinessChecklist(base);
  assert.equal(checklist.avni.status, "BLOCKED");
  assert.equal(find(checklist, "avni", "hmac-keyring").status, "NOT CHECKED");
  assert.equal(find(checklist, "avni", "vsl-registration").status, "NOT CHECKED");
  assert.equal(find(checklist, "avni", "supabase-writer").status, "BLOCKED");
  assert.equal(find(checklist, "avni", "evolution-transport").status, "NOT CHECKED");
  assert.equal(find(checklist, "avni", "pilot-dispatch").status, "BLOCKED");
  assert.match(find(checklist, "avni", "pilot-dispatch").detail, /kill switch/);
  assert.equal(find(checklist, "avni", "n8n-campaigns").status, "NOT CHECKED");
});

test("an unexpectedly open dispatch gate is still BLOCKED and calls for a source review", () => {
  const checklist = buildIntegrationReadinessChecklist({
    ...base,
    avni: { ...base.avni, pilotHardDisabled: false },
  });
  const pilot = find(checklist, "avni", "pilot-dispatch");
  assert.equal(pilot.status, "BLOCKED");
  assert.match(pilot.detail, /not confirmed/);
});

test("AVNI missing runtime prerequisites are explicit and never inferred from secret presence", () => {
  const checklist = buildIntegrationReadinessChecklist({
    ...base,
    avni: {
      ...base.avni,
      registrationWebhook: { urlValid: false, secretPresent: false, dispatcherActive: false },
      supabaseReaderConfigured: false,
      evolutionTransportConfigured: false,
      evolutionMissingConfigurationNames: ["EVOLUTION_API_KEY", "EVOLUTION_API_INSTANCE"],
      hmacKeyringState: "missing",
      followUpReadSecretPresent: false,
    },
  });
  const registration = find(checklist, "avni", "vsl-registration");
  assert.equal(registration.status, "BLOCKED");
  assert.match(registration.requiredActions.join(" "), /N8N_VSL_REGISTRATION_WEBHOOK_URL/);
  assert.match(registration.requiredActions.join(" "), /N8N_VSL_REGISTRATION_WEBHOOK_SECRET/);
  assert.equal(find(checklist, "avni", "supabase-reader").status, "BLOCKED");
  const evolution = find(checklist, "avni", "evolution-transport");
  assert.equal(evolution.status, "BLOCKED");
  assert.match(evolution.detail, /EVOLUTION_API_KEY, EVOLUTION_API_INSTANCE/);
  assert.equal(find(checklist, "avni", "hmac-keyring").status, "BLOCKED");
  assert.match(find(checklist, "avni", "hmac-keyring").requiredActions.join(" "), /AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_JSON/);
  assert.equal(find(checklist, "avni", "follow-up-read").status, "BLOCKED");
  assert.match(find(checklist, "avni", "follow-up-read").requiredActions.join(" "), /N8N_AVNI_FOLLOWUP_READ_SECRET/);
});

test("Meta config presence and source tests leave Page and lead permissions NOT CHECKED", () => {
  const checklist = buildIntegrationReadinessChecklist(base);
  assert.equal(checklist.meta.status, "NOT CHECKED");
  assert.equal(find(checklist, "meta", "meta-config").status, "NOT CHECKED");
  assert.equal(find(checklist, "meta", "meta-page").status, "NOT CHECKED");
  assert.equal(find(checklist, "meta", "meta-subscription").status, "NOT CHECKED");
  assert.equal(find(checklist, "meta", "meta-forms").status, "NOT CHECKED");
  assert.equal(find(checklist, "meta", "meta-lead-retrieval").status, "NOT CHECKED");
  assert.match(find(checklist, "meta", "meta-lead-retrieval").detail, /does not call any form \/leads edge/);
});

test("Meta configuration failures list exact missing names without values", () => {
  const checklist = buildIntegrationReadinessChecklist({
    ...base,
    meta: {
      missingConfigurationNames: ["META_PAGE_ACCESS_TOKEN", "META_PAGE_ID"],
      graphApiVersionValid: false,
    },
  });
  const config = find(checklist, "meta", "meta-config");
  assert.equal(config.status, "BLOCKED");
  assert.deepEqual(config.requiredActions, [
    "Configure META_PAGE_ACCESS_TOKEN in Production secrets.",
    "Configure META_PAGE_ID in Production secrets.",
    "Set META_GRAPH_API_VERSION to the supported vN.N format.",
  ]);
});

test("Meta diagnostic marks only verified reads and keeps lead retrieval NOT CHECKED", () => {
  const initial = buildIntegrationReadinessChecklist(base);
  const checked = applyMetaDiagnosticToChecklist(initial, {
    pageIdentityChecked: true,
    pageIdentityMatches: true,
    subscriptionChecked: true,
    appInstalled: true,
    leadgenSubscribed: true,
    formAccessChecked: true,
    formAccessGranted: true,
    hasAccessibleForm: true,
  });
  assert.equal(find(checked, "meta", "meta-page").status, "PASS");
  assert.equal(find(checked, "meta", "meta-subscription").status, "PASS");
  assert.equal(find(checked, "meta", "meta-forms").status, "PASS");
  assert.equal(find(checked, "meta", "meta-api-access").status, "PASS");
  assert.equal(find(checked, "meta", "meta-lead-retrieval").status, "NOT CHECKED");
  assert.equal(checked.meta.status, "NOT CHECKED");
});

test("Meta mismatch and permission failures become BLOCKED with safe actions", () => {
  const initial = buildIntegrationReadinessChecklist(base);
  const mismatch = applyMetaDiagnosticToChecklist(initial, {
    pageIdentityChecked: true,
    pageIdentityMatches: false,
    subscriptionChecked: false,
    appInstalled: false,
    leadgenSubscribed: false,
    formAccessChecked: false,
    formAccessGranted: false,
    hasAccessibleForm: false,
    errorCategory: "page_identity_mismatch",
  });
  assert.equal(find(mismatch, "meta", "meta-page").status, "BLOCKED");
  assert.equal(find(mismatch, "meta", "meta-api-access").status, "BLOCKED");
  assert.equal(mismatch.meta.status, "BLOCKED");
  assert.doesNotMatch(JSON.stringify(mismatch), /access_token|lead_id|form_id|raw payload/i);
});

test("Meta safe configuration failure overrides presence-only NOT CHECKED status", () => {
  const checklist = applyMetaDiagnosticToChecklist(buildIntegrationReadinessChecklist(base), {
    pageIdentityChecked: false,
    pageIdentityMatches: false,
    subscriptionChecked: false,
    appInstalled: false,
    leadgenSubscribed: false,
    formAccessChecked: false,
    formAccessGranted: false,
    hasAccessibleForm: false,
    errorCategory: "invalid_configuration",
  });
  assert.equal(find(checklist, "meta", "meta-config").status, "BLOCKED");
  assert.equal(checklist.meta.status, "BLOCKED");
});

test("read-only Supabase diagnostic changes only the reader check, not writer readiness", () => {
  const initial = buildIntegrationReadinessChecklist(base);
  const checked = applySupabaseReaderDiagnosticToChecklist(initial, {
    tls: true,
    role: true,
    catalog: true,
    syntheticLookup: true,
  });
  assert.equal(find(checked, "avni", "supabase-reader").status, "PASS");
  assert.equal(find(checked, "avni", "supabase-writer").status, "BLOCKED");
  assert.equal(checked.avni.status, "BLOCKED");
});
