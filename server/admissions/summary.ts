import { inArray } from "drizzle-orm";
import { admissionsLeads, admissionsVideoEvents, inquiries, type LeadJourneySummaryData } from "@shared/schema";
import { db } from "../db";

/** Only used behind the existing authenticated admin route. Never a public lookup. */
export async function loadJourneySummaries(leadIds: string[]) {
  const result = new Map<string, LeadJourneySummaryData>();
  if (!leadIds.length) return result;
  const [leads, events, links] = await Promise.all([
    db.select().from(admissionsLeads).where(inArray(admissionsLeads.id, leadIds)),
    db.select().from(admissionsVideoEvents).where(inArray(admissionsVideoEvents.leadId, leadIds)),
    db.select({ leadId: inquiries.leadId, id: inquiries.id }).from(inquiries).where(inArray(inquiries.leadId, leadIds)),
  ]);
  for (const lead of leads) result.set(lead.id, {
    leadId: lead.id, registeredAt: lead.registeredAt?.toISOString() ?? null,
    lastRegisteredAt: lead.lastRegisteredAt?.toISOString() ?? null,
    entrySource: lead.entrySource, entryPath: lead.entryPath, entryHost: lead.entryHost,
    questionnaireStatus: lead.questionnaireStatus,
    questionnaireCompletedAt: lead.questionnaireCompletedAt?.toISOString() ?? null,
    videoObservedPercent:lead.videoObservedPercent,videoLastMilestone:lead.videoLastMilestone,
    videoLastEventAt:lead.videoLastEventAt?.toISOString() ?? null,
    videoCompletedAt:lead.videoCompletedAt?.toISOString() ?? null,
    legacyMatchStatus: lead.legacyMatchStatus,
    linkedInquiryIds: links.filter(link => link.leadId === lead.id).map(link => link.id),
    events: events.filter(event => event.leadId === lead.id)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map(event => ({
        event: event.event, occurredAt: event.occurredAt.toISOString(),
        positionSeconds: event.positionSeconds, durationSeconds: event.durationSeconds,
      })),
  });
  return result;
}
