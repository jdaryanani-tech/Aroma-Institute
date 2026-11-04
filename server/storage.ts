import {
  type CounsellingDeliveryAttemptRecord,
  type CounsellingDeliveryStatus,
  type Inquiry,
  type NewInquiry,
  counsellingDeliveryAttemptRecords,
  inquiries,
} from "@shared/schema";
import { db } from "./db";
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { InsertCounsellingInquiry } from "@shared/schema";

export type InquiryWithDeliveryAttemptHistory = Inquiry & {
  deliveryAttemptHistory: CounsellingDeliveryAttemptRecord[];
};

export type CounsellingDeliveryAttemptResult = {
  status: Extract<CounsellingDeliveryStatus, "acknowledged" | "failed">;
  lastResult: string;
  responseAt: Date | null;
  httpStatus: number | null;
  errorSummary: string | null;
};

export interface IStorage {
  createInquiry(inquiry: NewInquiry): Promise<Inquiry>;
  createCounsellingInquiry(inquiry: InsertCounsellingInquiry, submittedAt: Date): Promise<Inquiry>;
  startCounsellingDeliveryAttempt(id: number, attemptedAt: Date): Promise<Inquiry | undefined>;
  getInquiries(): Promise<InquiryWithDeliveryAttemptHistory[]>;
  claimCounsellingInquiryRetry(
    id: number,
    attemptedAt: Date,
    verifiedByUserId: number,
  ): Promise<Inquiry | undefined>;
  getCounsellingDeliveryState(id: number): Promise<Pick<Inquiry, "id" | "counsellingDeliveryStatus"> | undefined>;
  finishCounsellingDeliveryAttempt(
    id: number,
    attemptNumber: number,
    result: CounsellingDeliveryAttemptResult,
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
      counsellingDeliveryStatus: "pending",
      counsellingDeliveryAttempts: 0,
      counsellingDeliveryLastAttemptAt: null,
      counsellingDeliveryLastResult: null,
    }).returning();
    return result;
  }

  async startCounsellingDeliveryAttempt(id: number, attemptedAt: Date): Promise<Inquiry | undefined> {
    return db.transaction(async (tx) => {
      const [result] = await tx.update(inquiries).set({
        counsellingDeliveryStatus: "sending",
        counsellingDeliveryAttempts: sql`${inquiries.counsellingDeliveryAttempts} + 1`,
        counsellingDeliveryLastAttemptAt: attemptedAt,
        counsellingDeliveryLastResult: "sending",
      }).where(and(
        eq(inquiries.id, id),
        eq(inquiries.counsellingDeliveryStatus, "pending"),
      )).returning();
      if (!result) return undefined;
      await tx.insert(counsellingDeliveryAttemptRecords).values({
        inquiryId: result.id,
        attemptNumber: result.counsellingDeliveryAttempts,
        deliveryState: "sending",
        attemptedAt,
      });
      return result;
    });
  }

  async getInquiries(): Promise<InquiryWithDeliveryAttemptHistory[]> {
    const records = await db.select().from(inquiries).orderBy(desc(inquiries.id));
    if (records.length === 0) return [];
    const attempts = await db.select()
      .from(counsellingDeliveryAttemptRecords)
      .where(inArray(counsellingDeliveryAttemptRecords.inquiryId, records.map(({ id }) => id)))
      .orderBy(asc(counsellingDeliveryAttemptRecords.attemptNumber));
    const attemptsByInquiry = new Map<number, CounsellingDeliveryAttemptRecord[]>();
    for (const attempt of attempts) {
      const history = attemptsByInquiry.get(attempt.inquiryId) ?? [];
      history.push(attempt);
      attemptsByInquiry.set(attempt.inquiryId, history);
    }
    return records.map((record) => ({
      ...record,
      deliveryAttemptHistory: attemptsByInquiry.get(record.id) ?? [],
    }));
  }

  async claimCounsellingInquiryRetry(
    id: number,
    attemptedAt: Date,
    verifiedByUserId: number,
  ): Promise<Inquiry | undefined> {
    const staleBefore = new Date(attemptedAt.getTime() - 2 * 60 * 1000);
    return db.transaction(async (tx) => {
      const [result] = await tx.update(inquiries).set({
        counsellingDeliveryStatus: "retrying",
        counsellingDeliveryAttempts: sql`${inquiries.counsellingDeliveryAttempts} + 1`,
        counsellingDeliveryLastAttemptAt: attemptedAt,
        counsellingDeliveryLastResult: "sending",
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
      if (!result) return undefined;
      await tx.insert(counsellingDeliveryAttemptRecords).values({
        inquiryId: result.id,
        attemptNumber: result.counsellingDeliveryAttempts,
        deliveryState: "sending",
        attemptedAt,
      });
      return result;
    });
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
    result: CounsellingDeliveryAttemptResult,
  ): Promise<Inquiry | undefined> {
    return db.transaction(async (tx) => {
      const [recorded] = await tx.update(inquiries).set({
        counsellingDeliveryStatus: result.status,
        counsellingDeliveryLastResult: result.lastResult,
      }).where(and(
        eq(inquiries.id, id),
        eq(inquiries.counsellingDeliveryAttempts, attemptNumber),
        or(
          eq(inquiries.counsellingDeliveryStatus, "sending"),
          eq(inquiries.counsellingDeliveryStatus, "retrying"),
        ),
      )).returning();
      if (!recorded) return undefined;
      const [attempt] = await tx.update(counsellingDeliveryAttemptRecords).set({
        deliveryState: result.status,
        responseAt: result.responseAt,
        httpStatus: result.httpStatus,
        errorSummary: result.errorSummary,
      }).where(and(
        eq(counsellingDeliveryAttemptRecords.inquiryId, id),
        eq(counsellingDeliveryAttemptRecords.attemptNumber, attemptNumber),
        eq(counsellingDeliveryAttemptRecords.deliveryState, "sending"),
      )).returning({ id: counsellingDeliveryAttemptRecords.id });
      if (!attempt) throw new Error("Counselling delivery attempt record missing.");
      return recorded;
    });
  }
}

export const storage = new DatabaseStorage();
