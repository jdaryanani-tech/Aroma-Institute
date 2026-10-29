import { expect, test } from "@playwright/test";

test("submits the one-question-at-a-time counselling flow in Chromium", async ({ page }) => {
  let submittedInquiry: Record<string, unknown> | undefined;
  await page.route("**/api/inquiries", async (route) => {
    submittedInquiry = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: 123 }),
    });
  });

  await page.goto("/counselling");
  await page.getByTestId("navigation-start").click();
  await expect(page.getByTestId("question-step").getByRole("heading")).toContainText("age group");

  await page.getByTestId("navigation-next").click();
  await expect(page.getByRole("alert")).toContainText("ek option choose karein");

  await page.getByTestId("option-ageRange-18to20").click();
  await page.getByTestId("navigation-next").click();
  await page.getByTestId("option-currentSituation-completed12th").click();
  await page.getByTestId("navigation-back").click();
  await expect(page.getByTestId("input-ageRange-1")).toBeChecked();
  await page.getByTestId("navigation-next").click();
  await expect(page.getByTestId("input-currentSituation-0")).toBeChecked();
  await page.getByTestId("navigation-next").click();
  await page.getByTestId("option-coffeeExperience-none").click();
  await page.getByTestId("navigation-next").click();
  await page.getByTestId("option-careerGoal-firstCafeJob").click();
  await page.getByTestId("navigation-next").click();
  await page.getByTestId("option-scheduleReadiness-needDetails").click();
  await page.getByTestId("navigation-next").click();
  await page.getByTestId("option-counsellingTopics-internshipTerms").click();
  await page.getByTestId("option-counsellingTopics-feesScholarshipPayment").click();
  await page.getByTestId("navigation-next").click();
  await page.getByTestId("option-guardianInvolvement-yes").click();
  await page.getByTestId("navigation-next").click();

  await page.getByTestId("field-additional-question").fill("Please explain the class schedule.");
  await page.getByTestId("navigation-next").click();
  await page.getByTestId("contact-name").fill("Browser Test");
  await page.getByTestId("contact-email").fill("counselling-browser-test@example.com");
  await page.getByTestId("contact-phone").fill("9876543210");
  await page.getByTestId("navigation-submit").click();

  await expect(page.getByTestId("success-state")).toBeVisible();
  expect(submittedInquiry).toMatchObject({
    name: "Browser Test",
    email: "counselling-browser-test@example.com",
    phone: "9876543210",
    programInterest: "Aroma LEAP",
    counsellingAnswers: {
      ageRange: "18to20",
      currentSituation: "completed12th",
      coffeeExperience: "none",
      careerGoal: "firstCafeJob",
      scheduleReadiness: "needDetails",
      counsellingTopics: ["internshipTerms", "feesScholarshipPayment"],
      guardianInvolvement: "yes",
      additionalQuestion: "Please explain the class schedule.",
    },
  });
});
