import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertInquirySchema } from "@shared/schema";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { configureLmsSessions, requireLmsRole, requireLmsUser } from "./lms/auth";
import { registerLmsRoutes } from "./lms/routes";
import { registerLmsManagementRoutes } from "./lms/management-routes";

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

  return httpServer;
}
