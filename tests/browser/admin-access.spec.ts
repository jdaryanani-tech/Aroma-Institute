import { expect, test } from "@playwright/test";

for (const role of ["student", "trainer"] as const) {
  test(`Chromium: ${role} accounts are denied the counselling leads UI`, async ({ page }) => {
    let leadsApiRequests = 0;
    await page.route("**/api/lms/auth/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 7,
        phoneE164: "+919876543210",
        displayName: "LEAP test account",
        roles: [role],
      }),
    }));
    page.on("request", (request) => {
      if (request.url().includes("/api/admin/inquiries")) leadsApiRequests += 1;
    });

    await page.goto("/admin");
    await expect(page.getByRole("alert")).toContainText(
      "Access denied. This account does not have Leads Dashboard administrator access.",
    );
    await expect(page.getByRole("link", { name: "Continue to sign in" })).toBeVisible();
    expect(leadsApiRequests).toBe(0);

    await page.goto("/admin/login");
    await expect(page.getByRole("alert")).toContainText(
      "Access denied. This signed-in account does not have Leads Dashboard administrator access.",
    );
    await expect(page.getByRole("heading", { name: "Leads Dashboard sign in" })).toBeVisible();
    expect(leadsApiRequests).toBe(0);
  });
}

for (const account of [
  { role: "student", destination: "/learn/dashboard" },
  { role: "trainer", destination: "/trainer" },
] as const) {
  test(`Chromium: LEAP ${account.role} sign-in still opens ${account.destination}`, async ({ page }) => {
    await page.route("**/api/lms/auth/me", (route) => route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Authentication required" }),
    }));
    await page.route("**/api/lms/auth/status", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, channel: "password", message: "" }),
    }));
    await page.route("**/api/lms/auth/password/login", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 7,
        phoneE164: "+919876543210",
        displayName: "LEAP test account",
        roles: [account.role],
      }),
    }));
    await page.goto("/learn");
    await page.getByLabel("Phone number").fill("+919876543210");
    await page.getByLabel("Password").fill("test-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(new RegExp(`${account.destination.replaceAll("/", "\\/")}$`));
  });
}
