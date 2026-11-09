import { z } from "zod";
import { CRM_STAGES, type CrmLead, type CrmUpdate } from "@shared/crm";

export const updateCrmSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  stage: z.enum(Object.keys(CRM_STAGES) as [keyof typeof CRM_STAGES, ...(keyof typeof CRM_STAGES)[]]).optional(),
  followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().trim().min(1).max(4000).optional(),
  reason: z.string().trim().min(3).max(1000).optional(),
  evidence: z.object({
    kind: z.enum(["link_sent", "tracked_video", "prospect_confirmation", "staff_record", "calendar_booking"]),
    reference: z.string().trim().max(1000).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(), confirmed: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine(v => ["stage", "followUpAt", "note"].some(k => k in v), "No changes supplied.");

export class CrmError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function validateStageEvidence(lead: CrmLead, update: CrmUpdate) {
  if (!update.stage || update.stage === lead.stage) return;
  if (!update.reason) throw new CrmError(400, "A reason is required for a lifecycle change.");
  const e = update.evidence;
  switch (update.stage) {
    case "vsl_shared":
      if (e?.kind !== "link_sent" || !e.confirmed || !e.reference || e.reference.length < 3 || !e.occurredAt ||
          new Date(e.occurredAt).getTime() > Date.now() + 60000)
        throw new CrmError(400, "Record an actually sent link: confirm delivery, include the external sent-message reference and its past send time.");
      break;
    case "vsl_watched":
      if (e?.kind === "tracked_video" && lead.lastVideoMilestone && lead.lastVideoMilestone !== "started") break;
      if (e?.kind === "prospect_confirmation" && e.confirmed && (e.reference?.length ?? 0) >= 10) break;
      throw new CrmError(400, "Viewing needs a persisted playback milestone or an explicit prospect confirmation (labelled self-reported).");
    case "form_submitted":
      if (!lead.hasVerifiedForm) throw new CrmError(400, "No timestamped saved questionnaire exists for this person.");
      break;
    case "counselling_booked":
      if (!lead.hasVerifiedCalendarBooking || e?.kind !== "calendar_booking" || !e.confirmed
          || !lead.verifiedBookingReference || e.reference !== lead.verifiedBookingReference
          || !e.occurredAt || new Date(e.occurredAt).getTime() > Date.now() + 60000) {
        throw new CrmError(409, "A persisted AICHM Calendar booking is required; a form preference or webhook receipt is not booking evidence.");
      }
      break;
    case "counselling_attended":
    case "enrolled":
      if (e?.kind !== "staff_record" || !e.confirmed || (e.reference?.length ?? 0) < 10)
        throw new CrmError(400, "Explicit staff confirmation and a descriptive record/reference are required.");
      break;
  }
}
