import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Chromium: admin journey visibility at ${viewport.width}px uses linked identity and observed milestones`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/lms/auth/me", route => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ id: 1, displayName: "Synthetic Admin", phoneE164: "+919000000099", roles: ["admin"] }),
    }));
    const leadId = "11111111-1111-4111-8111-111111111111";
    await page.route("**/api/admin/inquiries", route => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([{
        id: 1, leadId, name: "Synthetic Browser Fixture", email: "", phone: "919000000001",
        programInterest: "Test Program", message: "Browser fixture only",
        counsellingAnswers: null, counsellingSubmittedAt: null,
        counsellingDeliveryStatus: "not_applicable", counsellingDeliveryAttempts: 0,
        counsellingDeliveryLastAttemptAt: null, counsellingDeliveryLastResult: null, deliveryAttemptHistory: [],
        journey: {
          leadId, registeredAt: "2026-11-05T06:00:00Z", lastRegisteredAt: "2026-11-05T06:00:00Z",
          entrySource: "vsl_registration", entryPath: "/vsl", entryHost: "test.invalid",
          questionnaireStatus: "completed", questionnaireCompletedAt: "2026-11-05T06:30:00Z",
          legacyMatchStatus: "ambiguous", linkedInquiryIds: [1, 2],
          events: [
            { event: "started", occurredAt: "2026-11-05T06:01:00Z", positionSeconds: 0, durationSeconds: 1800 },
            { event: "50", occurredAt: "2026-11-05T06:16:00Z", positionSeconds: 900, durationSeconds: 1800 },
          ],
        },
      }]),
    }));
    await page.goto("/admin");
    const journey = page.getByTestId(`lead-journey-${leadId}`);
    await expect(journey).toContainText("50% milestone observed");
    await expect(journey).toContainText("Completion not recorded");
    await expect(journey).toContainText("15:00 / 30:00");
    await expect(journey).toContainText("Completed");
    await expect(journey).toContainText("1, 2");
    await expect(journey).toContainText("ambiguous");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
