import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { eq, inArray, sql } from "drizzle-orm";
import express from "express";
import { lmsAuthRateLimits, lmsUserRoles, lmsUsers, sessions } from "../../shared/lms-schema";
import { inquiries } from "../../shared/schema";

const testDatabaseUrl = process.env.LMS_AUTH_TEST_DATABASE_URL;
const integrationEnabled =
  process.env.NODE_ENV === "test" &&
  Boolean(testDatabaseUrl) &&
  process.env.LMS_AUTH_TEST_DB_WRITE_APPROVED === "I_ACKNOWLEDGE_THIS_IS_A_NONPRODUCTION_DATABASE";

test(
  "a real admin password login opens Leads, survives reload, and signs out to the dedicated login",
  {
    skip: integrationEnabled ? false : "Run npm run test:lms-admin for isolated PostgreSQL and browser verification.",
    timeout: 90_000,
  },
  async () => {
    const clientDirectory = resolve("dist/public");
    assert.ok(existsSync(resolve(clientDirectory, "index.html")), "Build the client before browser verification.");
    process.env.DATABASE_URL = testDatabaseUrl!;
    process.env.SESSION_SECRET = randomBytes(32).toString("hex");

    const [{ db, pool }, { registerRoutes }, security] = await Promise.all([
      import("../db"),
      import("../routes"),
      import("./password-security"),
    ]);
    const app = express();
    app.use(express.json());
    const server = createServer(app);
    const phone = `+999${randomInt(10_000_000, 99_999_999)}`;
    const password = randomBytes(24).toString("base64url");
    const ip = `198.51.100.${randomInt(1, 254)}`;
    const leadName = `Disposable admin verification lead ${randomInt(10_000, 99_999)}`;
    let userId: number | undefined;
    let inquiryId: number | undefined;
    let browser: Browser | undefined;

    try {
      const [account] = await db.insert(lmsUsers).values({
        phoneE164: phone,
        displayName: "Disposable browser admin",
        passwordHash: await security.hashLmsPassword(password),
      }).returning({ id: lmsUsers.id });
      userId = account.id;
      await db.insert(lmsUserRoles).values({ userId, role: "admin" });
      const [inquiry] = await db.insert(inquiries).values({
        name: leadName,
        email: "admin-session-test@example.invalid",
        phone,
        programInterest: "Barista Executive",
      }).returning({ id: inquiries.id });
      inquiryId = inquiry.id;

      await registerRoutes(server, app);
      app.use(express.static(clientDirectory));
      app.get("/{*path}", (_req, res) => res.sendFile(resolve(clientDirectory, "index.html")));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;

      browser = await chromium.launch();
      const context = await browser.newContext({
        baseURL: origin,
        extraHTTPHeaders: { "X-Forwarded-For": ip },
      });
      const page = await context.newPage();
      const visitedPaths: string[] = [];
      const pageErrors: string[] = [];
      let leadsRequests = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) visitedPaths.push(new URL(frame.url()).pathname);
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/admin/inquiries") leadsRequests += 1;
      });

      // No fabricated session or intercepted auth/lead responses: use the actual API and database.
      await page.goto("/admin");
      await expect(page.getByRole("link", { name: "Continue to sign in" })).toBeVisible();
      await expect(page.getByTestId("page-admin-dashboard")).toHaveCount(0);
      assert.equal(leadsRequests, 0, "signed-out visitors must not request lead records");
      assert.equal((await context.request.get(`${origin}/api/admin/inquiries`)).status(), 401);

      await page.getByRole("link", { name: "Continue to sign in" }).click();
      await expect(page).toHaveURL(`${origin}/admin/login`);
      await expect(page.getByRole("heading", { name: "Leads Dashboard sign in" })).toBeVisible();
      await page.getByLabel("Phone number").fill(phone);
      await page.getByLabel("Password").fill(password);
      const loggedIn = page.waitForResponse((response) =>
        response.url() === `${origin}/api/lms/auth/password/login` && response.request().method() === "POST",
      );
      const leadsLoaded = page.waitForResponse(`${origin}/api/admin/inquiries`);
      await page.getByRole("button", { name: "Sign in to Leads Dashboard" }).click();
      assert.equal((await loggedIn).status(), 200);
      await expect(page).toHaveURL(`${origin}/admin`);
      assert.equal((await leadsLoaded).status(), 200);
      await expect(page.getByTestId("page-admin-dashboard")).toBeVisible();
      await expect(page.getByText(leadName, { exact: true })).toBeVisible();
      const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "aroma.sid");
      assert.ok(sessionCookie, "password login must issue the real session cookie");
      assert.equal(sessionCookie.httpOnly, true);
      assert.equal(sessionCookie.sameSite, "Lax");
      assert.equal(sessionCookie.path, "/");
      const persistedSessions = await db.select({ sid: sessions.sid }).from(sessions)
        .where(sql`${sessions.sess}->>'lmsUserId' = ${String(userId)}`);
      assert.equal(persistedSessions.length, 1, "the session must be saved to PostgreSQL");

      const reloadedLeads = page.waitForResponse(`${origin}/api/admin/inquiries`);
      await page.reload();
      await expect(page).toHaveURL(`${origin}/admin`);
      assert.equal((await reloadedLeads).status(), 200);
      await expect(page.getByText(leadName, { exact: true })).toBeVisible();
      const restoredSession = await context.request.get(`${origin}/api/lms/auth/me`);
      assert.equal(restoredSession.status(), 200);
      assert.deepEqual((await restoredSession.json()).roles, ["admin"]);
      await page.screenshot({ path: "generated-artifacts/admin-session-dashboard.png" });

      // Opening the dedicated login with a saved admin session should not ask for a password again.
      await page.goto("/admin/login");
      await expect(page).toHaveURL(`${origin}/admin`);
      await expect(page.getByText(leadName, { exact: true })).toBeVisible();

      const loggedOut = page.waitForResponse(`${origin}/api/lms/auth/logout`);
      await page.getByTestId("admin-button-logout").click();
      assert.equal((await loggedOut).status(), 204);
      await expect(page).toHaveURL(`${origin}/admin/login`);
      await expect(page.getByRole("heading", { name: "Leads Dashboard sign in" })).toBeVisible();
      assert.equal((await context.cookies()).some((cookie) => cookie.name === "aroma.sid"), false);
      assert.equal((await context.request.get(`${origin}/api/admin/inquiries`)).status(), 401);
      assert.equal(await (await context.request.get(`${origin}/api/lms/auth/me`)).json(), null);
      const remainingSessions = await db.select({ sid: sessions.sid }).from(sessions)
        .where(sql`${sessions.sess}->>'lmsUserId' = ${String(userId)}`);
      assert.equal(remainingSessions.length, 0, "logout must destroy the saved session");
      await page.goto("/admin");
      await expect(page.getByRole("link", { name: "Continue to sign in" })).toBeVisible();
      await expect(page.getByTestId("page-admin-dashboard")).toHaveCount(0);
      assert.ok(visitedPaths.every((path) => !path.startsWith("/learn") && path !== "/lms-admin"),
        "the dedicated Leads flow must never redirect through LEAP");
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser?.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      try {
        if (userId !== undefined) {
          await db.delete(sessions).where(sql`${sessions.sess}->>'lmsUserId' = ${String(userId)}`);
          await db.delete(lmsUsers).where(eq(lmsUsers.id, userId));
        }
        if (inquiryId !== undefined) await db.delete(inquiries).where(eq(inquiries.id, inquiryId));
        await db.delete(lmsAuthRateLimits).where(inArray(lmsAuthRateLimits.keyHash, [
          security.hashAuthRateLimitKey("password-login-ip", ip),
          security.hashAuthRateLimitKey("password-login-phone", phone),
        ]));
      } finally {
        await pool.end();
      }
    }
  },
);
