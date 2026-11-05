import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const fixtureDirectory = join(process.cwd(), "tests/fixtures/vsl");
const playlist = await readFile(join(fixtureDirectory, "index.m3u8"), "utf8");
const segment = await readFile(join(fixtureDirectory, "segment-00000.ts"));

async function stubInquirySubmission(page: import("@playwright/test").Page) {
  await page.route("**/api/vsl/registrations", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ registered: true }),
    });
  });
}

async function serveTestHlsMedia(page: import("@playwright/test").Page) {
  await page.route("**/api/vsl/media/index.m3u8", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body: playlist,
    });
  });
  await page.route("**/api/vsl/media/segment-*.ts", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "video/mp2t",
      body: segment,
    });
  });
}

async function setNativeHlsSupport(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type: string) {
      if (type === "application/vnd.apple.mpegurl") return "maybe";
      return originalCanPlayType.call(this, type);
    };
  });
}

test.beforeEach(async ({ page }) => {
  await stubInquirySubmission(page);
  await serveTestHlsMedia(page);
  // Browser fixtures never write to the normal development database.
  await page.route("**/api/vsl/playbacks", route => route.fulfill({
    status: 201, contentType: "application/json",
    body: JSON.stringify({ playbackId: "11111111-1111-4111-8111-111111111111" }),
  }));
  await page.route("**/api/vsl/events", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ saved: true }),
  }));
});

test("unlocks the VSL and plays/seeks Hls.js media in Chromium", async ({ page }) => {
  let inquiryRequests = 0;
  await page.unroute("**/api/vsl/registrations");
  await page.route("**/api/vsl/registrations", async (route) => {
    inquiryRequests += 1;
    expect(route.request().postDataJSON()).toEqual({
      name: "Browser Test", phone: "9876543210", entryPath: "/vsl",
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ registered: true }),
    });
  });

  const mediaRequests: string[] = [];
  const posterResponse = page.waitForResponse((response) =>
    response.url().includes("Barista_Career_in_Three_Months"),
  );
  page.on("request", (request) => {
    if (request.url().includes("/api/vsl/media/")) mediaRequests.push(request.url());
  });

  await page.goto("/vsl");
  await expect(page.getByTestId("modal-video-gate")).toHaveCount(0);
  await page.getByTestId("button-cta-hero").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Name").fill("Browser Test");
  await page.getByLabel("Phone number").fill("9876543210");
  await page.getByTestId("gate-button-submit").click();
  await expect(page).toHaveURL(/\/vsl-video$/);
  expect(inquiryRequests).toBe(1);

  const video = page.getByTestId("vsl-video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("poster", /Barista_Career_in_Three_Months/);
  expect((await posterResponse).ok()).toBe(true);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(0);
  await expect.poll(() => mediaRequests.some((url) => url.endsWith("/index.m3u8"))).toBe(true);
  await expect.poll(() => mediaRequests.some((url) => url.endsWith("/segment-00000.ts"))).toBe(true);
  await expect.poll(() => mediaRequests.some((url) => url.endsWith("/segment-00001.ts"))).toBe(true);

  await page.getByTestId("vsl-play-button").click();
  await expect(page.getByTestId("vsl-pause-button")).toBeVisible();
  await page.getByTestId("vsl-pause-button").click();
  await expect(page.getByTestId("vsl-play-button")).toBeVisible();

  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 2.5;
    element.dispatchEvent(new Event("timeupdate"));
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(2);
  await expect
    .poll(() =>
      page
        .getByTestId("vsl-progress")
        .getAttribute("aria-valuenow")
        .then(Number),
    )
    .toBeGreaterThan(0);
});

test("uses the native HLS source path in WebKit", async ({ page }) => {
  await setNativeHlsSupport(page);

  const playlistRequested = page.waitForRequest((request) =>
    request.url().endsWith("/api/vsl/media/index.m3u8"),
  );
  const posterResponse = page.waitForResponse((response) =>
    response.url().includes("Barista_Career_in_Three_Months"),
  );
  await page.goto("/vsl-video");

  const video = page.getByTestId("vsl-video");
  await expect(video).toHaveAttribute("poster", /Barista_Career_in_Three_Months/);
  await expect(video).toHaveAttribute("src", /\/api\/vsl\/media\/index\.m3u8$/);
  expect((await posterResponse).ok()).toBe(true);
  await playlistRequested;
  await expect(page.getByTestId("vsl-play-button")).toBeVisible();
});

test("shows a media failure alert without disabling the page in Chromium", async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = async function () {
      throw new DOMException("Simulated media playback failure", "NotSupportedError");
    };
  });

  await page.goto("/vsl-video");
  await page.getByTestId("vsl-play-button").click();
  await expect(page.getByTestId("vsl-media-error")).toBeVisible();
  await page.getByTestId("vsl-maximize-button").click();
  await expect(page.getByTestId("vsl-maximize-button")).toHaveAttribute("aria-label", "Minimize video");
  await expect(page.getByRole("heading", { name: /Aroma Institute/ })).toBeVisible();
});
