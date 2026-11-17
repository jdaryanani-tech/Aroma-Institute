import { useState, type FormEvent } from "react";

type AvniDiagnosticsResult = {
  checkedAt: string;
  database: {
    runtimeEnvironment: "production" | "development" | "test" | "other";
    connectionMode: "legacy" | "least_privilege" | "unknown";
    fingerprintAlgorithm: "HMAC-SHA-256";
    fingerprint: string;
  };
  actor: {
    matchCount: number;
    active: boolean | null;
    roleNames: string[];
    authorized: boolean;
  };
};

export default function AvniProductionDiagnostics() {
  const [actorPhone, setActorPhone] = useState("");
  const [result, setResult] = useState<AvniDiagnosticsResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function checkActor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !actorPhone.trim()) return;
    const phoneForRequest = actorPhone;
    setActorPhone("");
    setResult(null);
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/admin/integrations/avni/production-diagnostics", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationAccountPhone: phoneForRequest }),
      });
      if (!response.ok) throw new Error("diagnostics_unavailable");
      setResult(await response.json() as AvniDiagnosticsResult);
    } catch {
      setError("Diagnostics are unavailable. No phone number or database details were saved.");
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
        This fingerprints the database connected to this app runtime. Confirm the result says production before treating it as a Production check. The actor phone is masked, sent only for this request, and not saved or included in the result.
      </p>
      <p className="crm-source-analytics-note">
        The database fingerprint is keyed for this environment and may change if the session secret rotates.
      </p>
      <form className="avni-diagnostics-form" onSubmit={event => void checkActor(event)}>
        <label htmlFor="avni-diagnostics-phone">Automation account phone</label>
        <div className="avni-diagnostics-controls">
          <input
            id="avni-diagnostics-phone"
            className="crm-input"
            type="password"
            inputMode="tel"
            autoComplete="off"
            maxLength={32}
            value={actorPhone}
            onChange={event => {
              setActorPhone(event.target.value);
              setResult(null);
              setError("");
            }}
            aria-describedby="avni-diagnostics-privacy"
            required
          />
          <button className="crm-button crm-button-primary" type="submit" disabled={pending || !actorPhone.trim()}>
            {pending ? "Checking…" : "Run read-only check"}
          </button>
        </div>
        <span id="avni-diagnostics-privacy" className="crm-source-analytics-note">
          The field clears when you run the check. Results contain no phone number or CRM records.
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
              <div><dt>Identity fingerprint</dt><dd className="avni-diagnostics-fingerprint">{result.database.fingerprint}</dd></div>
            </dl>
          </section>
          <section>
            <h3>Automation actor</h3>
            <dl>
              <div><dt>Exact matches</dt><dd>{result.actor.matchCount}</dd></div>
              <div><dt>Active</dt><dd>{result.actor.active === null ? "Not uniquely matched" : result.actor.active ? "Yes" : "No"}</dd></div>
              <div><dt>Roles</dt><dd>{result.actor.roleNames.length ? result.actor.roleNames.join(", ") : "None reported"}</dd></div>
              <div><dt>CRM authorization</dt><dd>{result.actor.authorized ? "Pass" : "Fail"}</dd></div>
            </dl>
          </section>
        </div>
      )}
    </section>
  );
}
