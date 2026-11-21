import type { Express, RequestHandler } from "express";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { admissionsCaptureLimits } from "@shared/admissions-schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { applicationRuntimeMode, db, pool } from "../db";
import {
  inspectApplicationDatabaseEndpointPolicy,
  inspectApplicationDatabaseStartupPreflight,
} from "../db/application-runtime-connection";
import { upsertIntegrationLead } from "../admissions/identity";
import {
  admissionsIntegrationSchemaReady,
  readLeadFollowUpByPhone,
  readLeadFollowUpStatus,
  recordWhatsAppOptOut,
} from "../admissions/follow-up";
import {
  VSL_DISPATCH_ENABLED_ENV,
  VSL_WEBHOOK_URL_ENV,
  isTrustedVslWebhookUrl,
  isVslDispatchEnabled,
} from "../admissions/outbox-dispatcher";
import { crmModelSql, inspectCrmSchema, iso } from "../crm/model";
import { requireLmsRole, requireLmsUser } from "../lms/auth";
import {
  isSupabaseAvniReadConfigured,
  readSupabasePilotOutboundStatus,
  runSupabaseAvniReadDiagnostics,
} from "../db/supabase-avni-readonly";
import { createAvniDiagnosticsHandler } from "./avni-diagnostics";
import { registerAvniProductionDiagnosticsRoute } from "./avni-production-diagnostics";
import { registerAdminIntegrationReadinessRoute } from "./admin-integration-readiness";
import { createDatabasePilotGrantEngine } from "./avni-pilot-grant-engine";
import {
  AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV,
  readAvniHmacKeyringConfig,
} from "./avni-provider-reference-hmac-config";
import { registerAvniCrmFollowUpRoutes } from "../crm/avni-follow-up-routes";
import {
  AVNI_PILOT_DISPATCH_GATE_ENV,
  AVNI_PILOT_RECIPIENT_ENV,
  registerAvniPilotDispatchRoute,
} from "./avni-pilot-dispatch-route";
import {
  createAvniPilotStatusReader,
  createAvniSingleRecipientPilotDispatcher,
} from "./avni-single-recipient-pilot";
import {
  createEvolutionPilotHttpClient,
  createEvolutionPilotTransport,
  EVOLUTION_API_INSTANCE_ENV,
  EVOLUTION_API_KEY_ENV,
} from "./evolution-pilot-transport";
import {
  AVNI_FOLLOWUP_READ_SECRET_ENV,
  avniReadCredentialIsDedicated,
  createAvniFollowUpReadAuth,
} from "../crm/avni-follow-up-read-auth";
import {
  N8N_INTEGRATION_SECRET_ENV, N8N_INTEGRATION_SECRET_HEADER, verifyN8nIntegrationSecret,
} from "./n8n-auth";
import { getMetaReadiness } from "../meta/config";
import { buildIntegrationReadinessChecklist } from "@shared/integration-readiness";

export const N8N_VSL_SECRET_ENV = N8N_INTEGRATION_SECRET_ENV;
export const N8N_VSL_SECRET_HEADER = N8N_INTEGRATION_SECRET_HEADER;
const canonicalPhone = z.string().trim().max(32).refine(
  (value) => normalizeIndianMobile(value) !== null,
  "A valid Indian mobile number is required.",
);

export function verifyAvniIntegrationSecret(supplied: string, expected: string | undefined) {
  return verifyN8nIntegrationSecret(supplied, expected);
}

