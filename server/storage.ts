import { type InsertInquiry, type Inquiry, inquiries } from "@shared/schema";
import { db } from "./db";

export interface IStorage {
  createInquiry(inquiry: InsertInquiry): Promise<Inquiry>;
}

export class DatabaseStorage implements IStorage {
  async createInquiry(inquiry: InsertInquiry): Promise<Inquiry> {
    const [result] = await db.insert(inquiries).values(inquiry).returning();
    return result;
  }
}

export const storage = new DatabaseStorage();
