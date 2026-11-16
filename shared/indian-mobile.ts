export type IndianMobileNormalizationOutcome =
  | "valid"
  | "invalid_characters"
  | "invalid_length"
  | "invalid_mobile_prefix";

export function inspectIndianMobile(value: string): {
  canonical: string | null;
  outcome: IndianMobileNormalizationOutcome;
} {
  if (!/^\+?[\d\s().-]+$/.test(value.trim())) {
    return { canonical: null, outcome: "invalid_characters" };
  }
  let digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (!/^\d{10}$/.test(digits)) return { canonical: null, outcome: "invalid_length" };
  if (!/^[6-9]/.test(digits)) return { canonical: null, outcome: "invalid_mobile_prefix" };
  return { canonical: `91${digits}`, outcome: "valid" };
}

/** Same canonical form used by n8n: 91 followed by a ten-digit Indian mobile. */
export function normalizeIndianMobile(value: string): string | null {
  return inspectIndianMobile(value).canonical;
}
