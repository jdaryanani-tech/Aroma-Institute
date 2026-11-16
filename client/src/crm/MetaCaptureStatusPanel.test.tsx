import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import MetaCaptureStatusPanel from "./MetaCaptureStatusPanel";

test("renders Meta capture status independently of marketing measurement readiness", () => {
  const html = renderToStaticMarkup(<MetaCaptureStatusPanel
    items={[{
      metaLinkExists: true,
      metaLinkStatus: "review",
      reviewCode: "phone_unavailable_for_identity_link",
      receivedAt: "2026-11-15T14:18:13.177Z",
      primarySourceLabel: "Meta Lead Ads",
      canonicalPersonLinked: false,
      phoneIdentityDiagnostics: {
        fieldStates: {
          phone_number: "blank",
          mobile_phone: "missing",
          whatsapp_number: "populated",
        },
        normalizationOutcome: "valid",
        selectedField: "whatsapp_number",
        fallbackAttempted: true,
        invalidHigherPriorityBlockedFallback: false,
      },
    }]}
    isLoading={false}
    isError={false}
  />);
  assert.match(html, /Meta link record/);
  assert.match(html, /review/);
  assert.match(html, /phone_unavailable_for_identity_link/);
  assert.match(html, /Canonical admissions person linked/);
  assert.match(html, /phone_number field<\/span><strong>blank/);
  assert.match(html, /mobile_phone field<\/span><strong>missing/);
  assert.match(html, /whatsapp_number field<\/span><strong>populated/);
  assert.match(html, /Normalization outcome<\/span><strong>valid/);
  assert.match(html, /Field selected by precedence<\/span><strong>whatsapp_number/);
  assert.match(html, /Fallback selected<\/span><strong>Yes/);
  assert.match(html, /Invalid higher-priority field blocked fallback<\/span><strong>No/);
  assert.doesNotMatch(html, /metaLeadId|pageId|formId|<span>(?:Phone|Email)<\/span>|PRIVATE_|tel:|mailto:/i);
});

test("states clearly when older Meta links have no saved phone diagnostics", () => {
  const html = renderToStaticMarkup(<MetaCaptureStatusPanel
    items={[{
      metaLinkExists: true,
      metaLinkStatus: "review",
      reviewCode: "phone_unavailable_for_identity_link",
      receivedAt: null,
      primarySourceLabel: "Meta Lead Ads",
      canonicalPersonLinked: false,
      phoneIdentityDiagnostics: null,
    }]}
    isLoading={false}
    isError={false}
  />);
  assert.match(html, /Phone identity diagnostics were not recorded for this enquiry/);
  assert.doesNotMatch(html, /PRIVATE_|metaLeadId|pageId|formId|payload/i);
});
