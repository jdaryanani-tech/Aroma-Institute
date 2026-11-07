import { useEffect, useState } from "react";

type MetaStatus = {
  schemaReady: boolean;
  pixelConfigured: boolean;
  capiEnabled: boolean;
  leadAdsConfigured: boolean;
  missingConfiguration: Record<string, string[] | string>;
  outbox: Record<string, number> | null;
};

export default function MetaSetupStatus() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/admin/meta/status", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<MetaStatus> : Promise.reject())
      .then((data) => { if (active) setStatus(data); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  if (failed) return (
    <section className="crm-warning" role="status" data-testid="meta-setup-status">
      Meta integration status is unavailable. Check administrator access. No credential values are shown.
    </section>
  );
  const missing = status?.missingConfiguration ?? {};
  return (
    <section className="crm-counts" aria-labelledby="meta-setup-title" data-testid="meta-setup-status">
      <div className="crm-count" style={{ gridColumn: "1 / -1" }}>
        <span className="crm-count-label">Meta lead capture and measurement</span>
        <strong id="meta-setup-title" className="crm-count-value" style={{ fontSize: "1.15rem" }}>
          {!status ? "Checking readiness" : status.pixelConfigured || status.capiEnabled || status.leadAdsConfigured ? "Partially configured" : "Safely disabled"}
        </strong>
        {status && <span className="crm-count-note">
          New schema {status.schemaReady ? "ready" : "migration required"} · Pixel {status.pixelConfigured ? "configured" : "off"} · CAPI {status.capiEnabled ? "enabled" : "off"} · Instant Forms {status.leadAdsConfigured ? "configured" : "off"}
          {status.outbox && ` · Outbox: ${status.outbox.pending ?? 0} pending, ${status.outbox.failed ?? 0} failed, ${status.outbox.sent ?? 0} sent`}
        </span>}
        {Object.entries(missing).map(([integration, names]) => {
          const list = Array.isArray(names) ? names : [names];
          return list.length ? <span className="crm-count-note" key={integration}>
            {integration === "capiFlag" ? "CAPI enable gate: " : `${integration}: `}{list.join(", ")}
          </span> : null;
        })}
        <span className="crm-count-note">Payment and enrollment events remain off until a verified payment source is connected. Configure only in server-side Replit Secrets.</span>
      </div>
    </section>
  );
}
