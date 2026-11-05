import { expect, test, type Page } from "@playwright/test";

const caps = {
  identityTracking: true,
  videoTracking: true,
  crmPersistence: true,
  calendarBookingVerification: false,
  chatHistory: false,
} as const;
const overview = {
  identifiedPeople: 14, unresolvedRecords: 3, totalEnquiries: 19,
  stageCounts: {
    new_enquiry: 5, contacted: 2, qualified: 1, vsl_shared: 1, vsl_watched: 1,
    form_submitted: 1, counselling_pending: 1, counselling_booked: 0,
    counselling_attended: 0, enrolled: 1, nurture: 1, lost: 0,
  },
  registeredPeople: 8, videoStarted: 5, videoWatched: 3, verifiedForms: 2,
  registeredWithForm: 2, registeredWithoutForm: 6, registeredToFormPercent: 25, enrolledPercent: 7.1,
};
const people = Array.from({ length: 14 }, (_, index) => ({
  id: `person-${index + 1}`, leadId: null, name: `Prospect ${String(index + 1).padStart(2, "0")}`,
  phone: `+919876500${String(index + 1).padStart(2, "0")}`, email: `prospect${index + 1}@example.test`,
  programs: ["Barista Foundations"], sources: ["VSL registration"], stage: "new_enquiry" as const,
  stageSource: "new" as const, stageEvidence: null, identityStatus: "unique_phone" as const, inquiryCount: 1,
  registeredAt: "2025-04-10T10:00:00.000Z", questionnaireCompletedAt: null,
  lastActivityAt: "2025-04-10T10:00:00.000Z", lastVideoMilestone: null, videoCompleted: false,
  hasVerifiedForm: false, ownerId: null, ownerName: null, followUpAt: null, version: 1,
}));
const listResponse = (items = people, page = 1) => ({
  items, page, pageSize: 12, total: items.length, totalPages: 2, overview,
  options: { programs: ["Barista Foundations"], sources: ["VSL registration"], owners: [{ id: 9, name: "Mira Shah" }] },
  capabilities: caps, warnings: [],
});
const detailResponse = (lead = people[0], failed = false) => ({
  lead, inquiries: failed ? [{
    id: 314, name: lead.name, email: lead.email, phone: lead.phone, programInterest: "Barista Foundations",
    message: null, counsellingAnswers: { careerGoal: "buildSkills" }, counsellingSubmittedAt: "2025-04-10T10:00:00.000Z",
    counsellingDeliveryStatus: "failed", counsellingDeliveryAttempts: 1, counsellingDeliveryLastAttemptAt: "2025-04-10T10:05:00.000Z",
    counsellingDeliveryLastResult: "Downstream endpoint unavailable", counsellingDeliveryLastVerifiedAt: null, deliveryAttemptHistory: [],
  }] : [],
  journey: null, activities: [{
    id: "activity-1", type: "registered", title: "Registered for Barista Foundations", at: "2025-04-10T10:00:00.000Z",
    actorId: null, actorName: null, source: "inquiry", body: "Initial enquiry received.", data: null,
  }], capabilities: caps, warnings: [],
});

async function setup(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true, value: { register: async () => ({}) },
    });
  });
  await page.route("**/api/lms/auth/me", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 4, phoneE164: "+919876543210", displayName: "Admissions staff", roles: ["admin"] }),
  }));
  await page.route((url) => url.pathname === "/api/admin/crm/leads", (route) => {
    const url = new URL(route.request().url());
    const pageNum = Number(url.searchParams.get("page") || 1);
    const filtered = url.searchParams.get("stage") ? [] : people;
    const offset = (pageNum - 1) * 12;
    const items = filtered.slice(offset, offset + 12);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listResponse(items, pageNum)) });
  });
  await page.route((url) => url.pathname.startsWith("/api/admin/crm/leads/"), (route) => {
    const target = people.find((person) => person.id === decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() || ""));
    return route.fulfill({ status: target ? 200 : 404, contentType: "application/json", body: JSON.stringify(target ? detailResponse(target) : { message: "Not found" }) });
  });
}

