import type { Express } from "express";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  lmsAuthRateLimits,
  lmsPasswordSetupTokens,
  lmsUserRoles,
  lmsUsers,
} from "@shared/lms-schema";
import { db } from "../db";
import { establishLmsSession } from "./auth";
import {
  createPasswordSetupToken,
  hashAuthRateLimitKey,
  hashLmsPassword,
  hashPasswordSetupToken,
  normalizeLmsPhone,
  verifyLmsPassword,
  verifyLmsPasswordAgainstDummy,
} from "./password-security";

const WINDOW_MS = 15 * 60 * 1000;
const IP_LOGIN_LIMIT = 60;
const PHONE_LOGIN_LIMIT = 8;
const SETUP_IP_LIMIT = 30;
const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  phone: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
});

const setPasswordSchema = z.object({
  token: z.string().min(20).max(256),
  password: z.string().min(12).max(128),
});

function accountResponse(user: {
  id: number;
  phoneE164: string;
  displayName: string | null;
}, roles: string[]) {
  return {
    id: user.id,
    phoneE164: user.phoneE164,
    displayName: user.displayName,
    roles,
  };
}

async function recordAttempt(keyHash: string, now: Date) {
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const [bucket] = await db
    .insert(lmsAuthRateLimits)
    .values({ keyHash, windowStartedAt: now, attempts: 1 })
    .onConflictDoUpdate({
      target: lmsAuthRateLimits.keyHash,
      set: {
        windowStartedAt: sql`
          CASE
            WHEN ${lmsAuthRateLimits.windowStartedAt} <= ${windowStart}
            THEN ${now}
            ELSE ${lmsAuthRateLimits.windowStartedAt}
          END
        `,
        attempts: sql`
          CASE
            WHEN ${lmsAuthRateLimits.windowStartedAt} <= ${windowStart}
            THEN 1
            ELSE ${lmsAuthRateLimits.attempts} + 1
          END
        `,
      },
    })
    .returning({ attempts: lmsAuthRateLimits.attempts });
  return bucket.attempts;
}

async function clearOldRateLimits(now: Date) {
  await db
    .delete(lmsAuthRateLimits)
    .where(lt(lmsAuthRateLimits.windowStartedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
}

async function resetAccountRateLimit(keyHash: string, now: Date) {
  await db
    .update(lmsAuthRateLimits)
    .set({ windowStartedAt: now, attempts: 0 })
    .where(eq(lmsAuthRateLimits.keyHash, keyHash));
}

async function loadRoles(userId: number) {
  const assignments = await db
    .select({ role: lmsUserRoles.role })
    .from(lmsUserRoles)
    .where(eq(lmsUserRoles.userId, userId));
  return assignments.map(({ role }) => role);
}

export async function issueLmsPasswordSetupLink(userId: number) {
  const { token, tokenHash } = createPasswordSetupToken();
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_MS);
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: lmsUsers.id })
      .from(lmsUsers)
      .where(and(eq(lmsUsers.id, userId), eq(lmsUsers.isActive, true)))
      .for("update")
      .limit(1);
    if (!user) throw new Error("USER_NOT_FOUND");

    await tx
      .delete(lmsPasswordSetupTokens)
      .where(lt(lmsPasswordSetupTokens.expiresAt, new Date()));
    await tx
      .update(lmsPasswordSetupTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(lmsPasswordSetupTokens.userId, userId),
          isNull(lmsPasswordSetupTokens.consumedAt),
        ),
      );
    await tx.insert(lmsPasswordSetupTokens).values({
      userId,
      tokenHash,
      expiresAt,
    });
  });
  return {
    setupPath: `/learn/setup#token=${token}`,
    expiresAt,
  };
}

