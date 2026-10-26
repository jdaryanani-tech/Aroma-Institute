import type { Express, NextFunction, Request, Response } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { and, eq } from "drizzle-orm";
import { lmsUserRoles, lmsUsers } from "@shared/lms-schema";
import { db, pool } from "../db";

export type LmsRole = "student" | "trainer" | "admin";

declare module "express-session" {
  interface SessionData {
    lmsUserId?: number;
  }
}

declare global {
  namespace Express {
    interface Request {
      lmsUser?: {
        id: number;
        phoneE164: string;
        displayName: string | null;
        roles: LmsRole[];
      };
    }
  }
}

const PgSessionStore = connectPgSimple(session);

export function configureLmsSessions(app: Express) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required for LMS sessions.");
  }

  app.set("trust proxy", 1);
  app.use(
    session({
      name: "aroma.sid",
      secret,
      store: new PgSessionStore({
        pool,
        tableName: "sessions",
        createTableIfMissing: false,
        pruneSessionInterval: 15 * 60,
      }),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
      },
    }),
  );
}

export async function establishLmsSession(req: Request, userId: number) {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
  req.session.lmsUserId = userId;
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

export async function destroyLmsSession(req: Request) {
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

export async function requireLmsUser(req: Request, res: Response, next: NextFunction) {
  const userId = req.session?.lmsUserId;
  if (!userId) {
    return res.status(401).json({ message: "Authentication required" });
  }

  try {
    const [user] = await db
      .select({
        id: lmsUsers.id,
        phoneE164: lmsUsers.phoneE164,
        displayName: lmsUsers.displayName,
      })
      .from(lmsUsers)
      .where(and(eq(lmsUsers.id, userId), eq(lmsUsers.isActive, true)))
      .limit(1);

    if (!user) {
      await destroyLmsSession(req);
      return res.status(401).json({ message: "Authentication required" });
    }

    const assignments = await db
      .select({ role: lmsUserRoles.role })
      .from(lmsUserRoles)
      .where(eq(lmsUserRoles.userId, user.id));

    req.lmsUser = {
      ...user,
      roles: assignments.map(({ role }) => role),
    };
    return next();
  } catch {
    return res.status(500).json({ message: "Unable to validate session" });
  }
}

export function optionalLmsUser(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.lmsUserId) return next();
  return requireLmsUser(req, res, next);
}

export function requireLmsRole(...allowedRoles: LmsRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.lmsUser) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!allowedRoles.some((role) => req.lmsUser?.roles.includes(role))) {
      return res.status(403).json({ message: "You do not have permission to access this resource" });
    }
    return next();
  };
}
