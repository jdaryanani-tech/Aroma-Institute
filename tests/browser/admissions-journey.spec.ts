import { expect, test } from "@playwright/test";

const leadId = "11111111-1111-4111-8111-111111111111";
const caps = {
  identityTracking: true, videoTracking: true, crmPersistence: true,
  calendarBookingVerification: false, chatHistory: false,
};
const journey = {
  leadId, registeredAt: "2026-11-05T06:00:00Z", lastRegisteredAt: "2026-11-05T06:00:00Z",
  entrySource: "vsl_registration", entryPath: "/vsl", entryHost: "test.invalid",
  questionnaireStatus: "completed", questionnaireCompletedAt: "2026-11-05T06:30:00Z",
  legacyMatchStatus: "ambiguous", linkedInquiryIds: [1, 2],
  events: [
    { event: "started", occurredAt: "2026-11-05T06:01:00Z", positionSeconds: 0, durationSeconds: 1800 },
    { event: "50", occurredAt: "2026-11-05T06:16:00Z", positionSeconds: 900, durationSeconds: 1800 },
  ],
};
const lead = {
  id: "linked-person-1", leadId, name: "Synthetic Browser Fixture", email: "", phone: "919000000001",
  programs: ["Test Program"], sources: ["vsl_registration"], stage: "vsl_watched", stageSource: "verified_video",
  stageEvidence: { kind: "tracked_video", milestone: "50" }, identityStatus: "linked", inquiryCount: 2,
  registeredAt: journey.registeredAt, questionnaireCompletedAt: journey.questionnaireCompletedAt,
  lastActivityAt: "2026-11-05T06:30:00Z", lastVideoMilestone: "50", videoCompleted: false,
  hasVerifiedForm: true, ownerId: null, ownerName: null, followUpAt: null, version: 1,
};
const overview = {
  identifiedPeople: 1, unresolvedRecords: 0, totalEnquiries: 2,
  stageCounts: {
    new_enquiry: 0, contacted: 0, qualified: 0, vsl_shared: 0, vsl_watched: 1,
    form_submitted: 0, counselling_pending: 0, counselling_booked: 0,
    counselling_attended: 0, enrolled: 0, nurture: 0, lost: 0,
  },
  registeredPeople: 1, videoStarted: 1, videoWatched: 1, verifiedForms: 1,
  registeredWithForm: 1, registeredWithoutForm: 0, registeredToFormPercent: 100, enrolledPercent: 0,
};
const detail = {
  lead,
  inquiries: [
    {
      id: 1, name: lead.name, email: lead.email, phone: lead.phone, programInterest: "Test Program",
      message: "Synthetic browser fixture only", counsellingAnswers: { careerGoal: "buildSkills" },
      counsellingSubmittedAt: journey.questionnaireCompletedAt, counsellingDeliveryStatus: "acknowledged",
      counsellingDeliveryAttempts: 1, counsellingDeliveryLastAttemptAt: journey.questionnaireCompletedAt,
      counsellingDeliveryLastResult: "Acknowledged", counsellingDeliveryLastVerifiedAt: journey.questionnaireCompletedAt,
      deliveryAttemptHistory: [],
    },
    {
      id: 2, name: lead.name, email: lead.email, phone: lead.phone, programInterest: "Test Program",
      message: null, counsellingAnswers: null, counsellingSubmittedAt: null, counsellingDeliveryStatus: "not_applicable",
      counsellingDeliveryAttempts: 0, counsellingDeliveryLastAttemptAt: null, counsellingDeliveryLastResult: null,
      counsellingDeliveryLastVerifiedAt: null, deliveryAttemptHistory: [],
    },
  ],
  journey, activities: [], capabilities: caps, warnings: [],
};

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Chromium: linked CRM identity and verified VSL/questionnaire journey at ${viewport.width}px`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true, value: { register: async () => ({}) },
      });
    });
    await page.setViewportSize(viewport);
    await page.route("**/api/lms/auth/me", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ id: 1, displayName: "Synthetic Admin", phoneE164: "+919000000099", roles: ["admin"] }),
    }));
    await page.route((url) => url.pathname === "/api/admin/crm/leads", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        items: [lead], page: 1, pageSize: 12, total: 1, totalPages: 1, overview,
        options: { programs: ["Test Program"], sources: ["vsl_registration"], owners: [] },
        capabilities: caps, warnings: [],
      }),
    }));
    await page.route((url) => url.pathname === `/api/admin/crm/leads/${lead.id}`, (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(detail),
    }));
    await page.goto("/admin");
    await page.getByTestId("crm-lead-card").click();
    const profile = page.getByTestId("crm-detail");
    await expect(profile.locator(".crm-identity")).toContainText("Linked identity");
    await expect(profile.getByRole("region", { name: "Verified journey" })).toContainText("50% milestone observed");
    await expect(profile.getByRole("region", { name: "Verified journey" })).toContainText("Completion not recorded");
    await expect(profile.getByRole("region", { name: "Verified journey" })).toContainText("Questionnaire");
    await expect(profile.getByRole("region", { name: "Verified journey" })).toContainText("Completed");
    await expect(profile.getByRole("region", { name: "Verified journey" })).toContainText("1, 2");
    await expect(profile.getByRole("region", { name: "Verified journey" })).toContainText("Legacy match is ambiguous");
    await expect(profile).toContainText("View counselling answers");
    if (viewport.width < 768) await expect(page.getByRole("button", { name: "Close prospect detail" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
