import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Check, RefreshCw, ShieldCheck } from "lucide-react";
import AvniProductionDiagnostics from "./AvniProductionDiagnostics";

type IntegratedReadiness = {
  checkedAt: string;
  database: {
    connectionMode: string;
    leastPrivilegeVerified: boolean;
    safeCode: string;
  };
  crm: {
    persistenceReady: boolean;
    identityTrackingReady: boolean;
    canonicalAssignmentsReady: boolean;
    safeCode: string;
  };
  avni: {
    operationalSchemaReady: boolean;
    registrationWebhook: {
      urlPresent: boolean;
      urlValid: boolean;
      secretPresent: boolean;
      dispatchRequested: boolean;
      dispatcherActive: boolean;
    };
    conversationHistory: {
      readerConfigurationValid: boolean;
      liveSchemaVerified: boolean;
      writerAvailable: boolean;
      safeCode: string;
    };
    followUpRead: {
      dedicatedSecretPresent: boolean;
      candidateEndpointReadOnly: boolean;
    };
    pilotDispatch: {
      hardDisabled: boolean;
      hmacKeyringState: "missing" | "invalid" | "ready";
      runtimeWriterConfigured: boolean;
      grantEngineConfigured: boolean;
      providerTransportConfigured: boolean;
      safeCode: string;
    };
  };
  meta: {
    pixelConfigured: boolean;
    leadAdsConfigured: boolean;
    leadAdsMissingConfigurationNames: string[];
    graphApiVersionFormatValid: boolean;
    pageIdentity: string;
    pageSubscription: string;
    formAccess: string;
    diagnosticPath: string;
    capiConfigured: boolean;
    capiEnabled: boolean;
  };
};

type MetaDiagnostic = {
  pageIdentityChecked: boolean;
  pageIdentityMatches: boolean;
  subscriptionChecked: boolean;
  appInstalled: boolean;
  leadgenSubscribed: boolean;
  formAccessChecked: boolean;
  formAccessGranted: boolean;
  hasAccessibleForm: boolean;
  errorCategory?: string;
  graphHttpStatus?: number | null;
  graphErrorType?: string | null;
  graphErrorCode?: number | null;
  graphErrorSubcode?: number | null;
  graphErrorIsTransient?: boolean | null;
  diagnosticOnly: boolean;
  requestApplied: boolean;
};

