import { expect, test } from "@playwright/test";
import { VSL_WHATSAPP_CONSENT_VERSION } from "../../shared/vsl-consent";

for(const choice of ["unchecked","checked","migration_pending"] as const) {
  test(`Chromium: optional VSL follow-up consent ${choice} never gates video access`,async({page})=>{
    await page.setViewportSize({width:390,height:844});
    let submitted:Record<string,unknown>|null=null;
    await page.route("**/api/vsl/**",async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==="/api/vsl/registration-options")
        return route.fulfill({json:{whatsappConsentAvailable:choice!=="migration_pending",consentVersion:VSL_WHATSAPP_CONSENT_VERSION}});
      if(path==="/api/vsl/registrations") {
        submitted=route.request().postDataJSON();
        return route.fulfill({status:201,json:{registered:true}});
      }
      return route.fulfill({status:401,json:{message:"Synthetic test: no real playback capture."}});
    });
    await page.goto("/vsl");
    await page.getByTestId("button-cta-hero").click();
    const checkbox=page.getByRole("checkbox");
    await expect(checkbox).not.toBeChecked();
    if(choice==="migration_pending") await expect(checkbox).toBeDisabled();
    else await expect(checkbox).toBeEnabled();
    if(choice==="checked") await checkbox.check();
    if(choice==="unchecked") await page.screenshot({path:"generated-artifacts/stage2-vsl-consent.png"});
    await page.getByTestId("gate-input-name").fill("Synthetic browser visitor");
    await page.getByTestId("gate-input-phone").fill("9000000001");
    await page.getByTestId("gate-button-submit").click();
    await expect(page).toHaveURL(/\/vsl-video$/);
    expect(submitted).toMatchObject({
      name:"Synthetic browser visitor",phone:"9000000001",entryPath:"/vsl",
      whatsappAdmissionsConsent:choice==="checked",consentVersion:VSL_WHATSAPP_CONSENT_VERSION,
    });
  });
}
