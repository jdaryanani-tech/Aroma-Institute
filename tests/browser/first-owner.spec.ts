import { expect, test } from "@playwright/test";

test("Chromium: first-owner setup stays disabled in workspace",async({page})=>{
  await page.goto("/admin/first-owner");
  await expect(page.getByText("Owner setup is unavailable",{exact:true})).toBeVisible();
  await expect(page.getByLabel("Bootstrap secret",{exact:true})).toHaveCount(0);
  await expect(page.getByRole("link",{name:"Go to administrator sign in",exact:true})).toBeVisible();
});

test("Chromium: private owner setup submits once and never stores inputs or setup URL",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route("**/api/admin/first-owner/status",route=>route.fulfill({json:{available:true,maskedPhone:"***8669"}}));
  let posts=0;let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/admin/first-owner",async route=>{
    posts++;
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().postDataJSON()).toEqual({phone:"+919687878669",secret:"synthetic-browser-secret",confirmOwner:true});
    await pending;
    await route.fulfill({status:201,json:{maskedPhone:"***8669",expiresAt:"2026-11-06T12:00:00Z",
      setupUrl:"https://aromacafeinstitute.in/learn/setup#token=synthetic-browser-token-not-valid"}});
  });
  await page.goto("/admin/first-owner");
  const secret=page.getByLabel("Bootstrap secret",{exact:true});
  await expect(secret).toBeVisible();await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("type","password");
  await expect(secret).toHaveAttribute("autocomplete","off");
  const submit=page.getByRole("button",{name:"Create one-time owner link"});
  await expect(submit).toBeDisabled();
  await page.screenshot({path:"generated-artifacts/first-owner-mobile.png"});
  await page.getByLabel("Approved owner phone",{exact:true}).fill("+919687878669");
  await secret.fill("synthetic-browser-secret");
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox").check();
  await submit.click();
  await expect(secret).toHaveValue("");
  await expect(page.getByLabel("Approved owner phone",{exact:true})).toHaveValue("");
  expect(posts).toBe(1);release();
  await expect(page.getByRole("button",{name:"Copy private link"})).toBeVisible();
  expect(await page.locator('a[href*="token="]').count()).toBe(0);
  const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
  expect(storage).not.toContain("synthetic-browser");
  expect(page.url()).not.toContain("token");
  expect(page.url()).not.toContain("secret");
  await page.getByRole("button",{name:"Hide link and clear output"}).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByText("Owner setup is unavailable",{exact:true})).toBeVisible();
  expect(posts).toBe(1);
});

test("Chromium: rejected owner verification clears private inputs",async({page})=>{
  await page.route("**/api/admin/first-owner/status",route=>route.fulfill({json:{available:true,maskedPhone:"***8669"}}));
  await page.route("**/api/admin/first-owner",route=>route.fulfill({status:403,json:{message:"Owner verification failed. No account was changed."}}));
  await page.goto("/admin/first-owner");
  await page.getByLabel("Approved owner phone",{exact:true}).fill("+919687878669");
  await page.getByLabel("Bootstrap secret",{exact:true}).fill("synthetic-wrong-secret");
  await page.getByRole("checkbox").check();
  await page.getByRole("button",{name:"Create one-time owner link"}).click();
  await expect(page.getByRole("alert")).toContainText("Owner verification failed");
  await expect(page.getByLabel("Bootstrap secret",{exact:true})).toHaveValue("");
  await expect(page.getByLabel("Approved owner phone",{exact:true})).toHaveValue("");
});