async function fetchReadiness(): Promise<IntegratedReadiness> {
  const response = await fetch("/api/admin/integrations/readiness", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Integrated readiness could not be checked.");
  return response.json();
}

function State({ ready, label }: { ready: boolean; label: string }) {
  return <span className={`integration-state ${ready ? "is-ready" : "is-blocked"}`}>
    {ready ? <Check size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
    {label}
  </span>;
}

export default function IntegrationReadinessPanel() {
  const readiness = useQuery({
    queryKey: ["admin-integrated-readiness"],
    queryFn: fetchReadiness,
    retry: false,
    staleTime: 15_000,
  });
  const [metaDiagnostic, setMetaDiagnostic] = useState<MetaDiagnostic | null>(null);
  const [metaError, setMetaError] = useState("");
  const [checkingMeta, setCheckingMeta] = useState(false);
  const [supabaseChecks, setSupabaseChecks] = useState<Record<string, boolean> | null>(null);
  const [supabaseError, setSupabaseError] = useState("");
  const [checkingSupabase, setCheckingSupabase] = useState(false);

  async function checkMeta() {
    setCheckingMeta(true);
    setMetaError("");
    try {
      const response = await fetch("/api/admin/meta/lead-ads-diagnostics", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Meta's read-only check did not complete.");
      setMetaDiagnostic(await response.json());
    } catch {
      setMetaDiagnostic(null);
      setMetaError("Meta's read-only check is unavailable. No credential or lead data is shown.");
    } finally {
      setCheckingMeta(false);
    }
  }

  async function checkSupabaseReader() {
    setCheckingSupabase(true);
    setSupabaseError("");
    try {
      const response = await fetch("/api/admin/integrations/avni/supabase-readiness", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Supabase read-only check did not complete.");
      const body = await response.json();
      setSupabaseChecks(body.checks as Record<string, boolean>);
    } catch {
      setSupabaseChecks(null);
      setSupabaseError("Supabase read-only preflight is unavailable. No conversation or applicant records are shown.");
    } finally {
      setCheckingSupabase(false);
    }
  }

  const data = readiness.data;
  const runtimeReady = Boolean(
    data?.database.leastPrivilegeVerified &&
    data.crm.persistenceReady &&
    data.crm.identityTrackingReady &&
    data.crm.canonicalAssignmentsReady,
  );
  return <section className="integration-readiness" aria-labelledby="integration-readiness-title" data-testid="integrated-readiness">
    <div className="integration-readiness-heading">
      <div>
        <p className="crm-eyebrow">Admin operations</p>
        <h2 id="integration-readiness-title">Integrated readiness</h2>
        <p>Configuration presence is not the same as a verified live connection. Checks never display credentials or applicant data.</p>
      </div>
      <button className="crm-button crm-button-quiet" type="button" onClick={() => void readiness.refetch()} disabled={readiness.isFetching}>
        <RefreshCw size={15} aria-hidden="true" /> Refresh
      </button>
    </div>

    {readiness.isLoading && <p role="status">Checking CRM and integration readiness…</p>}
    {readiness.isError && <div className="crm-error" role="alert">Integrated readiness is unavailable. Check the server health diagnostics.</div>}

    {data && <>
      <div className={`integration-readiness-summary ${runtimeReady ? "is-ready" : "is-blocked"}`}>
        <ShieldCheck size={18} aria-hidden="true" />
        <strong>{runtimeReady ? "CRM runtime checks passed" : "CRM runtime has a blocker"}</strong>
        <span>AVNI pilot sending remains hard-disabled. Meta Page identity, subscription, and form access require the separate read-only check below.</span>
      </div>

      <div className="integration-readiness-grid">
        <section>
          <h3>CRM</h3>
          <State ready={data.database.leastPrivilegeVerified} label={data.database.leastPrivilegeVerified ? "Least-privilege database role verified at startup" : "Production requires an explicit least-privilege application URL"} />
          <State ready={data.crm.persistenceReady && data.crm.identityTrackingReady && data.crm.canonicalAssignmentsReady} label={data.crm.persistenceReady && data.crm.identityTrackingReady && data.crm.canonicalAssignmentsReady ? "Lead, identity, and assignment schema ready" : data.crm.safeCode} />
          <small>Connection mode: {data.database.connectionMode}</small>
        </section>

        <section>
          <h3>AVNI</h3>
          <State ready={data.avni.operationalSchemaReady} label={data.avni.operationalSchemaReady ? "CRM operational schema available" : "Required CRM integration schema unavailable"} />
          <State ready={data.avni.conversationHistory.readerConfigurationValid && data.avni.conversationHistory.liveSchemaVerified} label={data.avni.conversationHistory.liveSchemaVerified ? "Supabase conversation reader verified" : data.avni.conversationHistory.readerConfigurationValid ? "Reader configuration present; Supabase schema not verified" : "Conversation reader configuration unavailable"} />
          <button className="crm-button crm-button-secondary" type="button" onClick={() => void checkSupabaseReader()} disabled={checkingSupabase}>
            {checkingSupabase ? "Checking Supabase…" : "Verify Supabase reader (read-only)"}
          </button>
          {supabaseError && <p className="crm-error" role="alert">{supabaseError}</p>}
          {supabaseChecks && <small role="status">{Object.values(supabaseChecks).filter(Boolean).length}/{Object.keys(supabaseChecks).length} Supabase reader checks passed. Checks use catalog permissions and synthetic empty lookups only.</small>}
          <State ready={data.avni.registrationWebhook.urlValid && data.avni.registrationWebhook.secretPresent} label={data.avni.registrationWebhook.urlValid && data.avni.registrationWebhook.secretPresent ? "Registration webhook configured" : "Registration webhook configuration incomplete"} />
          <small>VSL event dispatcher: {data.avni.registrationWebhook.dispatcherActive ? "enabled by server configuration" : data.avni.registrationWebhook.dispatchRequested ? "requested but unavailable" : "disabled"}.</small>
          <State ready={data.avni.pilotDispatch.hardDisabled && !data.avni.pilotDispatch.runtimeWriterConfigured} label="Pilot sender hard-disabled; runtime writer is not connected" />
          <small>HMAC keyring: {data.avni.pilotDispatch.hmacKeyringState}. The candidate endpoint is read-only; n8n campaign/follow-up execution state is not verified here.</small>
        </section>

        <section>
          <h3>Meta Lead Ads</h3>
          <State ready={data.meta.leadAdsConfigured && data.meta.graphApiVersionFormatValid} label={data.meta.leadAdsConfigured && data.meta.graphApiVersionFormatValid ? "Required configuration names present; token/Page identity not yet checked" : "Configuration incomplete or Graph version format invalid"} />
          {data.meta.leadAdsMissingConfigurationNames.length > 0 && <small>Missing or invalid: {data.meta.leadAdsMissingConfigurationNames.join(", ")}</small>}
          <small>Page identity, leadgen subscription, and form access: not checked.</small>
          <button className="crm-button crm-button-secondary" type="button" onClick={() => void checkMeta()} disabled={checkingMeta}>
            {checkingMeta ? "Checking Meta…" : "Run read-only Meta Page check"}
          </button>
          {metaError && <p className="crm-error" role="alert">{metaError}</p>}
          {metaDiagnostic && <div className="integration-meta-result" role="status">
            <State ready={metaDiagnostic.pageIdentityChecked && metaDiagnostic.pageIdentityMatches} label={metaDiagnostic.pageIdentityChecked ? metaDiagnostic.pageIdentityMatches ? "Page token identity matches configured Page" : "Page token identity does not match" : "Page token identity not verified"} />
            <State ready={metaDiagnostic.subscriptionChecked && metaDiagnostic.appInstalled && metaDiagnostic.leadgenSubscribed} label={metaDiagnostic.leadgenSubscribed ? "App subscribed to leadgen" : metaDiagnostic.subscriptionChecked ? "App leadgen subscription is missing" : "App subscription not verified"} />
            <State ready={metaDiagnostic.formAccessGranted && metaDiagnostic.hasAccessibleForm} label={metaDiagnostic.formAccessGranted ? metaDiagnostic.hasAccessibleForm ? "Form access verified" : "Form endpoint accessible; no form returned" : metaDiagnostic.formAccessChecked ? "Form access check failed" : "Form access not verified"} />
            {metaDiagnostic.errorCategory && <small>Safe result: {metaDiagnostic.errorCategory}{metaDiagnostic.graphHttpStatus ? ` · HTTP ${metaDiagnostic.graphHttpStatus}` : ""}{metaDiagnostic.graphErrorCode !== undefined && metaDiagnostic.graphErrorCode !== null ? ` · Graph code ${metaDiagnostic.graphErrorCode}` : ""}{metaDiagnostic.graphErrorSubcode !== undefined && metaDiagnostic.graphErrorSubcode !== null ? ` · subcode ${metaDiagnostic.graphErrorSubcode}` : ""}</small>}
            <small>Read-only only; no subscription was changed and no lead submissions were fetched.</small>
          </div>}
        </section>
      </div>

      <details className="integration-diagnostics-detail">
        <summary>Additional AVNI database diagnostics</summary>
        <AvniProductionDiagnostics />
      </details>
      <small className="integration-readiness-updated">Last checked: {new Date(data.checkedAt).toLocaleString()}</small>
    </>}
  </section>;
}
