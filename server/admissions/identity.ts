import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { admissionsLeads, inquiries, type InsertCounsellingInquiry } from "@shared/schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AdmissionsDatabase = Pick<typeof db, "transaction" | "select" | "insert" | "update">;

/** Never rewrites historical answers or merges ambiguous historical rows. */
async function resolveLead(tx: Transaction, phone: string, name: string) {
  const canonicalPhone = normalizeIndianMobile(phone);
  if (!canonicalPhone) throw new Error("invalid_indian_mobile");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`admissions:${canonicalPhone}`}))`);
  let [lead] = await tx.select().from(admissionsLeads).where(eq(admissionsLeads.canonicalPhone, canonicalPhone));
  if (!lead) {
    [lead] = await tx.insert(admissionsLeads).values({ canonicalPhone, name }).returning();
  }
  // Compare only normalized, valid Indian mobiles. Select minimal legacy metadata.
  const normalized = sql<string>`regexp_replace(${inquiries.phone}, '[^0-9]', '', 'g')`;
  const candidates = await tx.select({
    id: inquiries.id, submittedAt: inquiries.counsellingSubmittedAt,
    hasAnswers: sql<boolean>`${inquiries.counsellingAnswers} IS NOT NULL`,
  }).from(inquiries).where(and(
    isNull(inquiries.leadId),
    sql`btrim(${inquiries.phone}) ~ '^\\+?[0-9[:space:]().-]+$'`,
    sql`${normalized} IN (${canonicalPhone}, ${canonicalPhone.slice(2)})`,
  )).limit(2);
  if (candidates.length === 1) {
    await tx.update(inquiries).set({ leadId: lead.id }).where(and(
      eq(inquiries.id, candidates[0].id), isNull(inquiries.leadId),
    ));
    const legacy = candidates[0];
    [lead] = await tx.update(admissionsLeads).set({
      legacyMatchStatus: "linked_unique",
      ...(legacy.hasAnswers && lead.questionnaireStatus !== "completed" ? {
        questionnaireStatus: "completed", questionnaireCompletedAt: legacy.submittedAt,
      } : {}),
    }).where(eq(admissionsLeads.id, lead.id)).returning();
  } else if (candidates.length > 1) {
    [lead] = await tx.update(admissionsLeads).set({ legacyMatchStatus: "ambiguous" })
      .where(eq(admissionsLeads.id, lead.id)).returning();
  }
  return lead;
}

export async function registerVslLead(input: { phone: string; name: string; entryPath: string; entryHost: string }, now = new Date(), database: AdmissionsDatabase = db) {
  return database.transaction(async (tx) => {
    const lead = await resolveLead(tx, input.phone, input.name);
    const [updated] = await tx.update(admissionsLeads).set({
      registeredAt: lead.registeredAt ?? now,
      lastRegisteredAt: now,
      entrySource: lead.entrySource ?? "vsl_registration",
      entryPath: lead.entryPath ?? input.entryPath,
      entryHost: lead.entryHost ?? input.entryHost,
    }).where(eq(admissionsLeads.id, lead.id)).returning();
    const [existing] = await tx.select({ id: inquiries.id }).from(inquiries)
      .where(eq(inquiries.leadId, lead.id)).limit(1);
    // Keep registration-only leads visible in the existing inquiry dashboard.
    if (!existing) await tx.insert(inquiries).values({
      leadId: lead.id, name: input.name, phone: lead.canonicalPhone,
      email: "watch@aromainstitute.in", programInterest: "Aroma LEAP",
      message: "Requested free Aroma LEAP training from the VSL landing page",
    });
    return updated;
  });
}

export async function saveLinkedCounsellingInquiry(data: InsertCounsellingInquiry, now: Date, database: AdmissionsDatabase = db) {
  return database.transaction(async (tx) => {
    const lead = await resolveLead(tx, data.phone, data.name);
    const [inquiry] = await tx.insert(inquiries).values({
      ...data, leadId: lead.id, counsellingSubmittedAt: now,
      counsellingDeliveryStatus: "pending", counsellingDeliveryAttempts: 0,
    }).returning();
    await tx.update(admissionsLeads).set({
      questionnaireStatus: "completed", questionnaireCompletedAt: now,
    }).where(eq(admissionsLeads.id, lead.id));
    return inquiry;
  });
}
