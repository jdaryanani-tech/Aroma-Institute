import { expect, test, type Page } from "@playwright/test";

const caps = {
  identityTracking: true,
  videoTracking: true,
  crmPersistence: true,
  calendarBookingVerification: false,
  chatHistory: false,
  canonicalAssignments: true,
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
const leadUuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const people = Array.from({ length: 14 }, (_, index) => ({
  id: `lead:${leadUuid(index + 1)}`, leadId: leadUuid(index + 1), name: `Prospect ${String(index + 1).padStart(2, "0")}`,
  phone: `+919876500${String(index + 1).padStart(2, "0")}`, email: `prospect${index + 1}@example.test`,
  programs: ["Barista Foundations"], sources: ["VSL registration"], stage: "new_enquiry" as const,
  stageSource: "new" as const, stageEvidence: null, identityStatus: "unique_phone" as const, inquiryCount: 1,
  registeredAt: "2025-04-10T10:00:00.000Z", questionnaireCompletedAt: null,
  lastActivityAt: "2025-04-10T10:00:00.000Z", lastVideoMilestone: null, videoCompleted: false,
  hasVerifiedForm: false, hasVerifiedCalendarBooking: false, verifiedBookingReference: null,
  assigneeUserId: index === 0 ? 4 : index === 1 ? null : index === 2 ? 6 : index % 2 ? 6 : 4,
  assigneeName: index === 0 ? "Admissions One" : index === 1 ? null : index % 2 ? "Admissions Two" : "Admissions One",
  assigneeNeedsReassignment: false, assignmentVersion: index === 0 ? 1 : 0,
  followUpAt: null, version: 1,
}));
const listResponse = (items = people, page = 1) => ({
  items, page, pageSize: 12, total: items.length, totalPages: 2, overview,
  options: { programs: ["Barista Foundations"], sources: ["VSL registration"], assignees: [
    { id: 4, name: "Admissions One" }, { id: 6, name: "Admissions Two" },
  ] },
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
  }], capabilities: caps, warnings: [], legacyInquiryAssignments: [], assignmentHistory: [],
  conversationHistory: { state: "not_configured", items: [], nextCursor: null },
  marketing: {
    available: false, consentStatus: null, consentAt: null, touchpoints: [], metaLeadLinks: [], capiDeliveries: [],
  },
});
const leadApiPath = (lead = people[0]) => `/api/admin/crm/leads/${encodeURIComponent(lead.id)}`;

async function setup(page: Page, initialUser = { id: 4, phoneE164: "+919876543210", displayName: "Admissions staff", roles: ["admin"] }) {
  let currentUser = initialUser;
  let nextSessionUser: typeof initialUser | null = null;
  let denyAdminCrm = false;
  const listRequests: string[] = [];
  const sessionRoles: string[][] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true, value: { register: async () => ({}) },
    });
  });
  // Anything not explicitly mocked below must not reach the running app/API.
  await page.route("**/api/**", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ message: "Unmocked API request blocked in CRM UI test" }),
  }));
  await page.route("**/api/lms/auth/me", (route) => {
    if (nextSessionUser) {
      currentUser = nextSessionUser;
      nextSessionUser = null;
    }
    sessionRoles.push([...currentUser.roles]);
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(currentUser),
    });
  });
  await page.route((url) => url.pathname === "/api/admin/crm/leads", (route) => {
    const url = new URL(route.request().url());
    listRequests.push(url.toString());
    if (denyAdminCrm && currentUser.roles.includes("admin")) {
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "CRM access denied" }) });
    }
    const pageNum = Number(url.searchParams.get("page") || 1);
    const visible = currentUser.roles.includes("admin")
      ? people
      : people.filter((person) => person.assigneeUserId === currentUser.id);
    const filtered = url.searchParams.get("stage") ? [] : visible;
    const offset = (pageNum - 1) * 12;
    const items = filtered.slice(offset, offset + 12);
    const response = listResponse(items, pageNum);
    if (!currentUser.roles.includes("admin")) response.options.assignees = [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.route((url) => url.pathname.startsWith("/api/admin/crm/leads/"), (route) => {
    const request = new URL(route.request().url());
    const isConversation = request.pathname.endsWith("/conversations");
    const idPart = request.pathname.split("/").at(isConversation ? -2 : -1) || "";
    const id = decodeURIComponent(idPart);
    const target = people.find((person) => person.id === id);
    const canRead = Boolean(target) && (currentUser.roles.includes("admin") || target?.assigneeUserId === currentUser.id);
    if (!canRead) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Lead not found." }) });
    }
    if (isConversation) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ state: "not_configured", items: [], nextCursor: null }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailResponse(target!)) });
  });
  await page.route("**/api/admin/crm/avni-health", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      schema: { ready: true }, webhook: { urlValid: false, secretPresent: false, dispatcherActive: false },
      outbox: null,
    }),
  }));
  await page.route("**/api/admin/meta/status", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      schemaReady: true, pixelConfigured: false, capiEnabled: false, leadAdsConfigured: false,
      missingConfiguration: {}, outbox: null,
    }),
  }));
  return {
    setUser(user: typeof initialUser) { currentUser = user; },
    switchUserOnNextSession(user: typeof initialUser) { nextSessionUser = user; },
    denyAdminCrmRequests(value: boolean) { denyAdminCrm = value; },
    listRequests,
    sessionRoles,
  };
}

