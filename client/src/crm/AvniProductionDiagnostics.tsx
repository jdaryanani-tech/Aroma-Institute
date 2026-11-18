import { useState, type FormEvent } from "react";

type AvniDiagnosticsResult = {
  checkedAt: string;
  database: {
    runtimeEnvironment: "production" | "development" | "test" | "other";
    connectionMode: "legacy" | "least_privilege" | "unknown";
    leastPrivilegeVerified: boolean;
    fingerprintAlgorithm: "HMAC-SHA-256";
    fingerprint: string;
  };
  serviceIdentity: {
    name: "avni-followup-reader";
    capability: "crm.followups.candidates.read";
    secretConfigured: boolean;
    credentialDistinct: boolean;
    scopeReady: boolean;
  };
};

export default function AvniProductionDiagnostics() {
  const [result, setResult] = useState<AvniDiagnosticsResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function checkReadiness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setResult(null);
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/admin/integrations/avni/production-diagnostics", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("diagnostics_unavailable");
      setResult(await response.json() as AvniDiagnosticsResult);
    } catch {
      setError("Diagnostics are unavailable. No secret or lead data was returned.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="crm-source-analytics avni-production-diagnostics" aria-labelledby="avni-diagnostics-title" data-testid="avni-production-diagnostics">
      <div className="crm-source-analytics-header">
        <div>
          <p className="crm-eyebrow">Administrator only · read-only</p>
          <h2 id="avni-diagnostics-title">AVNI runtime diagnostics</h2>
        </div>
        {result && <time className="crm-source-analytics-updated" dateTime={result.checkedAt}>
          Checked {new Date(result.checkedAt).toLocaleString()}
        </time>}
      </div>
      <p className="crm-source-analytics-note">
        This checks the database connected to this app runtime and whether the dedicated read-only AVNI candidate scope is ready. Confirm the runtime says production before treating it as a Production check.
      </p>
      <p className="crm-source-analytics-note">
        The database fingerprint is keyed for this environment and may change if the session secret rotates.
      </p>
      <form className="avni-diagnostics-form" onSubmit={event => void checkReadiness(event)}>
        <div className="avni-diagnostics-controls">
          <button className="crm-button crm-button-primary" type="submit" disabled={pending}>
            {pending ? "Checking…" : "Check read-only readiness"}
          </button>
        </div>
        <span className="crm-source-analytics-note">
          This does not inspect LMS user accounts or return candidate or contact records.
        </span>
      </form>
      {error && <p className="crm-error" role="alert">{error}</p>}
      {result && (
        <div className="avni-diagnostics-result" role="status" aria-live="polite">
          <section>
            <h3>Application database</h3>
            <dl>
              <div><dt>Runtime</dt><dd>{result.database.runtimeEnvironment}</dd></div>
              <div><dt>Connection mode</dt><dd>{result.database.connectionMode}</dd></div>
              <div><dt>Least-privilege role verified</dt><dd>{result.database.leastPrivilegeVerified ? "Yes" : "No"}</dd></div>
              <div><dt>Identity fingerprint</dt><dd className="avni-diagnostics-fingerprint">{result.database.fingerprint}</dd></div>
            </dl>
          </section>
          <section>
            <h3>AVNI read-only service</h3>
            <dl>
              <div><dt>Service principal</dt><dd>{result.serviceIdentity.name}</dd></div>
              <div><dt>Capability</dt><dd>{result.serviceIdentity.capability}</dd></div>
              <div><dt>Dedicated secret configured</dt><dd>{result.serviceIdentity.secretConfigured ? "Yes" : "No"}</dd></div>
              <div><dt>Separate from shared secret</dt><dd>{result.serviceIdentity.credentialDistinct ? "Yes" : "No"}</dd></div>
              <div><dt>Read scope ready</dt><dd>{result.serviceIdentity.scopeReady ? "Yes" : "No"}</dd></div>
            </dl>
          </section>
        </div>
      )}
    </section>
  );
}
