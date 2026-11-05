/** Same canonical form used by n8n: 91 followed by a ten-digit Indian mobile. */
export function normalizeIndianMobile(value: string): string | null {
  if (!/^\+?[\d\s().-]+$/.test(value.trim())) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : null;
}