function assertDeniedResponses(responses: Array<{ status: number; body: unknown }>) {
  expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
  const body = JSON.stringify(responses);
  expect(body).not.toContain("Prospect 02");
  expect(body).not.toContain("Prospect 03");
}

test("Chromium: admins see assigned and unassigned leads and can assign a canonical lead", async ({ page }) => {
  await setup(page);
  let savedAssignment: Record<string, unknown> | undefined;
  await page.route((url) => url.pathname.endsWith("/assignment") && url.pathname.includes("/api/admin/crm/leads/"), async (route) => {
    savedAssignment = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "People, not just enquiries." })).toBeVisible();
  await expect(page.getByText("Identified people")).toBeVisible();
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 01" })).toBeVisible();
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 02" })).toBeVisible();
  await page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 02" }).click();
  await expect(page.getByTestId("crm-detail")).toContainText("Activity timeline");
  const assignmentSection = page.getByRole("region", { name: "Canonical lead assignment" });
  await expect(assignmentSection).toBeVisible();
  await expect(assignmentSection.getByTestId("crm-assignee")).toHaveValue("");
  await assignmentSection.getByTestId("crm-assignee").selectOption("6");
  await assignmentSection.getByLabel("Assignment reason").fill("Admissions handoff");
  await assignmentSection.getByTestId("crm-assignment-save").click();
  await expect.poll(() => savedAssignment).toMatchObject({
    expectedVersion: 0,
    assigneeUserId: 6,
    reason: "Admissions handoff",
  });
});

test("Chromium: admissions see only their assigned lead and cannot open other or unassigned records", async ({ page }) => {
  const state = await setup(page, {
    id: 4, phoneE164: "+919876543210", displayName: "Admissions One", roles: ["admissions"],
  });
  await page.goto("/admin");
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 01" })).toBeVisible();
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 02" })).toHaveCount(0);
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 03" })).toHaveCount(0);
  await expect(page.getByText("Assigned to you", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Canonical lead assignment" })).toHaveCount(0);
  await expect(page.getByTestId("crm-assignee")).toHaveCount(0);
  await expect(page.getByTestId("crm-assignee-filter")).toHaveCount(0);
  expect(new URL(state.listRequests[0]).searchParams.has("assignee")).toBe(false);

  const denied = await page.evaluate(async (ids) => {
    const read = async (path: string) => {
      const response = await fetch(path, { credentials: "same-origin" });
      return { status: response.status, body: await response.json() };
    };
    return Promise.all([
      read(`/api/admin/crm/leads/${encodeURIComponent(ids.unassigned)}`),
      read(`/api/admin/crm/leads/${encodeURIComponent(ids.other)}`),
      read(`/api/admin/crm/leads/${encodeURIComponent(ids.unassigned)}/conversations?limit=20`),
      read(`/api/admin/crm/leads/${encodeURIComponent(ids.other)}/conversations?limit=20`),
    ]);
  }, { unassigned: people[1].id, other: people[2].id });
  assertDeniedResponses(denied);
});

test("Chromium: changing CRM scope clears stale admin data and loads only the new admissions scope", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/admin");
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 02" })).toBeVisible();

  state.switchUserOnNextSession({
    id: 4, phoneE164: "+919876543210", displayName: "Admissions One", roles: ["admissions"],
  });
  state.denyAdminCrmRequests(true);
  await page.getByTestId("crm-search").fill("refresh scope");
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 01" })).toBeVisible();
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 02" })).toHaveCount(0);
  await expect(page.getByTestId("crm-lead-card").filter({ hasText: "Prospect 03" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Canonical lead assignment" })).toHaveCount(0);
  expect(state.sessionRoles.at(-1)).toEqual(["admissions"]);
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
  await page.route((url) => url.pathname === leadApiPath(), (route) => route.fulfill({
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
  await page.route((url) => url.pathname === leadApiPath(), async (route) => {
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
  await page.route("**/api/**", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ message: "Unmocked API request blocked in CRM UI test" }),
  }));
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
  await page.route("**/api/**", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ message: "Unmocked API request blocked in CRM UI test" }),
  }));
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
  await page.route("**/api/admin/crm/avni-health", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({
      schema: { ready: true }, webhook: { urlValid: false, secretPresent: false, dispatcherActive: false }, outbox: null,
    }),
  }));
  await page.route("**/api/admin/meta/status", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({
      schemaReady: true, pixelConfigured: false, capiEnabled: false, leadAdsConfigured: false,
      missingConfiguration: {}, outbox: null,
    }),
  }));
  await page.goto("/admin");
  await expect(page.getByTestId("crm-detail")).toContainText("Activity timeline");
  await expect(page.getByTestId("crm-detail").getByRole("heading", { name: "Prospect 01" })).toBeVisible();
  forbidCrm = true;
  await page.getByTestId("crm-search").fill("force permission refresh");
  await expect(page.getByTestId("page-admin-login")).toBeVisible();
  await expect(page.getByText("Prospect 01")).toHaveCount(0);
  expect(sessionCalls).toBeGreaterThanOrEqual(2);
});
