import React from "react";
import type { CrmMetaCaptureStatus } from "@shared/crm";
import { formatDate } from "./format";

export default function MetaCaptureStatusPanel({
  items,
  isLoading,
  isError,
}: {
  items: CrmMetaCaptureStatus[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section className="crm-info crm-field-wide" aria-label="Meta lead capture status" data-testid="meta-capture-status">
      <strong>Meta lead capture status</strong>
      {isLoading
        ? <p role="status">Checking the saved Meta link status…</p>
        : isError
          ? <p role="status">Meta capture status is temporarily unavailable.</p>
          : items.length === 0
            ? <p role="status">No enquiry status is available for this selected record.</p>
            : items.map((item, index) => (
              <div className="crm-meta-status-item" key={`${item.receivedAt ?? "unreceived"}-${index}`}>
                <p><span>Meta link record</span><strong>{item.metaLinkExists === null ? "Unavailable" : item.metaLinkExists ? "Found" : "Not found"}</strong></p>
                <p><span>Submission status</span><strong>{item.metaLinkStatus ?? "Not recorded"}</strong></p>
                <p><span>Review/error code</span><strong>{item.reviewCode ?? "None recorded"}</strong></p>
                <p><span>Received</span><strong>{item.receivedAt ? formatDate(item.receivedAt, true) : "Not recorded"}</strong></p>
                <p><span>Primary source</span><strong>{item.primarySourceLabel}</strong></p>
                <p><span>Canonical admissions person linked</span><strong>{item.canonicalPersonLinked ? "Yes" : "No"}</strong></p>
                <div className="crm-meta-phone-diagnostics" aria-label="Phone identity diagnostics">
                  <strong>Phone identity diagnostics</strong>
                  {item.phoneIdentityDiagnostics
                    ? <>
                      <p><span>phone_number field</span><strong>{item.phoneIdentityDiagnostics.fieldStates.phone_number}</strong></p>
                      <p><span>mobile_phone field</span><strong>{item.phoneIdentityDiagnostics.fieldStates.mobile_phone}</strong></p>
                      <p><span>whatsapp_number field</span><strong>{item.phoneIdentityDiagnostics.fieldStates.whatsapp_number}</strong></p>
                      <p><span>Normalization outcome</span><strong>{item.phoneIdentityDiagnostics.normalizationOutcome}</strong></p>
                      <p><span>Field selected by precedence</span><strong>{item.phoneIdentityDiagnostics.selectedField ?? "None"}</strong></p>
                      <p><span>Fallback selected</span><strong>{item.phoneIdentityDiagnostics.fallbackAttempted ? "Yes" : "No"}</strong></p>
                      <p><span>Invalid higher-priority field blocked fallback</span><strong>{item.phoneIdentityDiagnostics.invalidHigherPriorityBlockedFallback ? "Yes" : "No"}</strong></p>
                    </>
                    : <p role="status">Phone identity diagnostics were not recorded for this enquiry.</p>}
                </div>
              </div>
            ))}
      <p className="crm-journey-note">This read-only status is separate from Meta measurement readiness; a missing link record does not indicate whether other attribution tables are installed.</p>
    </section>
  );
}
