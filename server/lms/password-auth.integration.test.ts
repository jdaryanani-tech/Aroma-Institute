import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  lmsAuthRateLimits,
  lmsPasswordSetupTokens,
  lmsUserRoles,
  lmsUsers,
  sessions,
} from "../../shared/lms-schema";
import {
  hashAuthRateLimitKey,
  hashPasswordSetupToken,
  normalizeLmsPhone,
} from "./password-security";

const writeApproval = "I_ACKNOWLEDGE_THIS_IS_A_NONPRODUCTION_DATABASE";
const testDatabaseUrl = process.env.LMS_AUTH_TEST_DATABASE_URL;
const integrationEnabled =
  process.env.NODE_ENV === "test" &&
  Boolean(testDatabaseUrl) &&
  process.env.LMS_AUTH_TEST_DB_WRITE_APPROVED === writeApproval;

function makeTestPhone() {
  return `+999${randomInt(10_000_000, 99_999_999)}`;
}

function makeTestIp() {
  return `198.51.100.${randomInt(1, 254)}`;
}

function sessionIdFromCookie(cookie: string) {
  const cookieValue = cookie.split(";", 1)[0]?.slice("aroma.sid=".length);
  if (!cookieValue) return null;
  const decoded = decodeURIComponent(cookieValue);
  return /^s:([^.]*)\./.exec(decoded)?.[1] ?? null;
}

