import { randomUUID } from "node:crypto";
import { admissionsLeadTouchpoints, admissionsMarketingConsentEvents, admissionsMetaEventOutbox } from "@shared/admissions-schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { META_CONSENT_POLICY_VERSION, hasValidMetaConsent } from "./config";

export type MetaEventName = "PageView" | "Lead" | "VslRegistered" | "VslProgress" | "VslCompleted" | "CounsellingSubmitted";
export type MetaCustomData = Record<string, string | number | boolean>;
export type MetaAttribution = {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  campaignId?: string | null;
  adId?: string | null;
  adsetId?: string | null;
  formId?: string | null;
  fbc?: string | null;
  fbp?: string | null;
};

type DrizzleTx = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  execute: (...args: any[]) => any;
};

export async function hasMarketingConsent(tx: DrizzleTx, visitorKeyHash: string) {
  const [latest] = await tx.select({
    consentStatus: admissionsMarketingConsentEvents.consentStatus,
    policyVersion: admissionsMarketingConsentEvents.policyVersion,
  }).from(admissionsMarketingConsentEvents)
    .where(eq(admissionsMarketingConsentEvents.visitorKeyHash, visitorKeyHash))
    .orderBy(desc(admissionsMarketingConsentEvents.occurredAt), desc(admissionsMarketingConsentEvents.id))
    .limit(1);
  return hasValidMetaConsent(latest?.consentStatus, latest?.policyVersion);
}

export async function enqueueMetaEvent(tx: DrizzleTx, input: {
  visitorKeyHash: string;
  leadId?: string | null;
  inquiryId?: number | null;
  eventName: MetaEventName;
  eventSourceUrl: string;
  customData?: MetaCustomData;
  eventId?: string;
  occurredAt?: Date;
}) {
  if (!await hasMarketingConsent(tx, input.visitorKeyHash)) return null;
  const eventId = input.eventId ?? randomUUID();
  const [created] = await tx.insert(admissionsMetaEventOutbox).values({
    eventId,
    visitorKeyHash: input.visitorKeyHash,
    leadId: input.leadId ?? null,
    inquiryId: input.inquiryId ?? null,
    eventName: input.eventName,
    eventTime: input.occurredAt ?? new Date(),
    eventSourceUrl: input.eventSourceUrl,
    customData: input.customData ?? {},
  }).onConflictDoNothing().returning({ eventId: admissionsMetaEventOutbox.eventId });
  return created?.eventId ?? eventId;
}

export async function linkVisitorConsentToLead(tx: DrizzleTx, visitorKeyHash: string, leadId: string) {
  await tx.update(admissionsMarketingConsentEvents)
    .set({ leadId })
    .where(and(
      eq(admissionsMarketingConsentEvents.visitorKeyHash, visitorKeyHash),
      eq(admissionsMarketingConsentEvents.policyVersion, META_CONSENT_POLICY_VERSION),
    ));
}

export async function metaSchemaReady(tx: DrizzleTx) {
  const result = await tx.execute(sql`SELECT
    to_regclass('admissions_marketing_consent_events') IS NOT NULL AS consent,
    to_regclass('admissions_lead_touchpoints') IS NOT NULL AS touchpoints,
    to_regclass('admissions_meta_lead_links') IS NOT NULL AS leadLinks,
    to_regclass('admissions_meta_event_outbox') IS NOT NULL AS outbox`);
  const row = (result as any).rows?.[0];
  return !!row && Object.values(row).every(Boolean);
}

export async function recordLeadTouchpoint(tx: DrizzleTx, input: {
  leadId?: string | null;
  inquiryId?: number | null;
  sourceChannel: string;
  attribution?: MetaAttribution;
  metaLeadId?: string | null;
  occurredAt?: Date;
}) {
  const a = input.attribution ?? {};
  await tx.insert(admissionsLeadTouchpoints).values({
    leadId: input.leadId ?? null,
    inquiryId: input.inquiryId ?? null,
    sourceChannel: input.sourceChannel,
    source: a.source ?? input.sourceChannel,
    medium: a.medium ?? null,
    campaign: a.campaign ?? null,
    campaignId: a.campaignId ?? null,
    adId: a.adId ?? null,
    adsetId: a.adsetId ?? null,
    formId: a.formId ?? null,
    metaLeadId: input.metaLeadId ?? null,
    fbc: a.fbc ?? null,
    fbp: a.fbp ?? null,
    occurredAt: input.occurredAt ?? new Date(),
  }).onConflictDoNothing();
}
