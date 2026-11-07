import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { isPublicAdmissionsPath } from "./scope";
import { newMetaEventId, setMarketingConsentActive, trackMetaEvent } from "./tracking";
import "./meta.css";

type ConsentStatus = "unknown" | "granted" | "denied" | "withdrawn" | "unavailable";
type ConsentResponse = { status?: ConsentStatus; policyVersion?: string | null };
type PixelConfig = { enabled?: boolean; pixelId?: string };

async function requestConsent(status: "granted" | "denied" | "withdrawn") {
  const response = await fetch("/api/marketing/consent", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error("consent_unavailable");
  return await response.json() as ConsentResponse;
}

function installPixel(pixelId: string) {
  if (window.fbq) return;
  const fbq: NonNullable<Window["fbq"]> = Object.assign(function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else (fbq.queue ??= []).push(args);
  }, { queue: [] as unknown[], loaded: true, version: "2.0" });
  window.fbq = fbq;
  window._fbq = fbq;
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://connect.facebook.net/en_US/fbevents.js";
  script.dataset.aichmMetaPixel = "true";
  document.head.appendChild(script);
  window.fbq("init", pixelId);
}

function removePixelCookies() {
  const names = ["_fbp", "_fbc"];
  const host = location.hostname.split(".");
  const domains = ["", ...(host.length > 2 ? [`.${host.slice(-2).join(".")}`] : [])];
  for (const name of names) for (const domain of domains) {
    document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax${domain ? `; domain=${domain}` : ""}`;
  }
}

export default function MetaMarketing() {
  const [locationPath] = useLocation();
  const [status, setStatus] = useState<ConsentStatus>("unknown");
  const [showPanel, setShowPanel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const pixelIdRef = useRef("");
  const currentPath = locationPath === "/" ? "/" : locationPath.split("?")[0];

  useEffect(() => {
    let active = true;
    fetch("/api/marketing/consent", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<ConsentResponse> : Promise.reject())
      .then((data) => {
        if (!active) return;
        const next = ["granted", "denied", "withdrawn", "unavailable"].includes(data.status ?? "") ? data.status! : "unknown";
        setStatus(next);
        setMarketingConsentActive(next === "granted");
      })
      .catch(() => { if (active) setStatus("unavailable"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (status !== "granted" || !isPublicAdmissionsPath(currentPath)) {
      setMarketingConsentActive(false);
      return;
    }
    let active = true;
    fetch("/api/marketing/pixel-config", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.json() as Promise<PixelConfig>)
      .then(async (config) => {
        if (!active || !config.enabled || !config.pixelId) return;
        if (pixelIdRef.current && pixelIdRef.current !== config.pixelId) return;
        pixelIdRef.current = config.pixelId;
        installPixel(config.pixelId);
        const eventId = newMetaEventId();
        const response = await fetch("/api/marketing/pageview", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId }),
        });
        if (active && response.ok) trackMetaEvent("PageView", eventId);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [currentPath, status]);

  const choose = async (next: "granted" | "denied" | "withdrawn") => {
    setSaving(true);
    setMessage("");
    try {
      await requestConsent(next);
      setStatus(next);
      setMarketingConsentActive(next === "granted");
      if (next !== "granted") {
        window.fbq?.("consent", "revoke");
        document.querySelectorAll('script[data-aichm-meta-pixel="true"]').forEach((node) => node.remove());
        delete window.fbq;
        delete window._fbq;
        pixelIdRef.current = "";
        removePixelCookies();
      }
      setShowPanel(false);
    } catch {
      setMessage("Your choice could not be saved. Optional marketing measurement remains off.");
      setMarketingConsentActive(false);
    } finally {
      setSaving(false);
    }
  };

  if (!isPublicAdmissionsPath(currentPath)) return null;
  return (
    <aside className="meta-consent" aria-label="Optional marketing measurement settings">
      {showPanel || status === "unknown" || status === "unavailable" ? (
        <div className="meta-consent-card" role="region" aria-labelledby="meta-consent-title">
          <div>
            <strong id="meta-consent-title">Optional marketing measurement</strong>
            <p>Allow Meta measurement cookies to help us understand admissions-page performance. This is optional and separate from WhatsApp contact consent.</p>
            {status === "unavailable" && <p role="status">Preference storage is unavailable, so optional measurement stays off.</p>}
            {message && <p role="alert">{message}</p>}
          </div>
          <div className="meta-consent-actions">
            <button type="button" disabled={saving || status === "unavailable"} onClick={() => void choose("granted")}>Allow optional measurement</button>
            <button type="button" disabled={saving || status === "unavailable"} onClick={() => void choose("denied")}>Reject optional measurement</button>
          </div>
        </div>
      ) : (
        <button type="button" className="meta-consent-settings" onClick={() => setShowPanel(true)}>Privacy settings</button>
      )}
      {status === "granted" && showPanel && (
        <button type="button" className="meta-consent-withdraw" disabled={saving} onClick={() => void choose("withdrawn")}>Withdraw measurement consent</button>
      )}
    </aside>
  );
}
