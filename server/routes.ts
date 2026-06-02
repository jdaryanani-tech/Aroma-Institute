import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertInquirySchema } from "@shared/schema";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "aroma@2024";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.post("/api/inquiries", async (req, res) => {
    try {
      const data = insertInquirySchema.parse(req.body);
      const inquiry = await storage.createInquiry(data);
      res.status(201).json(inquiry);
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        res.status(400).json({ message: validationError.message });
      } else {
        res.status(500).json({ message: "Failed to submit inquiry" });
      }
    }
  });

  app.get("/api/admin/inquiries", async (req, res) => {
    const token = req.headers["x-admin-password"] as string;
    if (token !== ADMIN_PASSWORD) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const data = await storage.getInquiries();
      res.json(data);
    } catch {
      res.status(500).json({ message: "Failed to fetch inquiries" });
    }
  });

  return httpServer;
}