export const avniIntegrationAuth: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Vary", N8N_VSL_SECRET_HEADER);
  const expected = process.env[N8N_VSL_SECRET_ENV];
  if (!expected?.trim()) return void res.status(503).json({ message: "AVNI integration is not configured." });
  if (process.env[AVNI_FOLLOWUP_READ_SECRET_ENV]?.trim()
    && !avniReadCredentialIsDedicated(
      process.env[AVNI_FOLLOWUP_READ_SECRET_ENV],
      expected,
    )) {
    return void res.status(503).json({ message: "AVNI integration credentials are not separated." });
  }
  if (!verifyAvniIntegrationSecret(req.get(N8N_VSL_SECRET_HEADER) ?? "", expected)) {
    return void res.status(401).json({ message: "Integration authentication required." });
  }
  try {
    const key = createHash("sha256").update(`avni:${req.ip ?? "unknown"}`).digest("hex");
    const now = new Date();
    const cutoff = new Date(now.getTime() - 60_000);
    const [bucket] = await db.insert(admissionsCaptureLimits).values({
      keyHash: key, windowStartedAt: now, attempts: 1,
    }).onConflictDoUpdate({
      target: admissionsCaptureLimits.keyHash,
      set: {
        windowStartedAt: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN ${now} ELSE ${admissionsCaptureLimits.windowStartedAt} END`,
        attempts: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN 1 ELSE LEAST(${admissionsCaptureLimits.attempts}+1,121) END`,
      },
    }).returning({ attempts: admissionsCaptureLimits.attempts });
    if (bucket.attempts > 120) {
      res.setHeader("Retry-After", "60");
      return void res.status(429).json({ message: "Too many integration requests." });
    }
    return next();
  } catch {
    return void res.status(503).json({ message: "AVNI integration is temporarily unavailable." });
  }
};

type AvniCrmFollowUpSnapshot = {
  stage: string;
  expectedVersion: number;
  followUpAt: string | null;
  followUpDue: boolean;
};

export function registerAvniLeadUpsertRoute(
  app: Express,
  dependencies: {
    authenticate: RequestHandler;
    schemaReady: () => Promise<boolean>;
    upsertLead: typeof upsertIntegrationLead;
    readLeadJourney: typeof readLeadFollowUpByPhone;
    readCrmFollowUpState: (leadId: string) => Promise<AvniCrmFollowUpSnapshot | null>;
  },
) {
  app.post("/api/integrations/n8n/leads/upsert", dependencies.authenticate, async (req, res) => {
    const parsed = z.object({
      phone: canonicalPhone,
      name: z.string().trim().min(2).max(120),
      source: z.string().trim().min(1).max(80).default("avni_whatsapp"),
      programInterest: z.string().trim().min(1).max(200).default("Professional Barista Executive Program"),
    }).strict().safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ message: "A valid phone and name are required." });
    try {
      if (!await dependencies.schemaReady()) {
        return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      }
      const result = await dependencies.upsertLead(parsed.data);
      const journey = await dependencies.readLeadJourney(result.canonicalPhone);
      const crm = await dependencies.readCrmFollowUpState(result.lead.id);
      if (!crm) return void res.status(503).json({ message: "CRM follow-up state is unavailable." });
      return void res.status(result.inquiryCreated ? 201 : 200).json({
        leadId: result.lead.id,
        inquiryId: result.inquiryId,
        inquiryCreated: result.inquiryCreated,
        crm,
        registeredAt: journey?.registeredAt ?? null,
        video: journey?.video ?? null,
        questionnaire: journey?.questionnaire ? {
          status: journey.questionnaire.status,
          completedAt: journey.questionnaire.completedAt,
        } : null,
      });
    } catch {
      return void res.status(503).json({ message: "Lead could not be saved." });
    }
  });
}

