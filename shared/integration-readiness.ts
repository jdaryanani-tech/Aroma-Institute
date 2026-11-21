export type ReadinessStatus = "PASS" | "BLOCKED" | "NOT CHECKED";

export type ReadinessCheck = {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  requiredActions: string[];
};

export type ReadinessArea = {
  status: ReadinessStatus;
  checks: ReadinessCheck[];
};

export type IntegrationReadinessChecklist = {
  environment: string;
  crm: ReadinessArea;
  avni: ReadinessArea;
  meta: ReadinessArea;
};

export type IntegrationReadinessInput = {
  environment: string;
  crm: {
    runtimeDatabaseVerified: boolean;
    schemaReady: boolean;
    schemaSafeCode: string;
  };
  avni: {
    operationalSchemaReady: boolean;
    registrationWebhook: {
      urlValid: boolean;
      secretPresent: boolean;
      dispatcherActive: boolean;
    };
    supabaseReaderConfigured: boolean;
    supabaseWriterAvailable: boolean;
    evolutionTransportConfigured: boolean;
    evolutionMissingConfigurationNames: string[];
    hmacKeyringState: "missing" | "invalid" | "ready";
    followUpReadSecretPresent: boolean;
    pilotHardDisabled: boolean;
  };
  meta: {
    missingConfigurationNames: string[];
    graphApiVersionValid: boolean;
  };
};

export type MetaDiagnosticSummary = {
  pageIdentityChecked: boolean;
  pageIdentityMatches: boolean;
  subscriptionChecked: boolean;
  appInstalled: boolean;
  leadgenSubscribed: boolean;
  formAccessChecked: boolean;
  formAccessGranted: boolean;
  hasAccessibleForm: boolean;
  configuredPageStatus?: "missing" | "approved" | "mismatch";
  configuredPageIsAichmPage?: boolean;
  tokenDebugChecked?: boolean;
  tokenValid?: boolean;
  tokenTypeIsPage?: boolean;
  tokenBelongsToConfiguredApp?: boolean;
  tokenExpiryStatus?: "not_checked" | "valid" | "expired" | "never_expires" | "unknown";
  tokenExpiresAt?: string | null;
  dataAccessExpiryStatus?: "not_checked" | "valid" | "expired" | "never_expires" | "unknown";
  dataAccessExpiresAt?: string | null;
  permissionsChecked?: boolean;
  leadRetrievalPermission?: boolean;
  pageSubscriptionPermission?: boolean;
  approvedFormAllowlistStatus?: "missing" | "empty" | "invalid" | "configured";
  approvedFormCount?: number;
  formCheckStatus?: "not_checked" | "complete" | "incomplete" | "failed";
  accessibleApprovedFormCount?: number;
  inaccessibleApprovedFormCount?: number | null;
  allApprovedFormsAccessible?: boolean | null;
  safeCode?: string | null;
  errorCategory?: string;
};

const NOT_PRODUCTION = "Production was not checked from this runtime.";

function check(
  id: string,
  label: string,
  status: ReadinessStatus,
  detail: string,
  requiredActions: string[] = [],
): ReadinessCheck {
  return { id, label, status, detail, requiredActions };
}

function area(checks: ReadinessCheck[]): ReadinessArea {
  const status: ReadinessStatus = checks.some((item) => item.status === "BLOCKED")
    ? "BLOCKED"
    : checks.some((item) => item.status === "NOT CHECKED")
      ? "NOT CHECKED"
      : "PASS";
  return { status, checks };
}

function productionState(
  environment: string,
  passed: boolean,
  id: string,
  label: string,
  positiveDetail: string,
  blockedDetail: string,
  requiredActions: string[],
): ReadinessCheck {
  if (environment !== "production") {
    return check(id, label, "NOT CHECKED", NOT_PRODUCTION, requiredActions);
  }
  return passed
    ? check(id, label, "PASS", positiveDetail)
    : check(id, label, "BLOCKED", blockedDetail, requiredActions);
}