test(
  "password setup, expiry, rate limits, generic failures, and role sessions work end to end",
  { skip: integrationEnabled ? false : "Set an isolated LMS_AUTH_TEST_DATABASE_URL and explicit non-production write approval to run database integration tests." },
  async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testDatabaseUrl!;

    const [{ db, pool }, { configureLmsSessions }, { registerLmsRoutes }, { issueLmsPasswordSetupLink }, security] =
      await Promise.all([
        import("../db"),
        import("./auth"),
        import("./routes"),
        import("./password-auth"),
        import("./password-security"),
      ]);
    const app = express();
    app.use(express.json());
    configureLmsSessions(app);
    registerLmsRoutes(app);

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const userIds: number[] = [];
    const rateLimitKeys = new Set<string>();
    const sessionIds = new Set<string>();
    const activeCookies = new Set<string>();
    const password = "Aroma-Auth-Test-Password-2026!";

    function trackLoginRateKeys(phone: string, ip: string) {
      const normalizedPhone = normalizeLmsPhone(phone);
      assert.ok(normalizedPhone);
      rateLimitKeys.add(hashAuthRateLimitKey("password-login-ip", ip));
      rateLimitKeys.add(hashAuthRateLimitKey("password-login-phone", normalizedPhone));
    }

    async function createAccount(options: {
      roles?: Array<"student" | "trainer" | "admin">;
      active?: boolean;
      withPassword?: boolean;
    }) {
      const phone = makeTestPhone();
      const [user] = await db
        .insert(lmsUsers)
        .values({
          phoneE164: phone,
          displayName: `Disposable auth test ${userIds.length + 1}`,
          isActive: options.active ?? true,
          passwordHash: options.withPassword === false ? null : await security.hashLmsPassword(password),
        })
        .returning({ id: lmsUsers.id });
      userIds.push(user.id);
      if (options.roles?.length) {
        await db.insert(lmsUserRoles).values(options.roles.map((role) => ({ userId: user.id, role })));
      }
      return { id: user.id, phone };
    }

    async function request(
      method: "GET" | "POST",
      path: string,
      options: { body?: unknown; ip?: string; cookie?: string } = {},
    ) {
      const ip = options.ip ?? makeTestIp();
      if (method === "POST" && path === "/api/lms/auth/password/login") {
        const phone = (options.body as { phone: string }).phone;
        trackLoginRateKeys(phone, ip);
      } else if (method === "POST" && path === "/api/lms/auth/password/setup") {
        rateLimitKeys.add(hashAuthRateLimitKey("password-setup-ip", ip));
      }
      const headers: Record<string, string> = {
        Origin: origin,
        "X-Forwarded-For": ip,
      };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.cookie) headers.Cookie = options.cookie;
      return fetch(`${origin}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    }

    async function login(phone: string, pass: string, ip = makeTestIp()) {
      return request("POST", "/api/lms/auth/password/login", {
        body: { phone, password: pass },
        ip,
      });
    }

    async function rememberSession(response: Response) {
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie, "successful login should establish a session cookie");
      activeCookies.add(cookie);
      const sessionId = sessionIdFromCookie(cookie);
      assert.ok(sessionId, "session cookie should contain a session id");
      sessionIds.add(sessionId);
      return cookie;
    }

    async function logout(cookie: string) {
      const response = await request("POST", "/api/lms/auth/logout", { cookie });
      assert.equal(response.status, 204);
      activeCookies.delete(cookie);
    }

    try {
      const setupAccount = await createAccount({ roles: ["student"], withPassword: false });
      const expiredLink = await issueLmsPasswordSetupLink(setupAccount.id);
      const expiredToken = new URL(expiredLink.setupPath, origin).hash.slice("#token=".length);
      await db
        .update(lmsPasswordSetupTokens)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(lmsPasswordSetupTokens.tokenHash, hashPasswordSetupToken(expiredToken)));

      const expiredResponse = await request("POST", "/api/lms/auth/password/setup", {
        body: { token: expiredToken, password },
      });
      assert.equal(expiredResponse.status, 400);
      assert.deepEqual(await expiredResponse.json(), { message: "This setup link is invalid or expired." });
      const [stillUnset] = await db
        .select({ passwordHash: lmsUsers.passwordHash })
        .from(lmsUsers)
        .where(eq(lmsUsers.id, setupAccount.id));
      assert.equal(stillUnset.passwordHash, null);

      const activeLink = await issueLmsPasswordSetupLink(setupAccount.id);
      const activeToken = new URL(activeLink.setupPath, origin).hash.slice("#token=".length);
      const setupResponse = await request("POST", "/api/lms/auth/password/setup", {
        body: { token: activeToken, password },
      });
      assert.equal(setupResponse.status, 200);
      assert.equal(setupResponse.headers.get("set-cookie"), null, "setting a password must not create a session");
      assert.deepEqual(await setupResponse.json(), { message: "Password set. You can now sign in." });

      const reusedResponse = await request("POST", "/api/lms/auth/password/setup", {
        body: { token: activeToken, password: "Another-Auth-Test-Password-2026!" },
      });
      assert.equal(reusedResponse.status, 400);
      assert.deepEqual(await reusedResponse.json(), { message: "This setup link is invalid or expired." });

      const setupLoginIp = makeTestIp();
      const setupLogin = await login(setupAccount.phone, password, setupLoginIp);
      assert.equal(setupLogin.status, 200);
      const setupCookie = await rememberSession(setupLogin);
      await logout(setupCookie);

      const inactiveAccount = await createAccount({ roles: ["student"], active: false });
      const rolelessAccount = await createAccount({ roles: [] });
      const unknownPhone = makeTestPhone();
      const failureIp = makeTestIp();
      const failureAttempts = await Promise.all([
        login(unknownPhone, password, failureIp),
        login(inactiveAccount.phone, password, failureIp),
        login(rolelessAccount.phone, password, failureIp),
      ]);
      const failureBodies = await Promise.all(failureAttempts.map(async (response) => ({
        status: response.status,
        body: await response.json(),
        setCookie: response.headers.get("set-cookie"),
      })));
      assert.deepEqual(failureBodies.map(({ status }) => status), [401, 401, 401]);
      assert.deepEqual(
        failureBodies.map(({ body }) => body),
        [
          { message: "Phone number or password is incorrect." },
          { message: "Phone number or password is incorrect." },
          { message: "Phone number or password is incorrect." },
        ],
      );
      assert.ok(failureBodies.every(({ setCookie }) => setCookie === null));

      const wrongPasswordAccount = await createAccount({ roles: ["student"] });
      const wrongPasswordIp = makeTestIp();
      const wrongPassword = await login(wrongPasswordAccount.phone, "incorrect password", wrongPasswordIp);
      assert.equal(wrongPassword.status, 401);
      assert.deepEqual(await wrongPassword.json(), { message: "Phone number or password is incorrect." });
      assert.equal(wrongPassword.headers.get("set-cookie"), null);

      const rateLimitedAccount = await createAccount({ roles: ["student"] });
      const rateLimitIp = makeTestIp();
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const response = await login(rateLimitedAccount.phone, "incorrect password", rateLimitIp);
        assert.equal(response.status, 401, `failed attempt ${attempt} should remain generic`);
      }
      const rateLimitedResponse = await login(rateLimitedAccount.phone, "incorrect password", rateLimitIp);
      assert.equal(rateLimitedResponse.status, 429);
      assert.deepEqual(await rateLimitedResponse.json(), { message: "Too many sign-in attempts. Try again later." });
      assert.equal(rateLimitedResponse.headers.get("set-cookie"), null);

      for (const role of ["student", "trainer", "admin"] as const) {
        const account = await createAccount({ roles: [role] });
        const response = await login(account.phone, password);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).roles, [role]);
        const cookie = await rememberSession(response);
        const sessionResponse = await request("GET", "/api/lms/auth/me", { cookie });
        assert.equal(sessionResponse.status, 200);
        assert.deepEqual((await sessionResponse.json()).roles, [role]);
        await logout(cookie);
        const afterLogout = await request("GET", "/api/lms/auth/me", { cookie });
        assert.equal(await afterLogout.json(), null);
      }
    } finally {
      for (const cookie of activeCookies) {
        try {
          await request("POST", "/api/lms/auth/logout", { cookie });
        } catch {
          // The explicit session-row cleanup below is the fallback for failed logout requests.
        }
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (sessionIds.size) {
        await db.delete(sessions).where(inArray(sessions.sid, [...sessionIds]));
      }
      if (userIds.length) {
        await db.delete(lmsUsers).where(inArray(lmsUsers.id, userIds));
      }
      if (rateLimitKeys.size) {
        await db
          .delete(lmsAuthRateLimits)
          .where(inArray(lmsAuthRateLimits.keyHash, [...rateLimitKeys]));
      }
      await pool.end();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  },
);
