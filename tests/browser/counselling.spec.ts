import { expect, test } from "@playwright/test";

test("submits and stores the complete 29-question counselling request in Chromium", async ({ page }) => {
  // This walks all 29 questions; allow for slower shared browser runners.
  test.setTimeout(60_000);
  let submittedInquiry: Record<string, any> | undefined;
  await page.route("**/api/counselling-inquiries", async (route) => {
    submittedInquiry = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: 123 }),
    });
  });

  await page.goto("/counselling");
  await page.getByTestId("start-counselling").click();
  await expect(page.getByTestId("question-step")).toHaveAttribute("data-question-number", "1");
  await page.getByTestId("next-question").click();
  await expect(page.getByTestId("question-error")).toContainText("poora naam");

  await page.getByTestId("field-fullName").fill("Browser Test");
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-ageRange-18to20").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-currentActivity-completed12th").click();
  await page.getByTestId("previous-question").click();
  await expect(page.getByTestId("choice-ageRange-18to20")).toBeChecked();
  await page.getByTestId("next-question").click();
  await expect(page.getByTestId("choice-currentActivity-completed12th")).toBeChecked();
  await page.getByTestId("next-question").click();

  await page.getByTestId("field-city").fill("Ahmedabad");
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-careerReasons-startEarning").click();
  await page.getByTestId("choice-careerReasons-coffeeCulture").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-mainBarrier-noWorkExperience").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("field-situationImpact").fill("I am unsure how to begin my career.");
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-sixToTwelveMonthGoal-firstCaféJob").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-coffeeKnowledge-beginner").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-stepsTaken-onlineResearch").click();
  await page.getByTestId("choice-stepsTaken-visitedCafés").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-biggestConcern-jobWithoutExperience").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-desiredStart-withinOneMonth").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-handsOnReadiness-ready").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-timeAvailability-fullTime").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-decisionMaker-together").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-familyDiscussion-supportive").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-investmentSituation-considerIfRightFit").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("field-topQuestions").fill("What does the café internship include?");
  await page.getByTestId("next-question").click();
  await page.getByTestId("field-counsellorNote").fill("Please explain the class schedule.");
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-visitMode-instituteAhmedabad").click();
  await page.getByTestId("next-question").click();

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 2);
  const preferredDate = [
    futureDate.getFullYear(),
    String(futureDate.getMonth() + 1).padStart(2, "0"),
    String(futureDate.getDate()).padStart(2, "0"),
  ].join("-");
  await page.getByTestId("field-preferredDate").click();
  await expect(page.getByTestId("visit-date-calendar")).toBeVisible();
  await page.getByRole("gridcell", { name: String(futureDate.getDate()), exact: true }).click();
  await expect(page.getByTestId("field-preferredDate")).toContainText(
    new RegExp(String(futureDate.getDate())),
  );
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-preferredTime-10to12").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-visitCompanion-parent").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("field-visitFocus").fill("I would like to understand training and scholarship options.");
  await page.getByTestId("next-question").click();
  await page.getByTestId("field-mobileWhatsapp").fill("9876543210");
  await page.getByTestId("next-question").click();
  await expect(page.getByTestId("question-step")).toHaveAttribute("data-question-number", "26");
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-counsellingLanguage-hinglish").click();
  await page.getByTestId("next-question").click();
  await page.getByTestId("choice-parentJoining-maybe").click();
  await page.getByTestId("next-question").click();
  await expect(page.getByTestId("question-step")).toHaveAttribute("data-question-number", "29");

  await page.getByTestId("submit-counselling").click();
  await expect(page.getByTestId("question-error")).toContainText("consent");
  await page.getByTestId("field-consentToContact").check();
  await page.getByTestId("submit-counselling").click();

  await expect(page.getByTestId("counselling-success")).toBeVisible();
  expect(submittedInquiry).toMatchObject({
    name: "Browser Test",
    email: "",
    phone: "9876543210",
    programInterest: "Aroma LEAP",
    counsellingAnswers: {
      fullName: "Browser Test",
      ageRange: "18to20",
      currentActivity: "completed12th",
      city: "Ahmedabad",
      careerReasons: ["startEarning", "coffeeCulture"],
      mainBarrier: "noWorkExperience",
      situationImpact: "I am unsure how to begin my career.",
      sixToTwelveMonthGoal: "firstCaféJob",
      coffeeKnowledge: "beginner",
      stepsTaken: ["onlineResearch", "visitedCafés"],
      biggestConcern: "jobWithoutExperience",
      desiredStart: "withinOneMonth",
      handsOnReadiness: "ready",
      timeAvailability: "fullTime",
      decisionMaker: "together",
      familyDiscussion: "supportive",
      investmentSituation: "considerIfRightFit",
      topQuestions: "What does the café internship include?",
      counsellorNote: "Please explain the class schedule.",
      visitMode: "instituteAhmedabad",
      preferredDate,
      preferredTime: "10to12",
      visitCompanion: "parent",
      visitFocus: "I would like to understand training and scholarship options.",
      mobileWhatsapp: "9876543210",
      email: "",
      counsellingLanguage: "hinglish",
      parentJoining: "maybe",
      consentToContact: true,
    },
  });
  expect(Object.keys(submittedInquiry?.counsellingAnswers ?? {})).toHaveLength(29);
});
