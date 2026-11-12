import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { lmsAuditLogs, lmsAuthRateLimits, lmsUserRoles, lmsUsers } from "@shared/lms-schema";
import { issueLmsPasswordSetupLinkInTransaction } from "./password-auth";

const OWNER_PHONE = "+919687878669";
const MASKED_OWNER = "***8669";
const ORIGIN = "https://aromacafeinstitute.in";
const COMPLETE = "bootstrap.first_owner_created";
const LOCKED = "bootstrap.first_owner_locked";
const permanentActions = [COMPLETE, LOCKED, "bootstrap.admin_created"];
const bodySchema = z.object({
  phone: z.literal(OWNER_PHONE), secret: z.string().min(1).max(128),
  confirmOwner: z.literal(true),
}).strict();
const WINDOW = 15 * 60 * 1000;
type Database = typeof db;
type Configuration = { production: boolean; secret: string | undefined };

export function validBootstrapSecret(secret: string | undefined): secret is string {
  return !!secret && /^[A-Za-z0-9_-]{43,128}$/.test(secret) && new Set(secret).size >= 12;
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const matchSecret = (supplied: string, expected: string) =>
  timingSafeEqual(digest(supplied), digest(expected));

function protectResponse(res: Response) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Frame-Options", "DENY");
}

