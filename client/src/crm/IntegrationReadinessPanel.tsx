import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Check, RefreshCw, ShieldCheck } from "lucide-react";
import {
  applyMetaDiagnosticToChecklist,
  applySupabaseReaderDiagnosticToChecklist,
  type IntegrationReadinessChecklist,
  type MetaDiagnosticSummary,
  type ReadinessArea,
  type ReadinessCheck,
  type ReadinessStatus,
} from "@shared/integration-readiness";
import AvniProductionDiagnostics from "./AvniProductionDiagnostics";

type IntegratedReadiness = {
  checkedAt: string;
  checklist: IntegrationReadinessChecklist;
};

type MetaDiagnostic = MetaDiagnosticSummary & {
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

function statusIcon(status: ReadinessStatus) {
  if (status === "PASS") return <Check size={14} aria-hidden="true" />;
  return <AlertTriangle size={14} aria-hidden="true" />;
}

function CheckRow({ item }: { item: ReadinessCheck }) {
  return <li className="integration-check">
    <div className="integration-check-heading">
      <span className={`integration-state is-${item.status.toLowerCase().replaceAll(" ", "-")}`}>
        {statusIcon(item.status)}
        <strong>{item.status}</strong>
      </span>
      <strong>{item.label}</strong>
    </div>
    <p>{item.detail}</p>
    {item.requiredActions.length > 0 && <ul className="integration-prerequisites">
      {item.requiredActions.map((action) => <li key={action}>{action}</li>)}
    </ul>}
  </li>;
}

function ReadinessArea({ name, area }: { name: string; area: ReadinessArea }) {
  return <section className="integration-readiness-area" aria-label={`${name} readiness`}>
    <div className="integration-area-heading">
      <h3>{name}</h3>
      <span className={`integration-area-status is-${area.status.toLowerCase().replaceAll(" ", "-")}`}>
        {area.status}
      </span>
    </div>
    <ul className="integration-check-list">
      {area.checks.map((item) => <CheckRow key={item.id} item={item} />)}
    </ul>
  </section>;
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

  function refreshReadiness() {
    setMetaDiagnostic(null);
    setMetaError("");
    setSupabaseChecks(null);
    setSupabaseError("");
    void readiness.refetch();
  }

  async function checkMeta() {
    setCheckingMeta(true);
    setMetaError("");
    try {
      const response = await fetch("/api/admin/meta/lead-ads-diagnostics", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Meta's read-only check did not complete.");
      const body = await response.json() as MetaDiagnostic;
      if (body.requestApplied || !body.diagnosticOnly) {
        throw new Error("Unexpected Meta diagnostic response.");
      }
      setMetaDiagnostic(body);
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
  let checklist = data?.checklist ?? null;
  if (checklist && metaDiagnostic) {
    checklist = applyMetaDiagnosticToChecklist(checklist, metaDiagnostic);
  }
  if (checklist && supabaseChecks) {
    checklist = applySupabaseReaderDiagnosticToChecklist(checklist, supabaseChecks);
  }

  return <section className="integration-readiness" aria-labelledby="integration-readiness-title" data-testid="integrated-readiness">
    <div className="integration-readiness-heading">
      <div>
        <p className="crm-eyebrow">Admin operations</p>
        <h2 id="integration-readiness-title">Integrated go-live checklist</h2>
        <p>PASS means a live, scoped check passed. Configuration presence and source tests alone never count as go-live verification.</p>
      </div>
      <button className="crm-button crm-button-quiet" type="button" onClick={refreshReadiness} disabled={readiness.isFetching}>
        <RefreshCw size={15} aria-hidden="true" /> Refresh
      </button>
    </div>

    {readiness.isLoading && <p role="status">Checking current runtime readiness…</p>}
    {readiness.isError && <div className="crm-error" role="alert">Integrated readiness is unavailable. Check the server health diagnostics.</div>}

    {checklist && <>
      <div className="integration-readiness-summary is-blocked">
        <ShieldCheck size={18} aria-hidden="true" />
        <strong>Sending and follow-up campaigns remain disabled.</strong>
        <span>These checks report prerequisites only; they never authorize a dispatch, change a subscription, or enable a workflow.</span>
        <small>Checklist scope: {checklist.environment}. A Development PASS is never represented as Production PASS.</small>
      </div>

      <div className="integration-readiness-grid">
        <ReadinessArea name="CRM" area={checklist.crm} />
        <ReadinessArea name="AVNI counsellor" area={checklist.avni} />
        <ReadinessArea name="Meta Lead Ads" area={checklist.meta} />
      </div>

      <div className="integration-readiness-actions">
        <section>
          <h4>Safe read-only checks</h4>
          <p>Meta checks make Graph GET requests only when clicked. Supabase checks use the configured restricted reader and synthetic empty lookups only.</p>
          <div className="integration-action-buttons">
            <button className="crm-button crm-button-secondary" type="button" onClick={() => void checkSupabaseReader()} disabled={checkingSupabase}>
              {checkingSupabase ? "Checking Supabase…" : "Run Supabase reader preflight"}
            </button>
            <button className="crm-button crm-button-secondary" type="button" onClick={() => void checkMeta()} disabled={checkingMeta}>
              {checkingMeta ? "Checking Meta…" : "Run Meta Page diagnostic"}
            </button>
          </div>
          {supabaseError && <p className="crm-error" role="alert">{supabaseError}</p>}
          {metaError && <p className="crm-error" role="alert">{metaError}</p>}
          {metaDiagnostic?.errorCategory && <small role="status">
            Meta safe result: {metaDiagnostic.errorCategory}
            {metaDiagnostic.graphHttpStatus ? ` · HTTP ${metaDiagnostic.graphHttpStatus}` : ""}
            {metaDiagnostic.graphErrorCode !== undefined && metaDiagnostic.graphErrorCode !== null ? ` · Graph code ${metaDiagnostic.graphErrorCode}` : ""}
            {metaDiagnostic.graphErrorSubcode !== undefined && metaDiagnostic.graphErrorSubcode !== null ? ` · subcode ${metaDiagnostic.graphErrorSubcode}` : ""}
            {metaDiagnostic.graphErrorType ? ` · ${metaDiagnostic.graphErrorType}` : ""}
            {metaDiagnostic.graphErrorIsTransient === true ? " · transient" : ""}
          </small>}
        </section>
      </div>

      <details className="integration-diagnostics-detail">
        <summary>Additional AVNI runtime diagnostics</summary>
        <AvniProductionDiagnostics />
      </details>
      <small className="integration-readiness-updated">Last checked: {new Date(data?.checkedAt ?? Date.now()).toLocaleString()}</small>
    </>}
  </section>;
}