export function buildIntegrationReadinessChecklist(
  input: IntegrationReadinessInput,
): IntegrationReadinessChecklist {
  const inProduction = input.environment === "production";
  const crm = area([
    productionState(
      input.environment,
      input.crm.runtimeDatabaseVerified,
      "database-role",
      "Production database role",
      "The running Production process passed the least-privilege database startup verification.",
      "The Production database role has not passed the runtime verification gate.",
      [
        "Configure AICHM_APP_DATABASE_URL with a distinct least-privilege login on the expected internal database.",
        "Verify role membership, database privileges, primary/read-write status, and CRM startup checks.",
      ],
    ),
    productionState(
      input.environment,
      input.crm.schemaReady,
      "crm-schema",
      "CRM schema and assignments",
      "CRM persistence, identity, and canonical assignment checks passed on the Production connection.",
      `Production CRM schema check failed (${input.crm.schemaSafeCode}).`,
      [
        "Run the approved read-only Production catalog and migration-ledger preflight.",
        "Reconcile Migration 0013 and the 50-source/34-target scope first; only then review 0014_crm_canonical_assignments → 0015_crm_assignment_audit_invariants → 0016_crm_runtime_role_separation → 0017_meta_lead_ads_schema → 0018_meta_phone_identity_diagnostics.",
      ],
    ),
    check(
      "migration-ledger",
      "CRM migration ledger and table scope",
      "NOT CHECKED",
      "This endpoint checks operational CRM objects, but does not reconcile the migration ledger, Migration 0013, or the historical 50-source/34-target table scope.",
      [
        "Run the approved read-only primary/catalog/ledger preflight.",
        "Resolve the 50-versus-34 table inventory and Migration 0013 disposition before any DDL or data-copy decision.",
      ],
    ),
  ]);

  const registration = input.avni.registrationWebhook;
  const avniChecks = [
    productionState(
      input.environment,
      input.avni.operationalSchemaReady,
      "avni-schema",
      "Replit admissions integration schema",
      "The admissions integration schema check passed on the Production connection.",
      "The admissions integration schema check failed on the Production connection.",
      [
        "Run the read-only Replit schema and ledger preflight.",
        "Resolve the base ledger first; review CRM forward migrations 0014–0018, then manual AVNI 0019_avni_dispatch_grants.sql → 0020_avni_dispatch_authorization_fence.sql. Never apply 0019 alone.",
      ],
    ),
    check(
      "avni-replit-migrations",
      "Replit AVNI migration state",
      "NOT CHECKED",
      "The readiness endpoint does not verify the Replit migration ledger for drafts 0019 and 0020.",
      [
        "Reconcile migrations 0000–0018 and the manual forward ledger first.",
        "Review 0019 then 0020 and verify exact primary/catalog postconditions; never apply 0019 alone.",
      ],
    ),
    !inProduction
      ? check("vsl-registration", "VSL registration webhook", "NOT CHECKED", NOT_PRODUCTION, [
          "Verify the Production N8N_VSL_REGISTRATION_WEBHOOK_URL and shared webhook credential through the secret-presence flow.",
          "Review the n8n receiver and explicit acknowledgement contract without sending a student event.",
        ])
      : !registration.urlValid || !registration.secretPresent
        ? check(
            "vsl-registration",
            "VSL registration webhook",
            "BLOCKED",
            "The URL or shared webhook credential is missing or invalid.",
            [
              ...(!registration.urlValid ? ["Configure a trusted HTTPS N8N_VSL_REGISTRATION_WEBHOOK_URL."] : []),
              ...(!registration.secretPresent ? ["Configure the existing server-only N8N_VSL_REGISTRATION_WEBHOOK_SECRET."] : []),
            ],
          )
        : !registration.dispatcherActive
          ? check(
              "vsl-registration",
              "VSL registration webhook",
              "BLOCKED",
              "Configuration is present, but the server dispatcher is not active.",
              ["Keep it disabled unless the owner separately approves the receiver and delivery contract."],
            )
          : check(
              "vsl-registration",
              "VSL registration webhook",
              "NOT CHECKED",
              "Configuration and the dispatch gate are present; receiver behavior and acknowledgement have not been verified.",
              ["Verify the n8n receiver and acknowledgement contract without sending student data."],
            ),
    !inProduction
      ? check("supabase-reader", "Supabase conversation reader", "NOT CHECKED", NOT_PRODUCTION, [
          "Run the admin-only read-only reader preflight against the intended Production Supabase project.",
        ])
      : !input.avni.supabaseReaderConfigured
        ? check(
            "supabase-reader",
            "Supabase conversation reader",
            "BLOCKED",
            "The dedicated read-only Supabase URL or TLS CA is unavailable.",
            ["Configure SUPABASE_AVNI_READONLY_DATABASE_URL and SUPABASE_DB_SSL_CA."],
          )
        : check(
            "supabase-reader",
            "Supabase conversation reader",
            "NOT CHECKED",
            "Reader configuration is present; live catalog, role, TLS, and RPC checks have not been run.",
            ["Run the admin-only read-only Supabase reader preflight."],
          ),
    check(
      "supabase-runtime-migrations",
      "Supabase conversation migration state",
      "NOT CHECKED",
      "The reader diagnostic does not establish whether the runtime/writer migration sequence is applied to the intended primary.",
      [
        "Confirm the exact Supabase primary and migration ledger with read-only evidence.",
        "Review supabase/migrations/20261118_avni_conversation_runtime_v1.sql → 20261118_avni_conversation_runtime_v2_preflight.sql → 20261118_avni_human_pilot_dispatch_v3.sql; v3 requires separate owner approval.",
      ],
    ),
    check(
      "supabase-writer",
      "Supabase conversation writer",
      input.avni.supabaseWriterAvailable ? "NOT CHECKED" : "BLOCKED",
      input.avni.supabaseWriterAvailable
        ? "A writer adapter is reported, but its live role and migration postconditions are not verified."
        : "No trusted Supabase runtime writer is connected.",
      [
        "Review the exact Supabase files in order: 20261118_avni_conversation_runtime_v1.sql → 20261118_avni_conversation_runtime_v2_preflight.sql → 20261118_avni_human_pilot_dispatch_v3.sql; v3 requires separate owner approval.",
        "Provision and verify the dedicated least-privilege writer role and fixed RPC boundary; do not use service_role.",
      ],
    ),
    !inProduction
      ? check("evolution-transport", "Evolution transport", "NOT CHECKED", NOT_PRODUCTION, [
          "Verify Production EVOLUTION_API_KEY and EVOLUTION_API_INSTANCE through the approved secret-presence flow.",
        ])
      : !input.avni.evolutionTransportConfigured
        ? check(
            "evolution-transport",
            "Evolution transport",
            "BLOCKED",
            input.avni.evolutionMissingConfigurationNames.length > 0
              ? `Missing server-side settings: ${input.avni.evolutionMissingConfigurationNames.join(", ")}.`
              : "The Evolution settings are present but do not pass strict format validation.",
            [
              ...input.avni.evolutionMissingConfigurationNames.map((name) => `Configure ${name} in Production secrets.`),
              ...(input.avni.evolutionMissingConfigurationNames.length === 0
                ? ["Review the formats of EVOLUTION_API_KEY and EVOLUTION_API_INSTANCE through the secret-presence/format flow; never display values."]
                : []),
              "Verify the deployed Evolution version, endpoint, authentication, and idempotency contract without sending a message.",
            ],
          )
        : check(
            "evolution-transport",
            "Evolution transport",
            "NOT CHECKED",
            "Configuration is present, but the deployed provider contract and reachability have not been verified.",
            ["Review the installed Evolution version and documented acceptance/unknown-outcome behavior; this checklist makes no provider request."],
          ),
    !inProduction
      ? check("hmac-keyring", "Provider-reference HMAC key ring", "NOT CHECKED", NOT_PRODUCTION, [
          "Provision the approved key ring in Production secrets and review key custody and rotation.",
        ])
      : input.avni.hmacKeyringState !== "ready"
        ? check(
            "hmac-keyring",
            "Provider-reference HMAC key ring",
            "BLOCKED",
            input.avni.hmacKeyringState === "missing"
              ? "The server-only key ring is missing."
              : "The server-only key ring failed strict configuration validation.",
            ["Provision a random key ring through the approved secret-management flow using AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_JSON."],
          )
        : check(
            "hmac-keyring",
            "Provider-reference HMAC key ring",
            "NOT CHECKED",
            "The key ring parses, but key custody, rotation retention, and owner approval are not independently verified.",
            ["Review key provenance and retain prior key IDs for alias lookup before rotation."],
          ),
    !inProduction
      ? check("follow-up-read", "AVNI due-candidate read", "NOT CHECKED", NOT_PRODUCTION, [
          "Verify the dedicated Production read credential and route behavior without triggering messaging.",
        ])
      : !input.avni.followUpReadSecretPresent
        ? check(
            "follow-up-read",
            "AVNI due-candidate read",
            "BLOCKED",
            "The dedicated read-only service credential is not configured.",
            ["Configure N8N_AVNI_FOLLOWUP_READ_SECRET separately from broad n8n credentials."],
          )
        : check(
            "follow-up-read",
            "AVNI due-candidate read",
            "NOT CHECKED",
            "The dedicated credential name is present; an authenticated read-only request has not been verified.",
            ["Verify the bounded candidate route using the approved read-only n8n credential; do not enable sends."],
          ),
    check(
      "pilot-dispatch",
      "Single-recipient pilot dispatch",
      "BLOCKED",
      input.avni.pilotHardDisabled
        ? "The source-level dispatch kill switch is active; no send can be authorized."
        : "The hard-disable state is not confirmed; the dispatcher must remain blocked pending review.",
      [
        "Keep the source and environment gates closed until schema, roles, writer, HMAC custody, provider contract, recipient, message, and in-flight policy receive separate approval.",
      ],
    ),
    check(
      "n8n-campaigns",
      "n8n campaign and follow-up state",
      "NOT CHECKED",
      "The external n8n workflow schedule and activation state are not inspected by this application.",
      ["Verify schedules are paused and obtain separate approval before enabling any campaign or follow-up workflow."],
    ),
  ];
  const avni = area(avniChecks);

  const metaConfigurationBlocked =
    input.meta.missingConfigurationNames.length > 0 || !input.meta.graphApiVersionValid;
  const meta = area([
    !inProduction
      ? check("meta-config", "Meta server configuration", "NOT CHECKED", NOT_PRODUCTION, [
          "Verify Production secret names and Graph version format through the approved presence-only process.",
        ])
      : metaConfigurationBlocked
        ? check(
            "meta-config",
            "Meta server configuration",
            "BLOCKED",
            "Required Meta configuration is missing or the Graph version format is invalid.",
            [
              ...input.meta.missingConfigurationNames.map((name) => `Configure ${name} in Production secrets.`),
              ...(!input.meta.graphApiVersionValid ? ["Set META_GRAPH_API_VERSION to the supported vN.N format."] : []),
            ],
          )
        : check(
            "meta-config",
            "Meta server configuration",
            "NOT CHECKED",
            "Configuration names and version format are present; token validity and Page permissions are not verified.",
            ["Run the admin-only read-only Meta Page diagnostic after authorizing its Graph GET requests."],
          ),
    check("meta-page", "Page token identity", "NOT CHECKED", "No live Graph identity check has been run.", [
      "Verify the Page-scoped token resolves to the configured Page without exposing the token or Page ID.",
    ]),
    check("meta-api-access", "Meta Graph API access", "NOT CHECKED", "No live Graph request has been run.", [
      "Run the admin-only diagnostic and resolve any safe authentication, permission, rate-limit, or network category.",
    ]),
    check("meta-subscription", "App leadgen subscription", "NOT CHECKED", "No live Page subscription check has been run.", [
      "Confirm the app is subscribed to leadgen; do not change subscriptions from this readiness checklist.",
    ]),
    check("meta-forms", "Page form enumeration", "NOT CHECKED", "No live form-access check has been run.", [
      "Confirm the Page can enumerate its forms; this does not prove access to retrieve leads from them.",
    ]),
    check(
      "meta-lead-retrieval",
      "Lead retrieval permission",
      "NOT CHECKED",
      "The diagnostic does not call any form /leads edge and cannot verify leads_retrieval.",
      ["Confirm leads_retrieval and lead access for each required form through the authorized Meta controls; do not fetch applicant data as a readiness check."],
    ),
    check(
      "meta-webhook",
      "Production webhook delivery",
      "NOT CHECKED",
      "No Production request logs or persisted lead records were inspected.",
      ["Use sanitized Production request telemetry to verify a delivery; do not create or replay a lead for this check."],
    ),
  ]);

  return { environment: input.environment || "unknown", crm, avni, meta };
}