test("Chromium: CRM overview, lead cards, detail and server-persisted owner changes", async ({ page }) => {
  await setup(page);
  let savedPayload: Record<string, unknown> | undefined;
  await page.route((url) => url.pathname === "/api/admin/crm/leads/person-1", async (route) => {
    if (route.request().method() === "PATCH") {
      savedPayload = route.request().postDataJSON();
      const updated = { ...people[0], ownerId: 9, ownerName: "Mira Shah", version: 2 };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailResponse(updated)) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailResponse(people[0])) });
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "People, not just enquiries." })).toBeVisible();
  await expect(page.getByText("Identified people")).toBeVisible();
  await expect(page.getByTestId("crm-lead-card").first()).toContainText("Prospect 01");
  await page.getByTestId("crm-lead-card").first().click();
  await expect(page.getByTestId("crm-detail")).toContainText("Activity timeline");
  await page.getByTestId("crm-detail").getByTestId("crm-owner").selectOption("9");
  await page.getByTestId("crm-save").click();
  await expect.poll(() => savedPayload).toMatchObject({ expectedVersion: 1, ownerId: 9 });
});

test("Chromium: CRM server filters and pagination use query API", async ({ page }) => {
  await setup(page);
  await page.goto("/admin");
  await page.locator(".crm-filter-drawer > summary").click();
  await page.getByTestId("crm-filter-stage").selectOption("qualified");
  await expect(page.getByText("No people match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Show all records" }).click();
  await expect(page.getByTestId("crm-lead-card")).toHaveCount(12);
  await page.getByTestId("crm-next-page").click();
  await expect(page.getByText("Page 2 of 2")).toBeVisible();
});

test("Chromium: retry requires confirmation of correct prospect and downstream non-receipt", async ({ page }) => {
  await setup(page);
  await page.route((url) => url.pathname === "/api/admin/crm/leads/person-1", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(detailResponse(people[0], true)),
  }));
  let retryPayload: unknown;
  let completeRetry: (() => void) | undefined;
  await page.route("**/api/admin/inquiries/314/retry-counselling-delivery", async (route) => {
    retryPayload = route.request().postDataJSON();
    await new Promise<void>((resolve) => { completeRetry = resolve; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/admin");
  await page.getByTestId("crm-lead-card").first().click();
  await page.getByRole("button", { name: "Review & retry delivery" }).click();
  const confirmButton = page.getByTestId("admin-confirm-retry");
  await expect(confirmButton).toBeDisabled();
  const checks = page.getByRole("alertdialog").getByRole("checkbox");
  await checks.nth(0).check();
  await expect(confirmButton).toBeDisabled();
  await checks.nth(1).check();
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(confirmButton).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retrying", includeHidden: true })).toBeDisabled();
  await expect.poll(() => retryPayload).toEqual({ verifiedNotDelivered: true });
  await expect.poll(() => Boolean(completeRetry)).toBe(true);
  completeRetry?.();
});

test("Chromium: mobile CRM uses full-screen detail, readable cards and 44px controls", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin");
  await page.getByTestId("crm-lead-card").first().click();
  await expect(page.getByTestId("crm-detail")).toBeVisible();
  await expect(page.getByTestId("crm-detail")).toHaveAttribute("role", "dialog");
  await expect(page.getByTestId("crm-detail")).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("button", { name: "Close prospect detail" })).toBeVisible();
  for (const locator of [
    page.getByTestId("crm-detail").getByTestId("crm-stage"),
    page.getByTestId("crm-detail").getByTestId("crm-save"),
    page.getByTestId("crm-search"),
    page.getByTestId("crm-lead-card").first(),
  ]) {
    const box = await locator.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("crm-detail")).toBeHidden();
  await expect(page.getByTestId("crm-lead-card").first()).toBeFocused();
  await page.getByTestId("crm-lead-card").first().click();
  await page.getByRole("button", { name: "Close prospect detail" }).click();
  await expect(page.getByTestId("crm-detail")).toBeHidden();
});

