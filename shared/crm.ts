import type { CounsellingAnswers } from "./schema";
import type { LeadJourneySummaryData } from "./admissions-schema";

export const CRM_STAGES = {
  new_enquiry: "New Enquiry", contacted: "Contacted", qualified: "Qualified",
  vsl_shared: "VSL Shared", vsl_watched: "VSL Watched", form_submitted: "Form Submitted",
  counselling_pending: "Counselling Pending", counselling_booked: "Counselling Booked",
  counselling_attended: "Counselling Attended", enrolled: "Enrolled", nurture: "Nurture", lost: "Lost",
} as const;
export type CrmStage = keyof typeof CRM_STAGES;
export const ADMISSIONS_MANUAL_CRM_STAGES = [
  "contacted",
  "qualified",
  "vsl_shared",
  "counselling_pending",
  "nurture",
  "lost",
] as const satisfies readonly CrmStage[];
export type CrmCapabilities = {
  identityTracking: boolean; videoTracking: boolean; crmPersistence: boolean;
  calendarBookingVerification: boolean; chatHistory: boolean;
  canonicalAssignments: boolean;
  metaAttribution?: boolean;
};
export type CrmLead = {
  id: string; leadId: string | null; name: string; phone: string; email: string;
  programs: string[]; sources: string[]; stage: CrmStage;
  stageSource: "admin" | "verified_form" | "verified_video" | "new";
  stageEvidence: Record<string, unknown> | null;
  identityStatus: "linked" | "unique_phone" | "ambiguous" | "unmatchable";
  inquiryCount: number; registeredAt: string | null; questionnaireCompletedAt: string | null;
  lastActivityAt: string | null; lastVideoMilestone: string | null;
  videoCompleted: boolean; hasVerifiedForm: boolean;
  hasVerifiedCalendarBooking: boolean; verifiedBookingReference: string | null;
  assigneeUserId: number | null; assigneeName: string | null; assigneeNeedsReassignment: boolean;
  assignmentVersion: number; followUpAt: string | null; version: number;
};
export type CrmFilters = {
  q?: string; stage?: string; program?: string; source?: string; dateFrom?: string;
  dateTo?: string; followUp?: string; assignee?: string; sort?: string; page?: number; pageSize?: number;
};
export type CrmOverview = {
  identifiedPeople: number; unresolvedRecords: number; totalEnquiries: number;
  stageCounts: Record<CrmStage, number>; registeredPeople: number;
  videoStarted: number; videoWatched: number; verifiedForms: number;
  registeredWithForm: number; registeredWithoutForm: number;
  registeredToFormPercent: number | null; enrolledPercent: number | null;
};
export type CrmSourceBucket =
  | "meta_lead_ads"
  | "whatsapp"
  | "website"
  | "manual"
  | "other"
  | "unknown";
