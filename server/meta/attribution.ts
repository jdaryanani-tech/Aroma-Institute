import type { MetaAttribution } from "./events";

const cleanText = (value: unknown, max: number) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || null
  : null;
const cleanId = (value: unknown) => {
  const text = cleanText(value, 120);
  return text && /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
};

export function parseMetaAttribution(value: unknown): MetaAttribution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return {
    source: cleanText(input.source, 100),
    medium: cleanText(input.medium, 100),
    campaign: cleanText(input.campaign, 180),
    campaignId: cleanId(input.campaignId),
    adId: cleanId(input.adId),
    adsetId: cleanId(input.adsetId),
    formId: cleanId(input.formId),
    fbc: cleanText(input.fbc, 500),
    fbp: cleanText(input.fbp, 500),
  };
}