export function registerLmsPasswordAuthRoutes(app: Express) {
  app.post("/api/lms/auth/password/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Enter a valid phone number and password." });
    }

    try {
      const now = new Date();
      const ipKey = hashAuthRateLimitKey("password-login-ip", req.ip || "unknown");
      const ipAttempts = await recordAttempt(ipKey, now);
      if (ipAttempts > IP_LOGIN_LIMIT) {
        return res.status(429).json({ message: "Too many sign-in attempts. Try again later." });
      }

      const normalizedPhone = normalizeLmsPhone(parsed.data.phone);
      const accountKey = hashAuthRateLimitKey(
        "password-login-phone",
        normalizedPhone ?? parsed.data.phone.slice(0, 32),
      );
      const accountAttempts = await recordAttempt(accountKey, now);
      if (accountAttempts > PHONE_LOGIN_LIMIT) {
        return res.status(429).json({ message: "Too many sign-in attempts. Try again later." });
      }

      if (Math.random() < 0.02) await clearOldRateLimits(now);
      const [user] = normalizedPhone
        ? await db
            .select({
              id: lmsUsers.id,
              phoneE164: lmsUsers.phoneE164,
              displayName: lmsUsers.displayName,
              passwordHash: lmsUsers.passwordHash,
              isActive: lmsUsers.isActive,
            })
            .from(lmsUsers)
            .where(eq(lmsUsers.phoneE164, normalizedPhone))
            .limit(1)
        : [];

      const validPassword = user?.passwordHash
        ? await verifyLmsPassword(parsed.data.password, user.passwordHash)
        : await verifyLmsPasswordAgainstDummy(parsed.data.password);
      if (!user || !user.isActive || !user.passwordHash || !validPassword) {
        return res.status(401).json({ message: "Phone number or password is incorrect." });
      }

      const roles = await loadRoles(user.id);
      if (!roles.length) {
        return res.status(401).json({ message: "Phone number or password is incorrect." });
      }

      await resetAccountRateLimit(accountKey, now);
      await establishLmsSession(req, user.id);
      return res.json(accountResponse(user, roles));
    } catch {
      return res.status(500).json({ message: "Unable to sign in right now." });
    }
  });

  app.post("/api/lms/auth/password/setup", async (req, res) => {
    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "This setup link is invalid or expired." });
    }

    try {
      const now = new Date();
      const ipKey = hashAuthRateLimitKey("password-setup-ip", req.ip || "unknown");
      if ((await recordAttempt(ipKey, now)) > SETUP_IP_LIMIT) {
        return res.status(429).json({ message: "Too many attempts. Try again later." });
      }

      const tokenHash = hashPasswordSetupToken(parsed.data.token);
      const [candidate] = await db
        .select({ id: lmsPasswordSetupTokens.id })
        .from(lmsPasswordSetupTokens)
        .innerJoin(lmsUsers, eq(lmsPasswordSetupTokens.userId, lmsUsers.id))
        .where(
          and(
            eq(lmsPasswordSetupTokens.tokenHash, tokenHash),
            gt(lmsPasswordSetupTokens.expiresAt, now),
            isNull(lmsPasswordSetupTokens.consumedAt),
            eq(lmsUsers.isActive, true),
          ),
        )
        .limit(1);
      if (!candidate) {
        return res.status(400).json({ message: "This setup link is invalid or expired." });
      }

      const passwordHash = await hashLmsPassword(parsed.data.password);
      const userId = await db.transaction(async (tx) => {
        const [setup] = await tx
          .select({
            id: lmsPasswordSetupTokens.id,
            userId: lmsPasswordSetupTokens.userId,
          })
          .from(lmsPasswordSetupTokens)
          .innerJoin(lmsUsers, eq(lmsPasswordSetupTokens.userId, lmsUsers.id))
          .where(
            and(
              eq(lmsPasswordSetupTokens.tokenHash, tokenHash),
              gt(lmsPasswordSetupTokens.expiresAt, now),
              isNull(lmsPasswordSetupTokens.consumedAt),
              eq(lmsUsers.isActive, true),
            ),
          )
          .for("update")
          .limit(1);
        if (!setup) return null;

        await tx
          .update(lmsUsers)
          .set({ passwordHash, updatedAt: now })
          .where(and(eq(lmsUsers.id, setup.userId), eq(lmsUsers.isActive, true)));
        await tx
          .update(lmsPasswordSetupTokens)
          .set({ consumedAt: now })
          .where(eq(lmsPasswordSetupTokens.id, setup.id));
        return setup.userId;
      });

      if (!userId) {
        return res.status(400).json({ message: "This setup link is invalid or expired." });
      }

      return res.json({ message: "Password set. You can now sign in." });
    } catch {
      return res.status(500).json({ message: "Unable to set your password right now." });
    }
  });
}
