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
import { registerAdmissionsRoutes, captureLimit, sameOriginCapture } from "./admissions/routes";
import { registerFollowUpStatusRoute } from "./admissions/follow-up-routes";
import { registerCrmRoutes } from "./crm/routes";
import { registerFirstOwnerRoutes } from "./lms/first-owner";
import {
  sendCounsellingInquiryToN8n,
  summarizeCounsellingDeliveryResult,
} from "./n8n-counselling";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  configureLmsSessions(app);
  registerFirstOwnerRoutes(app);
  registerAdmissionsRoutes(app);
  registerFollowUpStatusRoute(app);
  registerCrmRoutes(app);

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

  app.post("/api/counselling-inquiries", sameOriginCapture, captureLimit("counselling", 12), async (req, res) => {
    try {
      const data = insertCounsellingInquirySchema.parse(req.body);
      const submittedAt = new Date();
      const inquiry = await storage.createCounsellingInquiry(data, submittedAt);
      let attempt: typeof inquiry | undefined;
      try {
        attempt = await storage.startCounsellingDeliveryAttempt(inquiry.id, new Date());
      } catch {
        console.error("[counselling] delivery attempt could not be started", { inquiryId: inquiry.id });
      }
      if (attempt) {
        const delivery = await sendCounsellingInquiryToN8n({
          ...attempt,
          counsellingAnswers: data.counsellingAnswers,
        });
        const deliverySummary = summarizeCounsellingDeliveryResult(delivery);
        try {
          const recorded = await storage.finishCounsellingDeliveryAttempt(
            inquiry.id,
            attempt.counsellingDeliveryAttempts,
            deliverySummary,
          );
          if (!recorded) {
            console.error("[counselling] delivery result was not persisted", { inquiryId: inquiry.id });
          }
        } catch {
          console.error("[counselling] delivery result was not persisted", { inquiryId: inquiry.id });
        }
        if (delivery.status !== "acknowledged") {
          console.error("[counselling] n8n delivery was not acknowledged", {
            inquiryId: inquiry.id,
            reason: deliverySummary.errorSummary,
            httpStatus: deliverySummary.httpStatus,
          });
        }
      }
      res.status(201).json({
        id: inquiry.id,
        bookingStatus: "pending_availability_check",
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

  app.post(
    "/api/admin/inquiries/:id/retry-counselling-delivery",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const rawId = typeof req.params.id === "string" ? req.params.id : "";
      const inquiryId = Number(rawId);
      if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(inquiryId)) {
        return res.status(400).json({ message: "Invalid inquiry ID." });
      }
      if (req.body?.verifiedNotDelivered !== true) {
        return res.status(400).json({
          message: "Admin verification that the submission is not already received is required.",
        });
      }
      const verifiedByUserId = req.lmsUser?.id;
      if (!verifiedByUserId) {
        return res.status(401).json({ message: "Authentication required." });
      }

      try {
        const claimed = await storage.claimCounsellingInquiryRetry(
          inquiryId,
          new Date(),
          verifiedByUserId,
        );
        if (!claimed) {
          const existing = await storage.getCounsellingDeliveryState(inquiryId);
          if (!existing) return res.status(404).json({ message: "Inquiry not found." });
          return res.status(409).json({
            message: "This inquiry is not currently eligible for a delivery retry.",
            deliveryStatus: existing.counsellingDeliveryStatus,
          });
        }

        if (!claimed.counsellingAnswers || !claimed.counsellingSubmittedAt) {
          const result = await storage.finishCounsellingDeliveryAttempt(
            inquiryId,
            claimed.counsellingDeliveryAttempts,
            {
              status: "failed",
              lastResult: "missing_stored_counselling_data",
              responseAt: null,
              httpStatus: null,
              errorSummary: "missing_stored_counselling_data",
            },
          );
          return res.status(409).json({
            message: "This inquiry is missing stored counselling data and cannot be retried.",
            deliveryStatus: result?.counsellingDeliveryStatus ?? "failed",
          });
        }

        const delivery = await sendCounsellingInquiryToN8n({
          ...claimed,
          counsellingAnswers: claimed.counsellingAnswers,
        });
        const summary = summarizeCounsellingDeliveryResult(delivery);
        const recorded = await storage.finishCounsellingDeliveryAttempt(
          inquiryId,
          claimed.counsellingDeliveryAttempts,
          summary,
        );
        if (!recorded) {
          console.error("[counselling] retry result was not persisted", { inquiryId });
          return res.status(500).json({ message: "Retry result could not be saved." });
        }

        if (delivery.status !== "acknowledged") {
          console.error("[counselling] admin retry was not acknowledged", {
            inquiryId,
            reason: summary.errorSummary,
            httpStatus: summary.httpStatus,
          });
        }

        return res.json({
          id: recorded.id,
          deliveryStatus: recorded.counsellingDeliveryStatus,
          attempts: recorded.counsellingDeliveryAttempts,
          lastAttemptAt: recorded.counsellingDeliveryLastAttemptAt,
          lastResult: recorded.counsellingDeliveryLastResult,
          lastVerifiedAt: recorded.counsellingDeliveryLastVerifiedAt,
        });
      } catch {
        return res.status(500).json({ message: "Unable to retry counselling delivery." });
      }
    },
  );

  app.get(
    "/api/admin/inquiries",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        res.setHeader("Cache-Control", "private, no-store");
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
