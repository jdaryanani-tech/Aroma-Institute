import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertCounsellingInquirySchema, insertInquirySchema } from "@shared/schema";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { configureLmsSessions, requireLmsRole, requireLmsUser } from "./lms/auth";
import { registerLmsRoutes } from "./lms/routes";
import { registerLmsManagementRoutes } from "./lms/management-routes";
import { registerVslMediaRoutes } from "./vsl-media";
import { sendCounsellingInquiryToN8n } from "./n8n-counselling";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  configureLmsSessions(app);

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

  app.post("/api/counselling-inquiries", async (req, res) => {
    try {
      const data = insertCounsellingInquirySchema.parse(req.body);
      const inquiry = await storage.createInquiry(data);
      const delivery = await sendCounsellingInquiryToN8n({
        ...inquiry,
        counsellingAnswers: data.counsellingAnswers,
      });
      if (delivery.status !== "sent") {
        console.error("[counselling] n8n delivery did not complete", {
          inquiryId: inquiry.id,
          status: delivery.status,
          ...(delivery.status === "failed" ? { reason: delivery.reason, httpStatus: delivery.httpStatus } : {}),
        });
      }
      res.status(201).json({
        id: inquiry.id,
        bookingStatus: "pending_availability_check",
        n8nDelivery: delivery.status,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = fromZodError(error);
        res.status(400).json({ message: validationError.message });
      } else {
        res.status(500).json({ message: "Failed to submit counselling request" });
      }
    }
  });

  app.get(
    "/api/admin/inquiries",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const data = await storage.getInquiries();
        res.json(data);
      } catch {
        res.status(500).json({ message: "Failed to fetch inquiries" });
      }
    },
  );

  registerLmsRoutes(app);
  registerLmsManagementRoutes(app);
  registerVslMediaRoutes(app);

  return httpServer;
}