const definitiveMetaFailures = new Set([
  "page_identity_mismatch",
  "permission_denied",
  "authentication_rejected",
  "missing_configuration",
  "invalid_configuration",
  "request_rejected",
]);

export function applyMetaDiagnosticToChecklist(
  checklist: IntegrationReadinessChecklist,
  diagnostic: MetaDiagnosticSummary,
): IntegrationReadinessChecklist {
  const checks = checklist.meta.checks.map((item): ReadinessCheck => {
    if (item.id === "meta-page" && diagnostic.configuredPageStatus) {
      const tokenExpiryPassed =
        diagnostic.tokenExpiryStatus === "valid" ||
        diagnostic.tokenExpiryStatus === "never_expires";
      const dataExpiryPassed =
        diagnostic.dataAccessExpiryStatus === "valid" ||
        diagnostic.dataAccessExpiryStatus === "never_expires";
      const passed = diagnostic.configuredPageStatus === "approved" &&
        diagnostic.configuredPageIsAichmPage === true &&
        diagnostic.tokenDebugChecked === true &&
        diagnostic.tokenValid === true &&
        diagnostic.tokenTypeIsPage === true &&
        diagnostic.tokenBelongsToConfiguredApp === true &&
        tokenExpiryPassed && dataExpiryPassed &&
        diagnostic.pageIdentityChecked && diagnostic.pageIdentityMatches;
      return passed
        ? check(item.id, item.label, "PASS", "The configured Page, app-bound token, Page identity, and expiry checks passed.")
        : check(item.id, item.label, "BLOCKED", "The configured Page or Page-token identity, app, validity, or expiry check failed.", [
            "Use a valid Page-scoped token for the approved AICHM Page and configured Meta app.",
          ]);
    }
    if (item.id === "meta-api-access" && diagnostic.permissionsChecked !== undefined) {
      const passed = diagnostic.tokenDebugChecked === true &&
        diagnostic.tokenValid === true &&
        diagnostic.tokenTypeIsPage === true &&
        diagnostic.tokenBelongsToConfiguredApp === true &&
        diagnostic.leadRetrievalPermission === true &&
        diagnostic.pageSubscriptionPermission === true;
      return passed
        ? check(item.id, item.label, "PASS", "The token has the required Lead Ads retrieval and Page-subscription permissions.")
        : check(item.id, item.label, "BLOCKED", "The Page token does not have all required permissions or could not be verified.", [
            "Grant the required Meta permissions to the configured app and Page token.",
          ]);
    }
    if (item.id === "meta-config" && diagnostic.errorCategory &&
      ["missing_configuration", "invalid_configuration"].includes(diagnostic.errorCategory)) {
      return check(item.id, item.label, "BLOCKED", `Meta configuration failed the safe check (${diagnostic.errorCategory}).`, [
        "Correct the named Production setting through the approved secret/configuration flow; never display its value.",
      ]);
    }
    if (item.id === "meta-page" && diagnostic.pageIdentityChecked) {
      return diagnostic.pageIdentityMatches
        ? check(item.id, item.label, "PASS", "The Page-scoped token identity matches the configured Page.")
        : check(item.id, item.label, "BLOCKED", "The token identity does not match the configured Page.", [
            "Use a Page-scoped token issued for the configured Page and app.",
          ]);
    }
    if (item.id === "meta-subscription" && diagnostic.subscriptionChecked) {
      return diagnostic.appInstalled && diagnostic.leadgenSubscribed
        ? check(item.id, item.label, "PASS", "The app is installed and leadgen is subscribed.")
        : check(item.id, item.label, "BLOCKED", "The app installation or leadgen subscription check failed.", [
            "Resolve the Page/app subscription through the authorized Meta workflow; do not alter it from this diagnostic.",
          ]);
    }
    if (item.id === "meta-forms" && diagnostic.formAccessChecked) {
      if (diagnostic.approvedFormAllowlistStatus === undefined) {
        return diagnostic.formAccessGranted && diagnostic.hasAccessibleForm
          ? check(item.id, item.label, "PASS", "The Page form-list endpoint returned at least one accessible form.")
          : check(item.id, item.label, "BLOCKED", "The Page form-list endpoint did not confirm an accessible form.", [
              "Confirm Page role, lead access, and form visibility in Meta controls.",
            ]);
      }
      if (diagnostic.approvedFormAllowlistStatus !== "configured" ||
          diagnostic.allApprovedFormsAccessible !== true) {
        return check(item.id, item.label, "BLOCKED", "The approved-form allowlist is missing or at least one approved form was not verified accessible.", [
          "Verify and configure only the owner-approved AICHM form IDs, then confirm Page access in Meta controls.",
        ]);
      }
      return check(item.id, item.label, "PASS", "Every configured approved form was found in the Page's accessible form list.");
    }
    if (item.id === "meta-lead-retrieval" && diagnostic.permissionsChecked !== undefined) {
      return diagnostic.leadRetrievalPermission
        ? check(item.id, item.label, "PASS", "The Page token's Lead Ads retrieval permission was verified.")
        : check(item.id, item.label, "BLOCKED", "The Page token's Lead Ads retrieval permission is missing or unverified.", [
            "Grant leads_retrieval and approved lead access without retrieving applicant data for this check.",
          ]);
    }
    if (item.id === "meta-api-access" && diagnostic.errorCategory &&
      definitiveMetaFailures.has(diagnostic.errorCategory)) {
      return check(item.id, item.label, "BLOCKED", `Meta returned the safe category ${diagnostic.errorCategory}.`, [
        "Resolve the Page-token or permission issue, then rerun the read-only diagnostic.",
      ]);
    }
    if (item.id === "meta-api-access" && !diagnostic.errorCategory &&
      diagnostic.pageIdentityChecked && diagnostic.subscriptionChecked &&
      diagnostic.formAccessChecked && diagnostic.formAccessGranted) {
      return check(item.id, item.label, "PASS", "The Page identity, app-subscription, and form-list Graph reads completed.");
    }
    return item;
  });
  return { ...checklist, meta: area(checks) };
}

export function applySupabaseReaderDiagnosticToChecklist(
  checklist: IntegrationReadinessChecklist,
  checks: Record<string, boolean>,
): IntegrationReadinessChecklist {
  const allPassed = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  const readerCheck = check(
    "supabase-reader",
    "Supabase conversation reader",
    allPassed ? "PASS" : "BLOCKED",
    allPassed
      ? "The restricted reader passed the read-only catalog, role, TLS, and synthetic empty-lookup checks."
      : "One or more read-only Supabase reader checks failed.",
    allPassed ? [] : ["Review the failed safe boolean checks; do not use a writer or service_role credential."],
  );
  const updated = checklist.avni.checks.map((item) =>
    item.id === "supabase-reader" ? readerCheck : item,
  );
  return { ...checklist, avni: area(updated) };
}
