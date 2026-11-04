import { type Inquiry, type NewInquiry, inquiries } from "@shared/schema";
import { db } from "./db";
import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { InsertCounsellingInquiry, CounsellingDeliveryStatus } from "@shared/schema";

export interface IStorage {
  createInquiry(inquiry: NewInquiry): Promise<Inquiry>;
  createCounsellingInquiry(inquiry: InsertCounsellingInquiry, submittedAt: Date): Promise<Inquiry>;
  getInquiries(): Promise<Inquiry[]>;
  claimCounsellingInquiryRetry(
    id: number,
    attemptedAt: Date,
    verifiedByUserId: number,
  ): Promise<Inquiry | undefined>;
  getCounsellingDeliveryState(id: number): Promise<Pick<Inquiry, "id" | "counsellingDeliveryStatus"> | undefined>;
  finishCounsellingDeliveryAttempt(
    id: number,
    attemptNumber: number,
    status: Extract<CounsellingDeliveryStatus, "sent" | "failed">,
    lastResult: string,
  ): Promise<Inquiry | undefined>;
}

export class DatabaseStorage implements IStorage {
  async createInquiry(inquiry: NewInquiry): Promise<Inquiry> {
    const [result] = await db.insert(inquiries).values(inquiry).returning();
    return result;
  }

  async createCounsellingInquiry(inquiry: InsertCounsellingInquiry, submittedAt: Date): Promise<Inquiry> {
    const [result] = await db.insert(inquiries).values({
      ...inquiry,
      counsellingSubmittedAt: submittedAt,
      counsellingDeliveryStatus: "sending",
      counsellingDeliveryAttempts: 1,
      counsellingDeliveryLastAttemptAt: submittedAt,
      counsellingDeliveryLastResult: "Initial delivery in progress",
    }).returning();
    return result;
  }

  async getInquiries(): Promise<Inquiry[]> {
    return await db.select().from(inquiries).orderBy(desc(inquiries.id));
  }

  async claimCounsellingInquiryRetry(
    id: number,
    attemptedAt: Date,
    verifiedByUserId: number,
  ): Promise<Inquiry | undefined> {
    const staleBefore = new Date(attemptedAt.getTime() - 2 * 60 * 1000);
    const [result] = await db.update(inquiries).set({
      counsellingDeliveryStatus: "retrying",
      counsellingDeliveryAttempts: sql`${inquiries.counsellingDeliveryAttempts} + 1`,
      counsellingDeliveryLastAttemptAt: attemptedAt,
      counsellingDeliveryLastResult: "Retry in progress",
      counsellingDeliveryLastVerifiedAt: attemptedAt,
      counsellingDeliveryLastVerifiedBy: verifiedByUserId,
    }).where(and(
      eq(inquiries.id, id),
      isNotNull(inquiries.counsellingAnswers),
      isNotNull(inquiries.counsellingSubmittedAt),
      or(
        eq(inquiries.counsellingDeliveryStatus, "failed"),
        and(
          eq(inquiries.counsellingDeliveryStatus, "retrying"),
          lt(inquiries.counsellingDeliveryLastAttemptAt, staleBefore),
        ),
      ),
    )).returning();
    return result;
  }

  async getCounsellingDeliveryState(
    id: number,
  ): Promise<Pick<Inquiry, "id" | "counsellingDeliveryStatus"> | undefined> {
    const [result] = await db.select({
      id: inquiries.id,
      counsellingDeliveryStatus: inquiries.counsellingDeliveryStatus,
    }).from(inquiries).where(eq(inquiries.id, id)).limit(1);
    return result;
  }

  async finishCounsellingDeliveryAttempt(
    id: number,
    attemptNumber: number,
    status: Extract<CounsellingDeliveryStatus, "sent" | "failed">,
    lastResult: string,
  ): Promise<Inquiry | undefined> {
    const [result] = await db.update(inquiries).set({
      counsellingDeliveryStatus: status,
      counsellingDeliveryLastResult: lastResult,
    }).where(and(
      eq(inquiries.id, id),
      eq(inquiries.counsellingDeliveryAttempts, attemptNumber),
      or(
        eq(inquiries.counsellingDeliveryStatus, "sending"),
        eq(inquiries.counsellingDeliveryStatus, "retrying"),
      ),
    )).returning();
    return result;
  }
}

export const storage = new DatabaseStorage();
