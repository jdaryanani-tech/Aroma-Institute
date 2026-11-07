import { createHash } from "node:crypto";
import type { Request } from "express";
import { isPublicAdmissionsPath } from "./config";

const digest = (value: string) => createHash("sha256").update(value).digest();
export const visitorKey = (req: Request) => digest(req.sessionID ?? "").toString("hex");

function hostAllowed(host: string) {
  const normalized = host.toLowerCase().split(":")[0];
  const configured = (process.env.REPLIT_DOMAINS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return normalized === "aromacafeinstitute.in"
    || normalized === "training.aromacafeinstitute.in"
    || configured.includes(normalized)
    || (process.env.NODE_ENV === "test" && ["localhost", "127.0.0.1"].includes(normalized));
}

export function safeMetaEventSourceUrl(req: Request, _fallbackPath: string) {
  const host = (req.get("host") ?? "").toLowerCase();
  if (!hostAllowed(host)) return null;
  const referrer = req.get("referer");
  if (!referrer) return null;
  try {
    const parsed = new URL(referrer);
    if (parsed.host.toLowerCase() !== host || !isPublicAdmissionsPath(parsed.pathname)) return null;
    return `https://${host}${parsed.pathname}`;
  } catch {
    return null;
  }
}