test("Chromium: self-reported VSL watched sends confirmed evidence and enforces minimum evidence lengths", async ({ page }) => {
  await setup(page);
  let patch: Record<string, any> | undefined;
  await page.route((url) => url.pathname === "/api/admin/crm/leads/person-1", async (route) => {
    if (route.request().method() === "PATCH") {
      patch = route.request().postDataJSON();
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(detailResponse({ ...people[0], stage: "vsl_watched", stageSource: "admin", version: 2 })),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailResponse(people[0])) });
  });
  await page.goto("/admin");
  await page.getByTestId("crm-lead-card").first().click();
  const detail = page.getByTestId("crm-detail");
  await detail.getByTestId("crm-stage").selectOption("vsl_watched");
  await detail.getByLabel("Evidence source").selectOption("prospect_confirmation");
  const reason = detail.getByLabel("Why is this stage changing?");
  await reason.fill("OK");
  await expect(detail.getByTestId("crm-save")).toBeDisabled();
  await reason.fill("Prospect confirmed");
  const quote = detail.getByLabel("Clear quote from prospect");
  await quote.fill("Too short");
  await expect(detail.getByTestId("crm-save")).toBeDisabled();
  await quote.fill("Watched most of the VSL");
  await detail.getByLabel("Confirmed at").fill("2026-01-10T10:00");
  const save = detail.getByTestId("crm-save");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => patch).toMatchObject({
    expectedVersion: 1,
    stage: "vsl_watched",
    reason: "Prospect confirmed",
    evidence: {
      kind: "prospect_confirmation",
      reference: "Watched most of the VSL",
      confirmed: true,
    },
  });
  expect(new Date(patch?.evidence?.occurredAt).toString()).not.toBe("Invalid Date");
});

test("Chromium: admin PWA stays independent from auth and LEAP and uses exact network-only scope", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/lms/auth/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Authentication required" }) }));
  await page.route("**/api/lms/auth/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, channel: "password", message: "" }) }));
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: "Continue to sign in" })).toBeVisible();
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/admin.webmanifest");
  await page.goto("/admin/login");
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBe("/admin.webmanifest");
  const manifestResponse = await request.get("/admin.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({ id: "/admin", start_url: "/admin", scope: "/admin", name: "AICHM Admissions" });
  expect(await page.locator(".crm-install").count()).toBe(1);
  await expect.poll(() => page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.find((item) => item.active?.scriptURL.endsWith("/admin-sw.js"))?.scope ?? "";
  })).toBe(new URL("/admin", page.url()).href);
  const covered = await page.evaluate(async () => {
    const atAdmin = await navigator.serviceWorker.getRegistration("/admin");
    const atLogin = await navigator.serviceWorker.getRegistration("/admin/login");
    return [atAdmin?.scope, atLogin?.scope];
  });
  expect(covered).toEqual([new URL("/admin", page.url()).href, new URL("/admin", page.url()).href]);
  const workerScript = await (await request.get("/admin-sw.js")).text();
  expect(workerScript).toContain("respondWith(fetch(event.request))");
  expect(workerScript).not.toContain("caches");
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await page.goto("/learn");
  await expect.poll(() => page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/learn/manifest.webmanifest");
  expect(await page.locator('link[rel="manifest"][href="/admin.webmanifest"]').count()).toBe(0);
});

test("Chromium: CRM 401 or 403 hides cached prospect data, clears private UI and refreshes session", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true, value: { register: async () => ({}) },
    });
  });
  let forbidCrm = false;
  let sessionCalls = 0;
  await page.route("**/api/lms/auth/me", (route) => {
    sessionCalls += 1;
    if (sessionCalls > 1) return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Session expired" }) });
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ id: 4, phoneE164: "+919876543210", displayName: "Admissions staff", roles: ["admin"] }),
    });
  });
  await page.route((url) => url.pathname === "/api/admin/crm/leads", async (route) => {
    if (forbidCrm) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "Administrator access required" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listResponse(people.slice(0, 12), 1)) });
  });
  await page.route((url) => url.pathname.startsWith("/api/admin/crm/leads/"), (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(detailResponse(people[0])),
  }));
  await page.goto("/admin");
  await expect(page.getByTestId("crm-detail")).toContainText("Activity timeline");
  await expect(page.getByTestId("crm-detail").getByRole("heading", { name: "Prospect 01" })).toBeVisible();
  forbidCrm = true;
  await page.getByTestId("crm-search").fill("force permission refresh");
  await expect(page.getByText("Sign in with your Aroma Institute administrator account to continue.")).toBeVisible();
  await expect(page.getByTestId("crm-detail")).toHaveCount(0);
  await expect(page.getByText("Prospect 01")).toHaveCount(0);
  expect(sessionCalls).toBeGreaterThanOrEqual(2);
});