export type CrmSourceAnalytics = {
  totalEnquiries: number;
  identifiedPeople: number;
  unresolvedRecords: number;
  duplicateSubmissions: number | null;
  duplicateTracking: "tracked" | "not_tracked";
  duplicateExplanation: string;
  attributionMethod: string;
  sources: {
    source: CrmSourceBucket;
    enquiries: number;
    identifiedPeople: number;
  }[];
  lastUpdatedAt: string;
};
export type CrmList = {
  items: CrmLead[]; page: number; pageSize: number; total: number; totalPages: number;
  overview: CrmOverview; options: {
    programs: string[]; sources: string[]; assignees: { id: number; name: string }[];
  }; capabilities: CrmCapabilities; warnings: string[];
};
export type CrmInquiry = {
  id: number; name: string; email: string; phone: string; programInterest: string; message: string | null;
  counsellingAnswers: CounsellingAnswers | null; counsellingSubmittedAt: string | null;
  counsellingDeliveryStatus: string; counsellingDeliveryAttempts: number;
  counsellingDeliveryLastAttemptAt: string | null; counsellingDeliveryLastResult: string | null;
  counsellingDeliveryLastVerifiedAt: string | null;
  deliveryAttemptHistory: {
    id: number; attemptNumber: number; attemptedAt: string; responseAt: string | null;
    httpStatus: number | null; deliveryState: string; errorSummary: string | null;
  }[];
};
export type CrmActivity = {
  id: string; type: string; title: string; at: string | null; actorId: number | null;
  actorName: string | null; source: "staff" | "verified_system" | "inquiry";
  body: string | null; data: Record<string, unknown> | null;
};
export type CrmDetail = {
  lead: CrmLead; inquiries: CrmInquiry[]; journey: LeadJourneySummaryData | null;
  activities: CrmActivity[]; capabilities: CrmCapabilities; warnings: string[];
  legacyInquiryAssignments: { inquiryId: number; ownerId: number; ownerName: string | null }[];
  assignmentHistory: {
    id: string; previousAssigneeUserId: number | null; newAssigneeUserId: number | null;
    previousAssigneeName: string | null; newAssigneeName: string | null;
    actorUserId: number; actorName: string | null; changedAt: string; reason: string;
    source: string; requestId: string; assignmentVersion: number;
  }[];
  conversationHistory: {
    state: "available" | "not_configured" | "unavailable" | "unlinked";
    items: {
      conversationId: string; side: "message" | "ai_response"; direction: string;
      messageType: string; body: string; deliveryState: string | null;
      providerMessageId: string | null; occurredAt: string;
    }[];
    nextCursor: string | null;
  };
  marketing: {
    available: boolean; consentStatus: string | null; consentAt: string | null;
    touchpoints: {
      sourceChannel: string; source: string | null; medium: string | null; campaign: string | null;
      campaignId: string | null; adId: string | null; adsetId: string | null; formId: string | null;
      metaLeadId: string | null; occurredAt: string;
    }[];
    metaLeadLinks: { metaLeadId: string; state: string; errorCode: string | null; receivedAt: string }[];
    capiDeliveries: {
      eventId: string; eventName: string; state: string; attemptCount: number;
      lastAttemptAt: string | null; responseAt: string | null; httpStatus: number | null; lastError: string | null;
    }[];
  };
};

export type CrmMetaPhoneFieldState = "missing" | "blank" | "populated";
export type CrmMetaPhoneIdentityDiagnostics = {
  fieldStates: {
    phone_number: CrmMetaPhoneFieldState;
    mobile_phone: CrmMetaPhoneFieldState;
    whatsapp_number: CrmMetaPhoneFieldState;
  };
  normalizationOutcome:
    | "valid"
    | "no_phone_field"
    | "phone_fields_blank"
    | "invalid_characters"
    | "invalid_length"
    | "invalid_mobile_prefix";
  selectedField: "phone_number" | "mobile_phone" | "whatsapp_number" | null;
  fallbackAttempted: boolean;
  invalidHigherPriorityBlockedFallback: boolean;
};

export type CrmMetaCaptureStatus = {
  metaLinkExists: boolean | null;
  metaLinkStatus: "processed" | "review" | "failed" | "unknown" | null;
  reviewCode: "phone_unavailable_for_identity_link" | "other" | null;
  receivedAt: string | null;
  primarySourceLabel: "Meta Lead Ads" | "WhatsApp" | "Website" | "Manual" | "Other" | "Unknown";
  canonicalPersonLinked: boolean;
  phoneIdentityDiagnostics?: CrmMetaPhoneIdentityDiagnostics | null;
};

export type CrmUpdate = {
  expectedVersion: number; stage?: CrmStage; followUpAt?: string | null;
  note?: string; reason?: string;
  evidence?: {
    kind: "link_sent" | "tracked_video" | "prospect_confirmation" | "staff_record" | "calendar_booking";
    reference?: string; occurredAt?: string; confirmed?: boolean;
  };
};

export type CrmAssignmentUpdate = {
  expectedVersion: number;
  assigneeUserId: number | null;
  reason: string;
  requestId: string;
};
