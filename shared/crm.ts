import type { CounsellingAnswers } from "./schema";
import type { LeadJourneySummaryData } from "./admissions-schema";

export const CRM_STAGES = {
  new_enquiry: "New Enquiry", contacted: "Contacted", qualified: "Qualified",
  vsl_shared: "VSL Shared", vsl_watched: "VSL Watched", form_submitted: "Form Submitted",
  counselling_pending: "Counselling Pending", counselling_booked: "Counselling Booked",
  counselling_attended: "Counselling Attended", enrolled: "Enrolled", nurture: "Nurture", lost: "Lost",
} as const;
export type CrmStage = keyof typeof CRM_STAGES;
export type CrmCapabilities = {
  identityTracking: boolean; videoTracking: boolean; crmPersistence: boolean;
  calendarBookingVerification: boolean; chatHistory: false;
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
  ownerId: number | null; ownerName: string | null; followUpAt: string | null; version: number;
};
export type CrmFilters = {
  q?: string; stage?: string; program?: string; source?: string; dateFrom?: string;
  dateTo?: string; followUp?: string; owner?: string; sort?: string; page?: number; pageSize?: number;
};
export type CrmOverview = {
  identifiedPeople: number; unresolvedRecords: number; totalEnquiries: number;
  stageCounts: Record<CrmStage, number>; registeredPeople: number;
  videoStarted: number; videoWatched: number; verifiedForms: number;
  registeredWithForm: number; registeredWithoutForm: number;
  registeredToFormPercent: number | null; enrolledPercent: number | null;
};
export type CrmList = {
  items: CrmLead[]; page: number; pageSize: number; total: number; totalPages: number;
  overview: CrmOverview; options: {
    programs: string[]; sources: string[]; owners: { id: number; name: string }[];
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
};
export type CrmUpdate = {
  expectedVersion: number; stage?: CrmStage; ownerId?: number | null; followUpAt?: string | null;
  note?: string; reason?: string;
  evidence?: {
    kind: "link_sent" | "tracked_video" | "prospect_confirmation" | "staff_record" | "calcom_booking";
    reference?: string; occurredAt?: string; confirmed?: boolean;
  };
};
