import type { Express, NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { admissionsCaptureLimits, admissionsLeads, admissionsPlaybacks, admissionsRegistrationOutbox, admissionsVideoEvents } from "@shared/admissions-schema";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { registerVslLead, type AdmissionsDatabase } from "./identity";
import { observePlayback } from "./playback";
import { getVslDuration } from "../vsl-media";
import { followUpSchemaReady } from "./follow-up";
import { kickVslOutbox, startVslOutboxWorker } from "./outbox-dispatcher";
import { VSL_WHATSAPP_CONSENT_VERSION } from "@shared/vsl-consent";
import { enqueueMetaEvent, metaSchemaReady } from "../meta/events";
import { safeMetaEventSourceUrl, visitorKey } from "../meta/http";
import { parseMetaAttribution } from "../meta/attribution";

declare module "express-session" {
  interface SessionData { admissionsLeadId?: string }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function sameOriginCapture(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  // Require a same-origin browser write, reject cross-site and missing Origin.
  if (!origin || req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ message: "Same-origin request required." });
  try {
    const parsed = new URL(origin);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.host !== req.get("host")) throw new Error();
  } catch { return res.status(403).json({ message: "Same-origin request required." }); }
  return next();
}

export function captureLimit(scope: string, limit: number, database: AdmissionsDatabase = db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() - 15 * 60 * 1000);
      const keyHash = hash(`admissions:${scope}:${req.ip ?? "unknown"}`);
      const [row] = await database.insert(admissionsCaptureLimits).values({ keyHash, windowStartedAt: now, attempts: 1 })
        .onConflictDoUpdate({
          target: admissionsCaptureLimits.keyHash,
          set: {
            windowStartedAt: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN ${now} ELSE ${admissionsCaptureLimits.windowStartedAt} END`,
            attempts: sql`CASE WHEN ${admissionsCaptureLimits.windowStartedAt} < ${cutoff} THEN 1 ELSE LEAST(${admissionsCaptureLimits.attempts} + 1, ${limit + 1}) END`,
          },
        }).returning();
      if (row.attempts > limit) {
        res.setHeader("Retry-After", "900");
        return res.status(429).json({ message: "Too many requests. Please try again later." });
      }
      return next();
    } catch { return res.status(503).json({ message: "Lead capture is temporarily unavailable." }); }
  };
}

const mobile = z.string().trim().max(32).refine(v => normalizeIndianMobile(v) !== null, "Enter a valid Indian mobile number.");
const registrationSchema = z.object({
  name: z.string().trim().min(2).max(120), phone: mobile,
  entryPath: z.enum(["/", "/vsl"]).default("/vsl"),
  whatsappAdmissionsConsent:z.boolean().default(false),
  consentVersion:z.literal(VSL_WHATSAPP_CONSENT_VERSION).optional(),
  attribution: z.unknown().optional(),
}).strict().refine(v=>!v.whatsappAdmissionsConsent || !!v.consentVersion);
const eventSchema = z.object({
  playbackId: z.string().uuid(), sequence: z.number().int().min(1).max(100000),
  type: z.enum(["play", "sample", "pause", "seek", "ended"]),
  position: z.number().finite().min(0).max(14400),
  duration: z.number().finite().positive().max(14400),
}).strict();

export function registerAdmissionsRoutes(app: Express, database: AdmissionsDatabase = db, mediaDuration = getVslDuration) {
  startVslOutboxWorker();
  app.get("/api/vsl/registration-options",async (_req,res)=>{
    res.setHeader("Cache-Control","no-store");
    try {return res.json({whatsappConsentAvailable:await followUpSchemaReady(database),consentVersion:VSL_WHATSAPP_CONSENT_VERSION});}
    catch {return res.json({whatsappConsentAvailable:false,consentVersion:VSL_WHATSAPP_CONSENT_VERSION});}
  });
  app.post("/api/vsl/registrations", sameOriginCapture, captureLimit("register", 20, database), async (req, res) => {
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Enter your name and a valid Indian mobile number." });
    try {
      if(parsed.data.whatsappAdmissionsConsent && !await followUpSchemaReady(database))
        return res.status(503).json({message:"Optional consent saving is not enabled yet. You can still watch without selecting it."});
      const registeredAt = new Date();
      const lead = await registerVslLead(
        { ...parsed.data, entryHost: req.hostname.slice(0, 253) },
        registeredAt,
        database,
        {
          visitorKeyHash: visitorKey(req),
          eventSourceUrl: safeMetaEventSourceUrl(req, parsed.data.entryPath),
          attribution: parseMetaAttribution(parsed.data.attribution),
        },
      );
      req.session.admissionsLeadId = lead.id;
      await new Promise<void>((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
      // Identity is carried in an HttpOnly session. No public lead details returned.
      kickVslOutbox();
      return res.status(201).json({ registered: true, metaEventId: lead.metaEventId ?? null });
    } catch { return res.status(503).json({ message: "Unable to save registration. Please try again." }); }
  });
  app.post("/api/vsl/playbacks", sameOriginCapture, captureLimit("playback", 30, database), async (req, res) => {
    const leadId = req.session.admissionsLeadId;
    if (!leadId) return res.status(401).json({ message: "Register to link video activity." });
    try {
      const duration = await mediaDuration();
      const [playback] = await database.insert(admissionsPlaybacks).values({
        leadId, duration, sessionHash: hash(req.sessionID),
      }).returning({ id: admissionsPlaybacks.id });
      return res.status(201).json({ playbackId: playback.id });
    } catch { return res.status(503).json({ message: "Video activity could not be initialized." }); }
  });
  app.post("/api/vsl/events", sameOriginCapture, captureLimit("events", 1500, database), async (req, res) => {
    const leadId = req.session.admissionsLeadId;
    if (!leadId) return res.status(401).json({ message: "Register to link video activity." });
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid video observation." });
    try {
      const sample = parsed.data;
      const result = await database.transaction(async (tx) => {
        const [playback] = await tx.select().from(admissionsPlaybacks).where(and(
          eq(admissionsPlaybacks.id, sample.playbackId), eq(admissionsPlaybacks.leadId, leadId),
          eq(admissionsPlaybacks.sessionHash, hash(req.sessionID)),
        )).for("update");
        if (!playback) return { accepted:false, changed:false };
        if (Date.now() - playback.createdAt.getTime() > 24 * 60 * 60 * 1000) return { accepted:false, changed:false };
        const now = new Date();
        const result = observePlayback(playback, sample, now);
        if (!result.duplicate) {
          const observedPercent = result.observedPercent ?? 0;
          await tx.update(admissionsPlaybacks).set(result.state).where(eq(admissionsPlaybacks.id, playback.id));
          const [lead] = await tx.select().from(admissionsLeads).where(eq(admissionsLeads.id,leadId)).limit(1);
          if (!lead) return { accepted:false, changed:false };
          await tx.update(admissionsLeads).set({
            videoObservedPercent: sql`greatest(${admissionsLeads.videoObservedPercent}, ${result.observedPercent})`,
            ...(result.events.length ? {
              videoLastMilestone:result.events.at(-1),
              videoLastEventAt:now,
            } : {}),
            ...(result.events.includes("completed") ? {
              videoCompletedAt:sql`coalesce(${admissionsLeads.videoCompletedAt}, ${now})`,
            } : {}),
          }).where(eq(admissionsLeads.id,leadId));
          let metaEvents: { eventName: string; eventId: string; customData: Record<string, string | number | boolean> }[] = [];
          if (result.events.length) {
            const insertedEvents = await tx.insert(admissionsVideoEvents).values(result.events.map(event => ({
              leadId, event, occurredAt: now, positionSeconds: sample.position, durationSeconds: playback.duration,
            }))).onConflictDoNothing().returning({ event: admissionsVideoEvents.event });
            if (insertedEvents.length && await metaSchemaReady(tx)) {
              const sourceUrl = safeMetaEventSourceUrl(req, "/vsl-video");
              if (sourceUrl) {
                for (const inserted of insertedEvents) {
                  const completed = inserted.event === "completed";
                  const eventName = completed ? "VslCompleted" : "VslProgress";
                  const eventId = await enqueueMetaEvent(tx, {
                    visitorKeyHash: visitorKey(req), leadId, eventName, eventSourceUrl: sourceUrl,
                    customData: { milestone: inserted.event, observed_percent: observedPercent },
                    occurredAt: now,
                  });
                  if (eventId) metaEvents.push({
                    eventName, eventId,
                    customData: { milestone: inserted.event, observed_percent: observedPercent },
                  });
                }
              }
            }
            if(await followUpSchemaReady(tx)) {
              await tx.insert(admissionsRegistrationOutbox).values(result.events.map(event=>{
                const eventId=`vsl-progress:${leadId}:${event}`;
                return {
                  leadId,eventType:"vsl.progress",idempotencyKey:eventId,
                  payload:{
                    schemaVersion:1,event:"vsl.progress",eventId,leadId,phone:lead.canonicalPhone,
                    milestone:event,observedPercent:result.observedPercent,
                    positionSeconds:sample.position,durationSeconds:playback.duration,
                    occurredAt:now.toISOString(),completedAt:event==="completed" ? now.toISOString() : lead.videoCompletedAt?.toISOString() ?? null,
                  },
                };
              })).onConflictDoNothing();
            }
          }
          return { accepted:true, changed:result.events.length>0, metaEvents };
        }
        return { accepted:true, changed:false, metaEvents:[] };
      });
      if (!result.accepted) return res.status(403).json({ message: "Video observation is not associated with this registration." });
      if (result.changed) kickVslOutbox();
      return res.json({ saved: true, metaEvents: result.metaEvents });
    } catch (error) {
      if (error instanceof Error && ["out_of_order", "invalid_media_duration", "too_many_discontinuities"].includes(error.message)) {
        return res.status(409).json({ message: "Video observation sequence is invalid." });
      }
      return res.status(503).json({ message: "Video activity could not be saved." });
    }
  });
}
