import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
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
  database: {
    hostPolicySatisfied: boolean;
    requiredTlsPolicySatisfied: boolean;
    preflight?: {
      platform: DatabaseConnectionPreflight;
      application: DatabaseConnectionPreflight;
      endpointDatabaseOptionsMatch: boolean;
      distinctLoginConfigured: boolean;
      rolePreflightChecked: boolean;
      rolePreflightPassed: boolean;
    };
  };
};

type DatabaseConnectionPreflight = {
  configured: boolean;
  parseable: boolean;
  hostClassification:
    | "approved_replit_managed_neon"
    | "approved_internal_policy"
    | "rejected"
    | "unavailable";
  hostPolicyPassed: boolean;
  tlsEnabled: boolean;
  tlsPolicyPassed: boolean;
};

type DatabaseRuntimeProbe = {
  endpointPolicyPassed: boolean;
  tlsPolicyPassed: boolean;
  endpointsMatch: boolean;
  distinctApplicationLogin: boolean;
  tlsConnectionRequired: boolean;
  tlsActive: boolean | null;
  runtimeLoginVerified: boolean;
  effectiveMinimumGrantsVerified: boolean;
  schemaMarkersVerified: boolean;
  safeCode: string;
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
  const [databaseProbe, setDatabaseProbe] = useState<DatabaseRuntimeProbe | null>(null);
  const [databaseProbeError, setDatabaseProbeError] = useState("");
  const [checkingDatabaseProbe, setCheckingDatabaseProbe] = useState(false);

  function refreshReadiness() {
    setMetaDiagnostic(null);
    setMetaError("");
    setSupabaseChecks(null);
    setSupabaseError("");
    setDatabaseProbe(null);
    setDatabaseProbeError("");
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

  async function checkDatabaseRuntime() {
    setCheckingDatabaseProbe(true);
    setDatabaseProbe(null);
    setDatabaseProbeError("");
    try {
      const response = await fetch("/api/admin/integrations/readiness/database-probe", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Database readiness probe did not complete.");
      setDatabaseProbe(await response.json() as DatabaseRuntimeProbe);
    } catch {
      setDatabaseProbeError("Database probe is unavailable. No connection or database details are shown.");
    } finally {
      setCheckingDatabaseProbe(false);
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

      {data?.database && <section
        className="integration-readiness-area"
        aria-label="CRM database endpoint configuration"
        data-testid="crm-database-endpoint-policy"
      >
        <div className="integration-area-heading">
          <h3>CRM database endpoint configuration</h3>
          <span className="integration-area-status is-not-checked">Configuration only</span>
        </div>
        <p>This section inspects URL policy only. The separate administrator-triggered probe verifies the current connection, runtime role, grants, and schema without reading customer rows.</p>
        <ul className="integration-check-list">
          <CheckRow item={{
            id: "database-host-policy",
            label: "Approved internal host policy",
            status: data.database.hostPolicySatisfied ? "PASS" : "BLOCKED",
            detail: data.database.hostPolicySatisfied
              ? "Configured endpoints satisfy the existing internal/managed-Neon host allowlist."
              : "A configured endpoint is missing, invalid, or outside the existing host allowlist.",
            requiredActions: data.database.hostPolicySatisfied
              ? []
              : ["Review the database endpoint configuration without relaxing the host allowlist."],
          }} />
          <CheckRow item={{
            id: "database-required-tls",
            label: "Required managed-Neon TLS mode",
            status: data.database.requiredTlsPolicySatisfied ? "PASS" : "BLOCKED",
            detail: data.database.requiredTlsPolicySatisfied
              ? "The existing TLS policy is satisfied for parsed endpoints."
              : "A required TLS mode is missing, or an endpoint could not be parsed.",
            requiredActions: data.database.requiredTlsPolicySatisfied
              ? []
              : ["Review the configured sslmode without weakening the existing TLS policy."],
          }} />
        </ul>
        {data.database.preflight && <div className="integration-diagnostics-detail" data-testid="crm-database-startup-preflight">
           <h4>Connection-free startup configuration preflight</h4>
          <p>Sanitized configuration checks only; no connection strings, usernames, passwords, or query values are shown.</p>
          <ul className="integration-check-list">
            {([
              ["Platform database reference", data.database.preflight.platform],
              ["Application database connection", data.database.preflight.application],
            ] as const).map(([label, connection]) => <Fragment key={label}>
              <CheckRow item={{
                id: `${label}-host-policy`,
                label: `${label}: approved host policy`,
                status: connection.hostPolicyPassed ? "PASS" : "BLOCKED",
                detail: `Classification: ${connection.hostClassification}; configured: ${connection.configured ? "yes" : "no"}; parseable: ${connection.parseable ? "yes" : "no"}.`,
                requiredActions: connection.hostPolicyPassed ? [] : ["Check the configured endpoint against the existing host policy."],
              }} />
              <CheckRow item={{
                id: `${label}-tls-policy`,
                label: `${label}: TLS policy`,
                status: connection.tlsPolicyPassed ? "PASS" : "BLOCKED",
                detail: `TLS enabled: ${connection.tlsEnabled ? "yes" : "no"}.`,
                requiredActions: connection.tlsPolicyPassed ? [] : ["Review the configured TLS mode without weakening the existing policy."],
              }} />
            </Fragment>)}
            <CheckRow item={{
              id: "database-endpoint-match",
              label: "Endpoint, database, and options match",
              status: data.database.preflight.endpointDatabaseOptionsMatch ? "PASS" : "BLOCKED",
              detail: data.database.preflight.endpointDatabaseOptionsMatch
                ? "The parsed platform and application endpoints match under the existing policy."
                : "The endpoints are missing, invalid, or differ under the existing policy.",
              requiredActions: data.database.preflight.endpointDatabaseOptionsMatch ? [] : ["Review endpoint/database/options alignment."],
            }} />
            <CheckRow item={{
              id: "database-distinct-login",
              label: "Distinct application login configured",
              status: data.database.preflight.distinctLoginConfigured ? "PASS" : "BLOCKED",
              detail: data.database.preflight.distinctLoginConfigured
                ? "The application and platform logins are distinct."
                : "A distinct application login is not confirmed.",
              requiredActions: data.database.preflight.distinctLoginConfigured ? [] : ["Configure a distinct least-privilege application login."],
            }} />
            <CheckRow item={{
              id: "database-role-preflight",
              label: "Least-privilege role preflight",
              status: !data.database.preflight.rolePreflightChecked
                ? "NOT CHECKED"
                : data.database.preflight.rolePreflightPassed ? "PASS" : "BLOCKED",
              detail: !data.database.preflight.rolePreflightChecked
                ? "The database role check has not run in this process."
                : data.database.preflight.rolePreflightPassed
                  ? "The startup role and privilege checks passed."
                  : "The startup role or privilege checks failed.",
              requiredActions: !data.database.preflight.rolePreflightChecked || data.database.preflight.rolePreflightPassed
                ? []
                : ["Review the safe startup failure code and role/grant preflight."],
            }} />
          </ul>
        </div>}
      </section>}

      <div className="integration-readiness-actions">
        <section>
          <h4>Safe read-only checks</h4>
          <p>The explicit CRM role/grant probe runs only after an administrator clicks. The baseline readiness request is separate; Meta and Supabase probes are also manual. The database probe uses a short read-only transaction and catalog metadata only, never customer rows.</p>
          <div className="integration-action-buttons">
            <button className="crm-button crm-button-secondary" type="button" onClick={() => void checkDatabaseRuntime()} disabled={checkingDatabaseProbe}>
              {checkingDatabaseProbe ? "Checking CRM database…" : "Run CRM database role/schema probe"}
            </button>
            <button className="crm-button crm-button-secondary" type="button" onClick={() => void checkSupabaseReader()} disabled={checkingSupabase}>
              {checkingSupabase ? "Checking Supabase…" : "Run Supabase reader preflight"}
            </button>
            <button className="crm-button crm-button-secondary" type="button" onClick={() => void checkMeta()} disabled={checkingMeta}>
              {checkingMeta ? "Checking Meta…" : "Run Meta Page diagnostic"}
            </button>
          </div>
          {supabaseError && <p className="crm-error" role="alert">{supabaseError}</p>}
          {databaseProbeError && <p className="crm-error" role="alert">{databaseProbeError}</p>}
          {metaError && <p className="crm-error" role="alert">{metaError}</p>}
          {databaseProbe && <div className="integration-diagnostics-detail" data-testid="crm-database-runtime-probe">
            <h4>Current runtime database result</h4>
            <p>Read-only metadata check; no customer rows or connection details are returned.</p>
            <ul className="integration-check-list">
              {([
                ["Endpoint host policy", databaseProbe.endpointPolicyPassed],
                ["Required TLS policy", databaseProbe.tlsPolicyPassed],
                ["Application endpoints match", databaseProbe.endpointsMatch],
                ["Distinct application login", databaseProbe.distinctApplicationLogin],
                ["TLS requirement", databaseProbe.tlsPolicyPassed && (!databaseProbe.tlsConnectionRequired || databaseProbe.tlsActive === true)],
                ["TLS active on this connection", databaseProbe.tlsActive],
                ["Restricted runtime login", databaseProbe.runtimeLoginVerified],
                ["Approved effective grants", databaseProbe.effectiveMinimumGrantsVerified],
                ["Required schema markers", databaseProbe.schemaMarkersVerified],
              ] as const).map(([label, passed]) => <CheckRow key={label} item={{
                id: `runtime-probe-${label}`,
                label,
                status: passed === null ||
                  (label === "TLS active on this connection" && passed === false && !databaseProbe.tlsConnectionRequired)
                  ? "NOT CHECKED"
                  : passed ? "PASS" : "BLOCKED",
                detail: label === "TLS active on this connection" && passed === false && !databaseProbe.tlsConnectionRequired
                  ? "TLS is not required for the current internal endpoint policy."
                  : passed === null ? "The database check did not reach this metadata." : passed ? "Verified by the administrator-triggered read-only probe." : "The bounded metadata check did not verify this requirement.",
                requiredActions: [],
              }} />)}
            </ul>
            <small>Safe result: {databaseProbe.safeCode}</small>
          </div>}
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
