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
    }]}
    isLoading={false}
    isError={false}
  />);
  assert.match(html, /Meta link record/);
  assert.match(html, /review/);
  assert.match(html, /phone_unavailable_for_identity_link/);
  assert.match(html, /Canonical admissions person linked/);
  assert.doesNotMatch(html, /metaLeadId|pageId|formId|<span>Phone|<span>Email|PRIVATE_/i);
});
