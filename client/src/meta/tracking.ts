type PixelFn = (...args: unknown[]) => void;
declare global {
  interface Window {
    fbq?: PixelFn & { callMethod?: PixelFn; queue?: unknown[]; loaded?: boolean; version?: string };
    _fbq?: Window["fbq"];
    __aichmMarketingConsent?: boolean;
  }
}

export function setMarketingConsentActive(active: boolean) {
  window.__aichmMarketingConsent = active;
}

export function getMarketingAttribution() {
  if (typeof window === "undefined" || !window.__aichmMarketingConsent) return undefined;
  const params = new URLSearchParams(window.location.search);
  const get = (key: string, max = 180) => params.get(key)?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || undefined;
  const cookie = (name: string) => {
    const prefix = `${name}=`;
    const found = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return found ? decodeURIComponent(found.slice(prefix.length)).slice(0, 500) : undefined;
  };
  const fbclid = get("fbclid", 300);
  const fbc = cookie("_fbc") ?? (fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined);
  return {
    source: get("utm_source", 100),
    medium: get("utm_medium", 100),
    campaign: get("utm_campaign", 180),
    campaignId: get("campaign_id", 120),
    adId: get("ad_id", 120),
    adsetId: get("adset_id", 120),
    fbc,
    fbp: cookie("_fbp"),
  };
}

export function trackMetaEvent(eventName: string, eventId: string | null | undefined, customData: Record<string, string | number | boolean> = {}) {
  if (!window.__aichmMarketingConsent || !eventId || !window.fbq) return;
  const options = { eventID: eventId };
  if (eventName === "Lead") window.fbq("track", "Lead", customData, options);
  else if (eventName === "PageView") window.fbq("track", "PageView", customData, options);
  else window.fbq("trackCustom", eventName, customData, options);
}

export function newMetaEventId() {
  return crypto.randomUUID();
}