export function registerAvniIntegrationRoutes(
  app: Express,
  options: { runtimeDatabaseVerified?: boolean } = {},
) {
  const runtimeDatabaseVerified = options.runtimeDatabaseVerified === true;

  const schemaReady = () => admissionsIntegrationSchemaReady(db);
  const hmacKeyring = readAvniHmacKeyringConfig();
  const evolutionPilotTransport = createEvolutionPilotTransport(
    createEvolutionPilotHttpClient({
      apiKey: process.env[EVOLUTION_API_KEY_ENV],
      instanceName: process.env[EVOLUTION_API_INSTANCE_ENV],
    }),
  );
  // Keep a second, code-level off switch in addition to the environment gate.
  // The runtime Supabase login/migrations are not approved or verified; no
  // writer is attached, and the one-recipient route cannot begin a send.
  const pilotDispatch = createAvniSingleRecipientPilotDispatcher({
    pool,
    supabaseWriter: null,
    hmacKeyProvider: hmacKeyring.provider,
    transport: evolutionPilotTransport,
    grantEngine: createDatabasePilotGrantEngine(),
    enabled: false,
    approvedRecipientE164: process.env[AVNI_PILOT_RECIPIENT_ENV] ?? null,
  });
  registerAvniPilotDispatchRoute(app, {
    authenticate: requireLmsUser,
    authorizeAdmin: requireLmsRole("admin"),
    enabled: process.env[AVNI_PILOT_DISPATCH_GATE_ENV] === "true",
    approvedRecipientE164: process.env[AVNI_PILOT_RECIPIENT_ENV] ?? null,
    dispatch: pilotDispatch,
    // The existing read-only pool can inspect persisted status after the
    // reviewed RPC migration is present. It never queries Evolution or retries.
    readStatus: createAvniPilotStatusReader({
      readStatus: readSupabasePilotOutboundStatus,
    }),
  });
  registerAvniCrmFollowUpRoutes(
    app,
    avniIntegrationAuth,
    createAvniFollowUpReadAuth(),
    pool,
  );
  registerAvniProductionDiagnosticsRoute(app, {
    pool,
    sessionSecret: process.env.SESSION_SECRET,
    runtimeEnvironment: process.env.NODE_ENV,
    connectionMode: applicationRuntimeMode.kind,
    runtimeDatabaseVerified,
    followUpReadSecretConfigured: Boolean(process.env.N8N_AVNI_FOLLOWUP_READ_SECRET?.trim()),
    followUpReadSecretDistinct: Boolean(
      process.env.N8N_AVNI_FOLLOWUP_READ_SECRET?.trim()
      && (
        !process.env[N8N_INTEGRATION_SECRET_ENV]?.trim()
        || process.env.N8N_AVNI_FOLLOWUP_READ_SECRET.trim()
          !== process.env[N8N_INTEGRATION_SECRET_ENV].trim()
      ),
    ),
    authenticate: requireLmsUser,
    authorizeAdmin: requireLmsRole("admin"),
  });
  const readCrmFollowUpState = async (leadId: string) => {
    const capabilities = await inspectCrmSchema(pool);
    const { rows: [row] } = await pool.query(
      `${crmModelSql(capabilities)}
       SELECT model.stage,model.version,model.follow_up_at
       FROM model WHERE model.lead_id=$1::uuid LIMIT 1`,
      [leadId],
    );
    if (!row) return null;
    const followUpAt = iso(row.follow_up_at);
    return {
      stage: row.stage,
      expectedVersion: Number(row.version),
      followUpAt,
      followUpDue: followUpAt !== null && Date.parse(followUpAt) <= Date.now(),
    };
  };

  app.get("/api/admin/integrations/avni/status", requireLmsUser, requireLmsRole("admin"), async (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const names = [
      "N8N_VSL_REGISTRATION_WEBHOOK_SECRET",
      "N8N_VSL_REGISTRATION_WEBHOOK_URL",
      "N8N_VSL_DISPATCH_ENABLED",
      "AICHM_VAPID_PUBLIC_KEY",
      "AICHM_VAPID_PRIVATE_KEY",
      "SUPABASE_AVNI_READONLY_DATABASE_URL",
      "SUPABASE_AVNI_RUNTIME_DATABASE_URL",
      "SUPABASE_DB_SSL_CA",
      AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV,
      EVOLUTION_API_KEY_ENV,
      EVOLUTION_API_INSTANCE_ENV,
      AVNI_PILOT_DISPATCH_GATE_ENV,
      AVNI_PILOT_RECIPIENT_ENV,
    ];
    const configured = Object.fromEntries(names.map((name) => [name, Boolean(process.env[name]?.trim())]));
    let schemaReady = false, calendarReady = false;
    try {
      schemaReady = await admissionsIntegrationSchemaReady(db);
      calendarReady = (await pool.query(`SELECT
        to_regclass('calendar_events') IS NOT NULL AND
        to_regclass('calendar_event_attendees') IS NOT NULL AND
        to_regclass('calendar_reminder_jobs') IS NOT NULL AND
        to_regclass('calendar_integration_requests') IS NOT NULL AS ready`)).rows[0]?.ready === true;
    } catch { /* report unavailable, never expose driver details */ }
    return void res.json({
      sourceOfTruth: "replit_postgresql",
      applicationDatabase: {
        connectionMode: applicationRuntimeMode.kind,
        leastPrivilegeVerified: runtimeDatabaseVerified,
      },
      configured,
      missing: names.filter((name) => !configured[name]),
      avniSchemaReady: schemaReady,
      calendarSchemaReady: calendarReady,
      reminderRunnerCommandAvailable: true,
      schedulerHookupRequired: true,
      transcriptStore: "supabase",
      supabaseConversationReaderConfigured: isSupabaseAvniReadConfigured(),
      supabaseRuntimeBusinessData: false,
      singleRecipientPilot: {
        routeRegistered: true,
        featureGateRequested: process.env[AVNI_PILOT_DISPATCH_GATE_ENV] === "true",
        dispatchHandlerRegistered: true,
        dispatchHardDisabled: true,
        dispatcherWired: false,
        statusReaderWired: true,
        statusReaderRequiresV3Migration: true,
        providerClientWired: evolutionPilotTransport.configured,
        hmacKeyProviderWired: hmacKeyring.provider !== null,
        hmacKeyringState: hmacKeyring.state,
        supabaseWriterPoolWired: false,
        grantEngineWired: true,
        runtimeMigrationRequired: true,
        productionSendingAvailable: false,
        safeCode: "supabase_runtime_login_and_migrations_unverified_dispatch_disabled",
      },
    });
  });

  app.get("/api/admin/integrations/avni/supabase-readiness", requireLmsUser, requireLmsRole("admin"), async (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const checks = await runSupabaseAvniReadDiagnostics();
    return void res.json({
      checkedAt: new Date().toISOString(),
      checks,
      safeCode: Object.values(checks).every(Boolean)
        ? "supabase_reader_preflight_passed"
        : "supabase_reader_preflight_incomplete",
    });
  });

  registerAdminIntegrationReadinessRoute(app, {
    authenticate: requireLmsUser,
    authorizeAdmin: requireLmsRole("admin"),
    load: async () => {
      const meta = getMetaReadiness();
      const crm = await inspectCrmSchema(pool);
      const avniSchemaReady = await admissionsIntegrationSchemaReady(db);
      const registrationUrl = process.env[VSL_WEBHOOK_URL_ENV] ?? "";
      const crmReady = crm.crmPersistence && crm.identityTracking && crm.canonicalAssignments;
      const databaseEndpointPolicy = inspectApplicationDatabaseEndpointPolicy(process.env);
      const databaseStartupPreflight = inspectApplicationDatabaseStartupPreflight(
        process.env,
        {
          checked: applicationRuntimeMode.kind === "least_privilege",
          passed: runtimeDatabaseVerified,
        },
      );
      const evolutionMissingConfigurationNames = [
        ...(!process.env[EVOLUTION_API_KEY_ENV]?.trim() ? [EVOLUTION_API_KEY_ENV] : []),
        ...(!process.env[EVOLUTION_API_INSTANCE_ENV]?.trim() ? [EVOLUTION_API_INSTANCE_ENV] : []),
      ];
      return {
        checkedAt: new Date().toISOString(),
        checklist: buildIntegrationReadinessChecklist({
          environment: process.env.NODE_ENV ?? "unknown",
          crm: {
            runtimeDatabaseVerified,
            schemaReady: crmReady,
            schemaSafeCode: crmReady ? "crm_schema_ready" : "crm_schema_or_assignment_migration_required",
          },
          avni: {
            operationalSchemaReady: avniSchemaReady,
            registrationWebhook: {
              urlValid: Boolean(registrationUrl.trim()) && isTrustedVslWebhookUrl(registrationUrl),
              secretPresent: Boolean(process.env[N8N_INTEGRATION_SECRET_ENV]?.trim()),
              dispatcherActive: isVslDispatchEnabled(),
            },
            supabaseReaderConfigured: isSupabaseAvniReadConfigured(),
            supabaseWriterAvailable: false,
            evolutionTransportConfigured: evolutionPilotTransport.configured,
            evolutionMissingConfigurationNames,
            hmacKeyringState: hmacKeyring.state,
            followUpReadSecretPresent: Boolean(process.env[AVNI_FOLLOWUP_READ_SECRET_ENV]?.trim()),
            pilotHardDisabled: true,
          },
          meta: {
            missingConfigurationNames: meta.leadAds.missing,
            graphApiVersionValid: /^v\d+\.\d+$/.test(process.env.META_GRAPH_API_VERSION?.trim() ?? ""),
          },
        }),
        database: {
          hostPolicySatisfied: databaseEndpointPolicy.hostPolicySatisfied,
          requiredTlsPolicySatisfied: databaseEndpointPolicy.requiredTlsPolicySatisfied,
          preflight: databaseStartupPreflight,
          connectionMode: applicationRuntimeMode.kind,
          leastPrivilegeVerified: runtimeDatabaseVerified,
          safeCode: applicationRuntimeMode.kind === "least_privilege"
            ? "runtime_role_verified_at_startup"
            : "least_privilege_application_url_required",
        },
        crm: {
          persistenceReady: crm.crmPersistence,
          identityTrackingReady: crm.identityTracking,
          canonicalAssignmentsReady: crm.canonicalAssignments,
          safeCode: crmReady ? "crm_schema_ready" : "crm_schema_or_assignment_migration_required",
        },
        avni: {
          operationalSchemaReady: avniSchemaReady,
          registrationWebhook: {
            urlPresent: Boolean(registrationUrl.trim()),
            urlValid: Boolean(registrationUrl.trim()) && isTrustedVslWebhookUrl(registrationUrl),
            secretPresent: Boolean(process.env[N8N_INTEGRATION_SECRET_ENV]?.trim()),
            dispatchRequested: process.env[VSL_DISPATCH_ENABLED_ENV] === "true",
            dispatcherActive: isVslDispatchEnabled(),
          },
          conversationHistory: {
            readerConfigurationValid: isSupabaseAvniReadConfigured(),
            liveSchemaVerified: false,
            writerAvailable: false,
            safeCode: "supabase_runtime_login_and_migration_identity_unverified",
          },
          followUpRead: {
            dedicatedSecretPresent: Boolean(process.env[AVNI_FOLLOWUP_READ_SECRET_ENV]?.trim()),
            candidateEndpointReadOnly: true,
          },
          pilotDispatch: {
            hardDisabled: true,
            hmacKeyringState: hmacKeyring.state,
            runtimeWriterConfigured: false,
            grantEngineConfigured: true,
            providerTransportConfigured: evolutionPilotTransport.configured,
            safeCode: "dispatch_disabled_until_schema_role_and_provider_contract_are_verified",
          },
        },
        meta: {
          pixelConfigured: meta.pixel.configured,
          leadAdsConfigured: meta.leadAds.configured,
          leadAdsMissingConfigurationNames: meta.leadAds.missing,
          graphApiVersionFormatValid: /^v\d+\.\d+$/.test(process.env.META_GRAPH_API_VERSION?.trim() ?? ""),
          pageIdentity: "not_checked",
          pageSubscription: "not_checked",
          formAccess: "not_checked",
          diagnosticPath: "/api/admin/meta/lead-ads-diagnostics",
          capiConfigured: meta.capi.configured,
          capiEnabled: meta.capi.enabled,
        },
      };
    },
  });

  app.get(
    "/api/integrations/n8n/diagnostics",
    createAvniDiagnosticsHandler({
      checkOperationalApiReady: () => admissionsIntegrationSchemaReady(db),
    }),
  );

  app.get("/api/integrations/n8n/health", avniIntegrationAuth, async (_req, res) => {
    try {
      const ready = await schemaReady();
      return void res.status(ready ? 200 : 503).json({
        ready, sourceOfTruth: "replit_postgresql", transcriptStore: "supabase",
        conversationReaderConfigured: isSupabaseAvniReadConfigured(),
      });
    } catch {
      return void res.status(503).json({ ready: false, sourceOfTruth: "replit_postgresql" });
    }
  });

  registerAvniLeadUpsertRoute(app, {
    authenticate: avniIntegrationAuth,
    schemaReady,
    upsertLead: upsertIntegrationLead,
    readLeadJourney: readLeadFollowUpByPhone,
    readCrmFollowUpState,
  });

  app.get("/api/integrations/n8n/leads/:leadId/context", avniIntegrationAuth, async (req, res) => {
    const leadId = z.string().uuid().safeParse(req.params.leadId);
    if (!leadId.success) return void res.status(400).json({ message: "A stable lead UUID is required." });
    try {
      if (!await schemaReady()) return void res.status(503).json({ message: "AVNI integration schema is not ready." });
      const status = await readLeadFollowUpStatus(leadId.data);
      if (!status) return void res.status(404).json({ message: "Lead not found." });
      const crm = await readCrmFollowUpState(leadId.data);
      if (!crm) return void res.status(404).json({ message: "Lead not found." });
      return void res.json({
        leadId: status.leadId,
        crm,
        registeredAt: status.registeredAt,
        video: status.video,
        questionnaire: status.questionnaire,
        consent: status.consent,
        enrollment: { status: "unavailable", verified: false },
        payment: { status: "unavailable", verified: false, source: null },
      });
    } catch {
      return void res.status(503).json({ message: "Lead operational context is temporarily unavailable." });
    }
  });

  app.post("/api/integrations/n8n/leads/whatsapp-opt-out", avniIntegrationAuth, async (req, res) => {
    const parsed = z.object({ phone: canonicalPhone }).strict().safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: "invalid_phone" });
    try {
      if (!await schemaReady()) return void res.status(503).json({ code: "opt_out_unavailable" });
      const canonicalPhone = normalizeIndianMobile(parsed.data.phone);
      if (!canonicalPhone) return void res.status(400).json({ code: "invalid_phone" });
      const { rows } = await pool.query(
        "SELECT id FROM admissions_leads WHERE canonical_phone=$1 LIMIT 2",
        [canonicalPhone],
      );
      if (rows.length === 0) return void res.status(404).json({ code: "canonical_lead_not_found" });
      if (rows.length !== 1) return void res.status(409).json({ code: "ambiguous_canonical_lead" });
      if (!await recordWhatsAppOptOut(rows[0].id, "n8n")) {
        return void res.status(404).json({ code: "canonical_lead_not_found" });
      }
      return void res.json({ status: "opted_out" });
    } catch {
      return void res.status(503).json({ code: "opt_out_unavailable" });
    }
  });

  app.post("/api/integrations/n8n/conversations/messages", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Replit no longer accepts conversation transcripts. Supabase is the conversation source of truth.",
    });
  });

  app.patch("/api/integrations/n8n/conversations/messages/:messageId/delivery", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Delivery state is owned by Supabase; Replit does not store transcript delivery records.",
    });
  });

  app.get("/api/integrations/n8n/leads/:leadId/conversations", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Conversation history is read from Supabase by the authorized CRM view; n8n owns message storage.",
    });
  });

  app.post("/api/integrations/n8n/conversations/read", avniIntegrationAuth, async (req, res) => {
    return void res.status(410).json({
      message: "Conversation history is stored in Supabase and is not returned by Replit's operational API.",
    });
  });
}