// Dependencies are internal test seams, not selected by HTTP input or runtime feature flags.
export function registerFirstOwnerRoutes(app: Express, options: {
  database?: Database; configuration?: () => Configuration;
} = {}) {
  const database = options.database ?? db;
  const configuration = options.configuration ?? (() => ({
    production: process.env.NODE_ENV === "production",
    secret: process.env.ADMIN_BOOTSTRAP_SECRET,
  }));
  const configured = () => {
    const config = configuration();
    return config.production && validBootstrapSecret(config.secret) ? config.secret : null;
  };
  const auditFailure = async (reason: string) => {
    await database.insert(lmsAuditLogs).values({
      action: "bootstrap.first_owner_failed", entityType: "first_owner_bootstrap",
      metadata: { reason, maskedOwner: MASKED_OWNER },
    });
  };
  async function unavailable() {
    const [admin] = await database.select({ id: lmsUserRoles.userId }).from(lmsUserRoles)
      .where(eq(lmsUserRoles.role, "admin")).limit(1);
    const [marker] = await database.select({ id: lmsAuditLogs.id }).from(lmsAuditLogs)
      .where(inArray(lmsAuditLogs.action, permanentActions)).limit(1);
    const [owner] = await database.select({ id: lmsUsers.id }).from(lmsUsers)
      .where(eq(lmsUsers.phoneE164, OWNER_PHONE)).limit(1);
    return !!(admin || marker || owner);
  }
  const trustedHost = (req: Request) => req.secure && req.get("host") === new URL(ORIGIN).host;
  const allowAttempt = async (req: Request, res: Response) => {
    const now = new Date();
    const bucket = async (identity: string) => {
      const keyHash = createHash("sha256").update(`first-owner:${identity}`).digest("hex");
      const [row] = await database.insert(lmsAuthRateLimits)
        .values({ keyHash, windowStartedAt: now, attempts: 1 })
        .onConflictDoUpdate({ target: lmsAuthRateLimits.keyHash, set: {
          windowStartedAt: sql`CASE WHEN ${lmsAuthRateLimits.windowStartedAt} <= ${new Date(now.getTime()-WINDOW)} THEN ${now} ELSE ${lmsAuthRateLimits.windowStartedAt} END`,
          attempts: sql`CASE WHEN ${lmsAuthRateLimits.windowStartedAt} <= ${new Date(now.getTime()-WINDOW)} THEN 1 ELSE ${lmsAuthRateLimits.attempts}+1 END`,
        }}).returning({ attempts: lmsAuthRateLimits.attempts });
      return row.attempts;
    };
    const localAttempts = await bucket(req.ip ?? "unknown");
    const globalAttempts = await bucket("global");
    if (localAttempts <= 5 && globalAttempts <= 30) return true;
    if ((localAttempts === 6 && globalAttempts <= 30) || globalAttempts === 31)
      await auditFailure("rate_limited");
    res.setHeader("Retry-After", "900");
    res.status(429).json({ message: "Too many owner setup attempts. Wait 15 minutes before trying again." });
    return false;
  };

  // Only this page receives extra privacy headers. Existing auth and PWA behavior is unchanged.
  app.use("/admin/first-owner", (_req, res, next) => { protectResponse(res); next(); });
  app.get("/api/admin/first-owner/status", async (req, res) => {
    protectResponse(res);
    if (!configured() || !trustedHost(req) || Object.keys(req.query).length)
      return res.status(404).json({ message: "First-owner setup is unavailable." });
    try {
      if (await unavailable()) return res.status(404).json({ message: "First-owner setup is unavailable. Use administrator sign-in or recovery." });
      return res.json({ available: true, maskedPhone: MASKED_OWNER });
    } catch {
      return res.status(503).json({ message: "Owner setup is temporarily unavailable. No changes were made." });
    }
  });

  app.post("/api/admin/first-owner", async (req, res) => {
    protectResponse(res);
    const expected = configured();
    if (!expected) return res.status(404).json({ message: "First-owner setup is unavailable." });
    try {
      // Persistent rate limits are separate from ordinary password-login buckets.
      if (!await allowAttempt(req, res)) return;
      if (!trustedHost(req) || req.get("origin") !== ORIGIN || Object.keys(req.query).length) {
        await auditFailure("untrusted_origin");
        return res.status(403).json({ message: "Use the secure owner setup page on the main Aroma Institute domain." });
      }
      const suppliedSecret = typeof req.body?.secret === "string" && req.body.secret.length <= 128
        ? req.body.secret : "";
      if (!matchSecret(suppliedSecret, expected)) {
        await auditFailure("verification_failed");
        return res.status(403).json({ message: "Owner verification failed. No account was changed." });
      }
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        await auditFailure("invalid_request");
        return res.status(400).json({ message: "Enter the approved owner phone ending 8669, confirm it, and supply the bootstrap secret." });
      }
      const result = await database.transaction(async tx => {
        // Serialize bootstrap attempts, and block concurrent role writes until commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(891762, 1)`);
        const [admin] = await tx.select({ id: lmsUserRoles.userId }).from(lmsUserRoles)
          .where(eq(lmsUserRoles.role, "admin")).limit(1);
        const [marker] = await tx.select({ id: lmsAuditLogs.id }).from(lmsAuditLogs)
          .where(inArray(lmsAuditLogs.action, permanentActions)).limit(1);
        if (admin || marker) {
          await tx.insert(lmsAuditLogs).values({ action: LOCKED, entityType: "first_owner_bootstrap",
            metadata: { reason: "bootstrap_closed", maskedOwner: MASKED_OWNER } });
          return { error: "First-owner setup is permanently closed. Use administrator sign-in or recovery." };
        }
        const [existing] = await tx.select({ id: lmsUsers.id }).from(lmsUsers)
          .where(eq(lmsUsers.phoneE164, OWNER_PHONE)).limit(1);
        if (existing) {
          await tx.insert(lmsAuditLogs).values({ action: LOCKED, entityType: "first_owner_bootstrap",
            metadata: { reason: "owner_already_exists", maskedOwner: MASKED_OWNER } });
          return { error: "Owner account ***8669 already exists. It was not modified. Use administrator recovery." };
        }
        const [owner] = await tx.insert(lmsUsers).values({
          phoneE164: OWNER_PHONE, displayName: "AICHM Owner", isActive: true,
        }).returning({ id: lmsUsers.id });
        await tx.insert(lmsUserRoles).values({ userId: owner.id, role: "admin" });
        const setup = await issueLmsPasswordSetupLinkInTransaction(tx, owner.id);
        await tx.insert(lmsAuditLogs).values({
          actorId: owner.id, action: COMPLETE, entityType: "user", entityId: String(owner.id),
          metadata: { maskedOwner: MASKED_OWNER, method: "secret_protected_first_owner",
            setupExpiresAt: setup.expiresAt.toISOString() },
        });
        return { setupUrl: `${ORIGIN}${setup.setupPath}`, expiresAt: setup.expiresAt.toISOString(),
          maskedPhone: MASKED_OWNER };
      });
      if ("error" in result) return res.status(409).json({ message: result.error });
      return res.status(201).json(result);
    } catch {
      // Never log exception objects, bodies, supplied identifiers, secrets or setup URLs.
      try { await auditFailure("transaction_failed"); } catch { /* unavailable audit store */ }
      return res.status(503).json({ message: "Owner setup could not complete. Do not assume an account was created; contact the app owner before retrying." });
    } finally {
      // Minimize secret lifetime on the request object; never pass it to downstream handlers.
      if (req.body && typeof req.body === "object") delete req.body.secret;
      delete (req as Request & { rawBody?: unknown }).rawBody;
    }
  });

  // Body-parser errors can quote raw JSON. Intercept before the generic error logger.
  app.use("/api/admin/first-owner", async (_error: unknown, req: Request, res: Response, _next: import("express").NextFunction) => {
    protectResponse(res);
    if (req.body && typeof req.body === "object") delete req.body.secret;
    delete (req as Request & { rawBody?: unknown }).rawBody;
    if (!configured()) return res.status(404).json({ message: "First-owner setup is unavailable." });
    try {
      if (!await allowAttempt(req, res)) return;
      await auditFailure("invalid_body");
    } catch {
      return res.status(503).json({ message: "Owner setup is temporarily unavailable." });
    }
    return res.status(400).json({ message: "Invalid owner setup request. No account was changed." });
  });
}
