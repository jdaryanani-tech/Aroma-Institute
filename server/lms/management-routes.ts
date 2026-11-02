import { randomBytes, randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  lmsAssessmentAttempts,
  lmsAssessmentOptions,
  lmsAssessmentQuestions,
  lmsAssessmentVersions,
  lmsAssessments,
  lmsAttendance,
  lmsAuditLogs,
  lmsCertificates,
  lmsChapters,
  lmsCourses,
  lmsEnrollments,
  lmsLessonProgress,
  lmsLessons,
  lmsLiveSessions,
  lmsModules,
  lmsNotifications,
  lmsResources,
  lmsTrainerAssignments,
  lmsUserRoles,
  lmsUsers,
} from "@shared/lms-schema";
import { db } from "../db";
import { requireLmsRole, requireLmsUser } from "./auth";
import { issueLmsPasswordSetupLink } from "./password-auth";
import { normalizeLmsPhone } from "./password-security";
import {
  canDownloadLmsCertificate,
  canManageLmsCourse,
  MAX_LMS_RESOURCE_BYTES,
  validateLmsResource,
} from "./access-policy";
import { BARISTA_EXECUTIVE_CURRICULUM } from "@shared/barista-executive-curriculum";

const nameSchema = z.string().trim().min(2).max(180);
const descriptionSchema = z.string().trim().max(5000).default("");

const moduleInput = z.object({
  title: nameSchema,
  description: descriptionSchema,
  position: z.number().int().min(0).default(0),
});

const chapterInput = moduleInput;

const lessonInput = z.object({
  title: nameSchema,
  description: descriptionSchema,
  youtubeUrl: z
    .string()
    .url()
    .nullable()
    .optional()
    .refine((value) => {
      if (!value) return true;
      const parsed = new URL(value);
      return (
        (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
        parsed.pathname === "/watch" &&
        Boolean(parsed.searchParams.get("v"))
      ) || (
        (parsed.hostname === "youtu.be" || parsed.hostname === "www.youtu.be") &&
        parsed.pathname.length > 1
      );
    }, "Enter a valid YouTube video URL."),
  durationMinutes: z.number().int().min(1).max(1000).nullable().optional(),
  position: z.number().int().min(0).default(0),
  requiredForAssessment: z.boolean().default(true),
});

const assessmentInput = z.object({
  title: nameSchema,
  instructions: z.string().trim().max(5000).default(""),
  showExplanationsAfterAttempt: z.boolean().default(false),
  questions: z
    .array(
      z.object({
        prompt: z.string().trim().min(2).max(2000),
        explanation: z.string().trim().max(3000).nullable().optional(),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(500),
              isCorrect: z.boolean(),
            }),
          )
          .min(2)
          .max(10)
          .refine((options) => options.filter((option) => option.isCorrect).length === 1),
      }),
    )
    .min(1)
    .max(100),
});

const liveSessionInput = z.object({
  courseId: z.number().int().positive(),
  title: nameSchema,
  topic: z.string().trim().max(2000).default(""),
  meetUrl: z.string().url().refine((value) => new URL(value).hostname === "meet.google.com"),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  trainerId: z.number().int().positive().nullable().optional(),
});

async function courseForModule(moduleId: number) {
  const [row] = await db
    .select({ courseId: lmsModules.courseId })
    .from(lmsModules)
    .where(eq(lmsModules.id, moduleId))
    .limit(1);
  return row?.courseId;
}

async function courseForChapter(chapterId: number) {
  const [row] = await db
    .select({ courseId: lmsModules.courseId })
    .from(lmsChapters)
    .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
    .where(eq(lmsChapters.id, chapterId))
    .limit(1);
  return row?.courseId;
}

async function courseForLesson(lessonId: number) {
  const [row] = await db
    .select({ courseId: lmsModules.courseId })
    .from(lmsLessons)
    .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
    .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
    .where(eq(lmsLessons.id, lessonId))
    .limit(1);
  return row?.courseId;
}

async function canManageCourse(courseId: number, userId: number, roles: string[]) {
  if (roles.includes("admin")) return canManageLmsCourse(roles, false);
  if (!roles.includes("trainer")) return canManageLmsCourse(roles, false);
  const [assignment] = await db
    .select({ id: lmsTrainerAssignments.id })
    .from(lmsTrainerAssignments)
    .where(
      and(
        eq(lmsTrainerAssignments.courseId, courseId),
        eq(lmsTrainerAssignments.trainerId, userId),
      ),
    )
    .limit(1);
  return canManageLmsCourse(roles, Boolean(assignment));
}

async function appendAudit(
  actorId: number,
  action: string,
  entityType: string,
  entityId: string | number,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(lmsAuditLogs).values({
    actorId,
    action,
    entityType,
    entityId: String(entityId),
    metadata,
  });
}

async function refreshCertificateEligibility(enrollmentId: number) {
  const [enrollment] = await db
    .select({ courseId: lmsEnrollments.courseId })
    .from(lmsEnrollments)
    .where(eq(lmsEnrollments.id, enrollmentId))
    .limit(1);
  if (!enrollment) return null;

  const requiredLessons = await db
    .select({ id: lmsLessons.id })
    .from(lmsLessons)
    .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
    .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
    .where(
      and(
        eq(lmsModules.courseId, enrollment.courseId),
        eq(lmsModules.status, "published"),
        eq(lmsChapters.status, "published"),
        eq(lmsLessons.status, "published"),
        eq(lmsLessons.requiredForAssessment, true),
      ),
    );
  let eligible = requiredLessons.length > 0;
  if (eligible) {
    const completed = await db
      .select({ lessonId: lmsLessonProgress.lessonId })
      .from(lmsLessonProgress)
      .where(
        and(
          eq(lmsLessonProgress.enrollmentId, enrollmentId),
          inArray(lmsLessonProgress.lessonId, requiredLessons.map(({ id }) => id)),
          sql`${lmsLessonProgress.completedAt} IS NOT NULL`,
        ),
      );
    eligible = completed.length === requiredLessons.length;
  }

  const assessments = await db
    .select({ id: lmsAssessments.id })
    .from(lmsAssessments)
    .innerJoin(lmsChapters, eq(lmsAssessments.chapterId, lmsChapters.id))
    .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
    .where(
      and(
        eq(lmsModules.courseId, enrollment.courseId),
        eq(lmsModules.status, "published"),
        eq(lmsChapters.status, "published"),
        eq(lmsAssessments.status, "published"),
      ),
    );
  if (eligible && assessments.length > 0) {
    const passed = await db
      .select({ assessmentId: lmsAssessmentAttempts.assessmentId })
      .from(lmsAssessmentAttempts)
      .where(
        and(
          eq(lmsAssessmentAttempts.enrollmentId, enrollmentId),
          inArray(lmsAssessmentAttempts.assessmentId, assessments.map(({ id }) => id)),
          eq(lmsAssessmentAttempts.passed, true),
        ),
      );
    eligible = new Set(passed.map(({ assessmentId }) => assessmentId)).size === assessments.length;
  }

  const [existing] = await db
    .select()
    .from(lmsCertificates)
    .where(eq(lmsCertificates.enrollmentId, enrollmentId))
    .limit(1);
  if (!existing) {
    const [certificate] = await db
      .insert(lmsCertificates)
      .values({
        enrollmentId,
        status: eligible ? "eligible" : "not_eligible",
      })
      .returning();
    return certificate;
  }
  if (existing.status === "approved" || existing.status === "pending_review") return existing;
  const [certificate] = await db
    .update(lmsCertificates)
    .set({ status: eligible ? "eligible" : "not_eligible", updatedAt: new Date() })
    .where(eq(lmsCertificates.id, existing.id))
    .returning();
  return certificate;
}

export function registerLmsManagementRoutes(app: Express) {
  app.post(
    "/api/lms/admin/curriculum/barista-executive",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      try {
        const [existing] = await db
          .select({ id: lmsCourses.id })
          .from(lmsCourses)
          .where(eq(lmsCourses.slug, BARISTA_EXECUTIVE_CURRICULUM.slug))
          .limit(1);
        if (existing) {
          return res.json({ created: false, courseId: existing.id });
        }

        const imported = await db.transaction(async (tx) => {
          const [course] = await tx
            .insert(lmsCourses)
            .values({
              slug: BARISTA_EXECUTIVE_CURRICULUM.slug,
              title: BARISTA_EXECUTIVE_CURRICULUM.title,
              description: BARISTA_EXECUTIVE_CURRICULUM.description,
              status: "draft",
              createdBy: req.lmsUser!.id,
            })
            .returning({ id: lmsCourses.id });

          let chapterCount = 0;
          for (let modulePosition = 0; modulePosition < BARISTA_EXECUTIVE_CURRICULUM.modules.length; modulePosition += 1) {
            const module = BARISTA_EXECUTIVE_CURRICULUM.modules[modulePosition];
            const [createdModule] = await tx
              .insert(lmsModules)
              .values({
                courseId: course.id,
                title: module.title,
                description: module.description,
                position: modulePosition,
                status: "draft",
              })
              .returning({ id: lmsModules.id });

            for (let chapterPosition = 0; chapterPosition < module.chapters.length; chapterPosition += 1) {
              const chapter = module.chapters[chapterPosition];
              const [createdChapter] = await tx
                .insert(lmsChapters)
                .values({
                  moduleId: createdModule.id,
                  title: chapter.title,
                  description: chapter.description,
                  position: chapterPosition,
                  status: "draft",
                })
                .returning({ id: lmsChapters.id });

              await tx.insert(lmsLessons).values({
                chapterId: createdChapter.id,
                title: chapter.title,
                description: "Chapter video placeholder. Attach the video before publishing this course.",
                youtubeUrl: null,
                durationMinutes: null,
                position: 0,
                requiredForAssessment: false,
                status: "draft",
              });
              chapterCount += 1;
            }
          }

          await tx.insert(lmsAuditLogs).values({
            actorId: req.lmsUser!.id,
            action: "curriculum.imported",
            entityType: "course",
            entityId: String(course.id),
            metadata: {
              slug: BARISTA_EXECUTIVE_CURRICULUM.slug,
              modules: BARISTA_EXECUTIVE_CURRICULUM.modules.length,
              chapters: chapterCount,
            },
          });

          return {
            courseId: course.id,
            modules: BARISTA_EXECUTIVE_CURRICULUM.modules.length,
            chapters: chapterCount,
          };
        });

        return res.status(201).json({ created: true, ...imported });
      } catch (error) {
        console.error("[lms] Barista Executive curriculum import failed", error);
        return res.status(500).json({
          message: "The curriculum could not be imported.",
        });
      }
    },
  );

  app.patch(
    "/api/lms/profile",
    requireLmsUser,
    async (req, res) => {
      const parsed = z.object({ displayName: nameSchema }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Enter a name between 2 and 180 characters." });
      try {
        const [updated] = await db
          .update(lmsUsers)
          .set({ displayName: parsed.data.displayName, updatedAt: new Date() })
          .where(eq(lmsUsers.id, req.lmsUser!.id))
          .returning({ id: lmsUsers.id, phoneE164: lmsUsers.phoneE164, displayName: lmsUsers.displayName });
        await appendAudit(req.lmsUser!.id, "profile.updated", "user", req.lmsUser!.id);
        res.json(updated);
      } catch {
        res.status(500).json({ message: "Unable to update your profile." });
      }
    },
  );

  app.get(
    "/api/lms/notifications",
    requireLmsUser,
    async (req, res) => {
      try {
        const notifications = await db
          .select()
          .from(lmsNotifications)
          .where(eq(lmsNotifications.userId, req.lmsUser!.id))
          .orderBy(desc(lmsNotifications.createdAt))
          .limit(100);
        res.json(notifications);
      } catch {
        res.status(500).json({ message: "Unable to load notifications." });
      }
    },
  );

  app.patch(
    "/api/lms/notifications/:notificationId/read",
    requireLmsUser,
    async (req, res) => {
      const notificationId = Number(req.params.notificationId);
      if (!Number.isSafeInteger(notificationId) || notificationId < 1) {
        return res.status(400).json({ message: "Invalid notification." });
      }
      try {
        const [updated] = await db
          .update(lmsNotifications)
          .set({ readAt: new Date() })
          .where(and(
            eq(lmsNotifications.id, notificationId),
            eq(lmsNotifications.userId, req.lmsUser!.id),
          ))
          .returning();
        if (!updated) return res.status(404).json({ message: "Notification not found." });
        res.json(updated);
      } catch {
        res.status(500).json({ message: "Unable to update this notification." });
      }
    },
  );

  app.get(
    "/api/lms/manage/courses/:courseId/outline",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const courseId = Number(req.params.courseId);
      if (!Number.isSafeInteger(courseId) || courseId < 1) {
        return res.status(400).json({ message: "Invalid course." });
      }
      try {
        if (!(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Course not found." });
        }
        const [course] = await db
          .select()
          .from(lmsCourses)
          .where(eq(lmsCourses.id, courseId))
          .limit(1);
        if (!course) return res.status(404).json({ message: "Course not found." });
        const modules = await db
          .select()
          .from(lmsModules)
          .where(eq(lmsModules.courseId, courseId))
          .orderBy(asc(lmsModules.position));
        const result = await Promise.all(
          modules.map(async (module) => {
            const chapters = await db
              .select()
              .from(lmsChapters)
              .where(eq(lmsChapters.moduleId, module.id))
              .orderBy(asc(lmsChapters.position));
            return {
              ...module,
              chapters: await Promise.all(
                chapters.map(async (chapter) => {
                  const [lessons, assessment] = await Promise.all([
                    db
                      .select()
                      .from(lmsLessons)
                      .where(eq(lmsLessons.chapterId, chapter.id))
                      .orderBy(asc(lmsLessons.position)),
                    db
                      .select()
                      .from(lmsAssessments)
                      .where(eq(lmsAssessments.chapterId, chapter.id))
                      .limit(1),
                  ]);
                  const lessonIds = lessons.map(({ id }) => id);
                  const resources = lessonIds.length
                    ? await db
                        .select({
                          id: lmsResources.id,
                          lessonId: lmsResources.lessonId,
                          fileName: lmsResources.fileName,
                          contentType: lmsResources.contentType,
                          byteSize: lmsResources.byteSize,
                        })
                        .from(lmsResources)
                        .where(inArray(lmsResources.lessonId, lessonIds))
                    : [];
                  const resourcesByLesson = new Map<number, typeof resources>();
                  for (const resource of resources) {
                    const current = resourcesByLesson.get(resource.lessonId) ?? [];
                    current.push(resource);
                    resourcesByLesson.set(resource.lessonId, current);
                  }
                  return {
                    ...chapter,
                    lessons: lessons.map((lesson) => ({
                      ...lesson,
                      resources: resourcesByLesson.get(lesson.id) ?? [],
                    })),
                    assessment: assessment[0] ?? null,
                  };
                }),
              ),
            };
          }),
        );
        res.json({ course, modules: result });
      } catch {
        res.status(500).json({ message: "Unable to load the course outline." });
      }
    },
  );

  app.post(
    "/api/lms/manage/courses/:courseId/modules",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const courseId = Number(req.params.courseId);
      const parsed = moduleInput.safeParse(req.body);
      if (!Number.isSafeInteger(courseId) || courseId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Enter a valid module." });
      }
      try {
        if (!(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Course not found." });
        }
        const [module] = await db
          .insert(lmsModules)
          .values({ ...parsed.data, courseId })
          .returning();
        await appendAudit(req.lmsUser!.id, "module.created", "module", module.id, { courseId });
        res.status(201).json(module);
      } catch {
        res.status(500).json({ message: "Unable to create the module." });
      }
    },
  );

  app.patch(
    "/api/lms/manage/modules/:moduleId",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const moduleId = Number(req.params.moduleId);
      const parsed = z
        .object({
          title: nameSchema.optional(),
          description: z.string().trim().max(5000).optional(),
          position: z.number().int().min(0).optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!Number.isSafeInteger(moduleId) || moduleId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid module update." });
      }
      try {
        const courseId = await courseForModule(moduleId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Module not found." });
        }
        const [module] = await db
          .update(lmsModules)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(lmsModules.id, moduleId))
          .returning();
        await appendAudit(req.lmsUser!.id, "module.updated", "module", moduleId);
        res.json(module);
      } catch {
        res.status(500).json({ message: "Unable to update the module." });
      }
    },
  );

  app.post(
    "/api/lms/manage/modules/:moduleId/status",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const moduleId = Number(req.params.moduleId);
      const parsed = z.object({ status: z.enum(["draft", "published", "archived"]) }).safeParse(req.body);
      if (!Number.isSafeInteger(moduleId) || moduleId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid module status." });
      }
      try {
        const [module] = await db
          .update(lmsModules)
          .set({ status: parsed.data.status, updatedAt: new Date() })
          .where(eq(lmsModules.id, moduleId))
          .returning();
        if (!module) return res.status(404).json({ message: "Module not found." });
        await appendAudit(req.lmsUser!.id, `module.${parsed.data.status}`, "module", moduleId);
        res.json(module);
      } catch {
        res.status(500).json({ message: "Unable to update module status." });
      }
    },
  );

  app.post(
    "/api/lms/manage/modules/:moduleId/chapters",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const moduleId = Number(req.params.moduleId);
      const parsed = chapterInput.safeParse(req.body);
      if (!Number.isSafeInteger(moduleId) || moduleId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Enter a valid chapter." });
      }
      try {
        const courseId = await courseForModule(moduleId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Module not found." });
        }
        const [chapter] = await db
          .insert(lmsChapters)
          .values({ ...parsed.data, moduleId })
          .returning();
        await appendAudit(req.lmsUser!.id, "chapter.created", "chapter", chapter.id, { moduleId });
        res.status(201).json(chapter);
      } catch {
        res.status(500).json({ message: "Unable to create the chapter." });
      }
    },
  );

  app.patch(
    "/api/lms/manage/chapters/:chapterId",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const chapterId = Number(req.params.chapterId);
      const parsed = z
        .object({
          title: nameSchema.optional(),
          description: z.string().trim().max(5000).optional(),
          position: z.number().int().min(0).optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!Number.isSafeInteger(chapterId) || chapterId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid chapter update." });
      }
      try {
        const courseId = await courseForChapter(chapterId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Chapter not found." });
        }
        const [chapter] = await db
          .update(lmsChapters)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(lmsChapters.id, chapterId))
          .returning();
        await appendAudit(req.lmsUser!.id, "chapter.updated", "chapter", chapterId);
        res.json(chapter);
      } catch {
        res.status(500).json({ message: "Unable to update the chapter." });
      }
    },
  );

  app.post(
    "/api/lms/manage/chapters/:chapterId/status",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const chapterId = Number(req.params.chapterId);
      const parsed = z.object({ status: z.enum(["draft", "published", "archived"]) }).safeParse(req.body);
      if (!Number.isSafeInteger(chapterId) || chapterId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid chapter status." });
      }
      try {
        const [chapter] = await db
          .update(lmsChapters)
          .set({ status: parsed.data.status, updatedAt: new Date() })
          .where(eq(lmsChapters.id, chapterId))
          .returning();
        if (!chapter) return res.status(404).json({ message: "Chapter not found." });
        await appendAudit(req.lmsUser!.id, `chapter.${parsed.data.status}`, "chapter", chapterId);
        res.json(chapter);
      } catch {
        res.status(500).json({ message: "Unable to update chapter status." });
      }
    },
  );

  app.post(
    "/api/lms/manage/chapters/:chapterId/lessons",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const chapterId = Number(req.params.chapterId);
      const parsed = lessonInput.safeParse(req.body);
      if (!Number.isSafeInteger(chapterId) || chapterId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Enter valid lesson details." });
      }
      try {
        const courseId = await courseForChapter(chapterId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Chapter not found." });
        }
        const [lesson] = await db
          .insert(lmsLessons)
          .values({ ...parsed.data, chapterId, status: "draft" })
          .returning();
        await appendAudit(req.lmsUser!.id, "lesson.created", "lesson", lesson.id, { chapterId });
        res.status(201).json(lesson);
      } catch {
        res.status(500).json({ message: "Unable to create the lesson." });
      }
    },
  );

  app.post(
    "/api/lms/manage/lessons/:lessonId/resources",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    express.raw({
      type: ["application/pdf", "text/plain"],
      limit: MAX_LMS_RESOURCE_BYTES,
    }),
    async (req, res) => {
      const lessonId = Number(req.params.lessonId);
      if (!Number.isSafeInteger(lessonId) || lessonId < 1) {
        return res.status(400).json({ message: "Invalid lesson." });
      }
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ message: "Upload a PDF or UTF-8 plain text file." });
      }

      let fileName: string;
      try {
        fileName = decodeURIComponent(req.get("x-file-name") ?? "");
      } catch {
        return res.status(400).json({ message: "Enter a valid file name." });
      }
      const validation = validateLmsResource(
        fileName,
        req.get("content-type") ?? "",
        req.body,
      );
      if (!validation.ok) return res.status(400).json({ message: validation.message });

      try {
        const courseId = await courseForLesson(lessonId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Lesson not found." });
        }

        const storageKey = `lms/resources/course-${courseId}/lesson-${lessonId}/${randomUUID()}${validation.extension}`;
        const resource = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(lmsResources)
            .values({
              lessonId,
              fileName: validation.fileName,
              contentType: validation.contentType,
              byteSize: req.body.byteLength,
              storageKey,
              fileData: req.body,
              uploadedBy: req.lmsUser!.id,
            })
            .returning({
              id: lmsResources.id,
              lessonId: lmsResources.lessonId,
              fileName: lmsResources.fileName,
              contentType: lmsResources.contentType,
              byteSize: lmsResources.byteSize,
            });
          await tx.insert(lmsAuditLogs).values({
            actorId: req.lmsUser!.id,
            action: "resource.uploaded",
            entityType: "resource",
            entityId: String(created.id),
            metadata: { lessonId, byteSize: created.byteSize },
          });
          return created;
        });
        return res.status(201).json(resource);
      } catch {
        return res.status(500).json({ message: "Unable to save this course resource." });
      }
    },
  );

  app.patch(
    "/api/lms/manage/lessons/:lessonId",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const lessonId = Number(req.params.lessonId);
      const parsed = lessonInput.partial().strict().safeParse(req.body);
      if (!Number.isSafeInteger(lessonId) || lessonId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid lesson update." });
      }
      try {
        const courseId = await courseForLesson(lessonId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Lesson not found." });
        }
        const [lesson] = await db
          .update(lmsLessons)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(lmsLessons.id, lessonId))
          .returning();
        await appendAudit(req.lmsUser!.id, "lesson.updated", "lesson", lessonId);
        res.json(lesson);
      } catch {
        res.status(500).json({ message: "Unable to update the lesson." });
      }
    },
  );

  app.post(
    "/api/lms/manage/lessons/:lessonId/status",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const lessonId = Number(req.params.lessonId);
      const parsed = z.object({ status: z.enum(["draft", "published", "archived"]) }).safeParse(req.body);
      if (!Number.isSafeInteger(lessonId) || lessonId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid publication request." });
      }
      try {
        const [lesson] = await db
          .update(lmsLessons)
          .set({ status: parsed.data.status, updatedAt: new Date() })
          .where(eq(lmsLessons.id, lessonId))
          .returning();
        if (!lesson) return res.status(404).json({ message: "Lesson not found." });
        await appendAudit(req.lmsUser!.id, `lesson.${parsed.data.status}`, "lesson", lessonId);
        res.json(lesson);
      } catch {
        res.status(500).json({ message: "Unable to update lesson status." });
      }
    },
  );

  app.post(
    "/api/lms/manage/chapters/:chapterId/assessments",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const chapterId = Number(req.params.chapterId);
      const parsed = assessmentInput.safeParse(req.body);
      if (!Number.isSafeInteger(chapterId) || chapterId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Enter valid assessment details." });
      }
      try {
        const courseId = await courseForChapter(chapterId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Chapter not found." });
        }
        const [existingAssessment] = await db
          .select({ id: lmsAssessments.id })
          .from(lmsAssessments)
          .where(eq(lmsAssessments.chapterId, chapterId))
          .limit(1);
        if (existingAssessment) {
          return res.status(409).json({ message: "An assessment already exists for this chapter. Create a new version instead." });
        }
        const assessment = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(lmsAssessments)
            .values({ chapterId, title: parsed.data.title, status: "draft", activeVersion: 1 })
            .returning();
          const [version] = await tx
            .insert(lmsAssessmentVersions)
            .values({
              assessmentId: created.id,
              version: 1,
              instructions: parsed.data.instructions,
              passingPercent: 100,
              showExplanationsAfterAttempt: parsed.data.showExplanationsAfterAttempt,
              createdBy: req.lmsUser!.id,
            })
            .returning();
          for (const question of parsed.data.questions) {
            const [createdQuestion] = await tx
              .insert(lmsAssessmentQuestions)
              .values({
                versionId: version.id,
                prompt: question.prompt,
                explanation: question.explanation ?? null,
              })
              .returning();
            await tx.insert(lmsAssessmentOptions).values(
              question.options.map((option, position) => ({
                questionId: createdQuestion.id,
                label: option.label,
                isCorrect: option.isCorrect,
                position,
              })),
            );
          }
          return { ...created, version: version.version };
        });
        await appendAudit(req.lmsUser!.id, "assessment.created", "assessment", assessment.id, {
          chapterId,
          version: assessment.version,
        });
        res.status(201).json(assessment);
      } catch {
        res.status(500).json({ message: "Unable to create the assessment." });
      }
    },
  );

  app.get(
    "/api/lms/manage/assessments/:assessmentId",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const assessmentId = Number(req.params.assessmentId);
      if (!Number.isSafeInteger(assessmentId) || assessmentId < 1) {
        return res.status(400).json({ message: "Invalid assessment." });
      }
      try {
        const [assessment] = await db
          .select()
          .from(lmsAssessments)
          .where(eq(lmsAssessments.id, assessmentId))
          .limit(1);
        if (!assessment) return res.status(404).json({ message: "Assessment not found." });
        const courseId = await courseForChapter(assessment.chapterId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Assessment not found." });
        }
        const [version] = await db
          .select()
          .from(lmsAssessmentVersions)
          .where(
            and(
              eq(lmsAssessmentVersions.assessmentId, assessment.id),
              eq(lmsAssessmentVersions.version, assessment.activeVersion),
            ),
          )
          .limit(1);
        if (!version) return res.status(404).json({ message: "Assessment version not found." });
        const rows = await db
          .select({
            questionId: lmsAssessmentQuestions.id,
            prompt: lmsAssessmentQuestions.prompt,
            explanation: lmsAssessmentQuestions.explanation,
            questionPosition: lmsAssessmentQuestions.position,
            optionId: lmsAssessmentOptions.id,
            label: lmsAssessmentOptions.label,
            isCorrect: lmsAssessmentOptions.isCorrect,
            optionPosition: lmsAssessmentOptions.position,
          })
          .from(lmsAssessmentQuestions)
          .leftJoin(
            lmsAssessmentOptions,
            eq(lmsAssessmentOptions.questionId, lmsAssessmentQuestions.id),
          )
          .where(eq(lmsAssessmentQuestions.versionId, version.id))
          .orderBy(asc(lmsAssessmentQuestions.position), asc(lmsAssessmentOptions.position));
        const questions = new Map<number, any>();
        for (const row of rows) {
          if (!questions.has(row.questionId)) {
            questions.set(row.questionId, {
              id: row.questionId,
              prompt: row.prompt,
              explanation: row.explanation,
              options: [],
            });
          }
          if (row.optionId) {
            questions.get(row.questionId).options.push({
              id: row.optionId,
              label: row.label,
              isCorrect: row.isCorrect,
            });
          }
        }
        res.json({
          id: assessment.id,
          chapterId: assessment.chapterId,
          title: assessment.title,
          status: assessment.status,
          version: version.version,
          instructions: version.instructions,
          passingPercent: 100,
          showExplanationsAfterAttempt: version.showExplanationsAfterAttempt,
          questions: Array.from(questions.values()),
        });
      } catch {
        res.status(500).json({ message: "Unable to load the assessment." });
      }
    },
  );

  app.put(
    "/api/lms/manage/assessments/:assessmentId",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const assessmentId = Number(req.params.assessmentId);
      const parsed = assessmentInput.safeParse(req.body);
      if (!Number.isSafeInteger(assessmentId) || assessmentId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Enter valid assessment details." });
      }
      try {
        const [assessmentRow] = await db
          .select()
          .from(lmsAssessments)
          .where(eq(lmsAssessments.id, assessmentId))
          .limit(1);
        if (!assessmentRow) return res.status(404).json({ message: "Assessment not found." });
        const courseId = await courseForChapter(assessmentRow.chapterId);
        if (!courseId || !(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Assessment not found." });
        }
        const version = await db.transaction(async (tx) => {
          const [createdVersion] = await tx
            .insert(lmsAssessmentVersions)
            .values({
              assessmentId,
              version: assessmentRow.activeVersion + 1,
              instructions: parsed.data.instructions,
              passingPercent: 100,
              showExplanationsAfterAttempt: parsed.data.showExplanationsAfterAttempt,
              createdBy: req.lmsUser!.id,
            })
            .returning();
          for (const question of parsed.data.questions) {
            const [createdQuestion] = await tx
              .insert(lmsAssessmentQuestions)
              .values({
                versionId: createdVersion.id,
                prompt: question.prompt,
                explanation: question.explanation ?? null,
              })
              .returning();
            await tx.insert(lmsAssessmentOptions).values(
              question.options.map((option, position) => ({
                questionId: createdQuestion.id,
                label: option.label,
                isCorrect: option.isCorrect,
                position,
              })),
            );
          }
          await tx
            .update(lmsAssessments)
            .set({ title: parsed.data.title, activeVersion: createdVersion.version, updatedAt: new Date() })
            .where(eq(lmsAssessments.id, assessmentId));
          return createdVersion;
        });
        await appendAudit(req.lmsUser!.id, "assessment.version_created", "assessment", assessmentId, {
          version: version.version,
        });
        res.json({ assessmentId, version: version.version });
      } catch {
        res.status(500).json({ message: "Unable to save the assessment version." });
      }
    },
  );

  app.post(
    "/api/lms/manage/assessments/:assessmentId/status",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const assessmentId = Number(req.params.assessmentId);
      const parsed = z.object({ status: z.enum(["draft", "published", "archived"]) }).safeParse(req.body);
      if (!Number.isSafeInteger(assessmentId) || assessmentId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid assessment status." });
      }
      try {
        const [assessment] = await db
          .select()
          .from(lmsAssessments)
          .where(eq(lmsAssessments.id, assessmentId))
          .limit(1);
        if (!assessment) return res.status(404).json({ message: "Assessment not found." });
        if (parsed.data.status === "published") {
          const [version] = await db
            .select({ id: lmsAssessmentVersions.id })
            .from(lmsAssessmentVersions)
            .where(
              and(
                eq(lmsAssessmentVersions.assessmentId, assessment.id),
                eq(lmsAssessmentVersions.version, assessment.activeVersion),
              ),
            )
            .limit(1);
          if (!version) return res.status(409).json({ message: "Create an assessment version first." });
          const questions = await db
            .select({ id: lmsAssessmentQuestions.id })
            .from(lmsAssessmentQuestions)
            .where(eq(lmsAssessmentQuestions.versionId, version.id));
          if (!questions.length) {
            return res.status(409).json({ message: "Add at least one question before publishing." });
          }
          for (const question of questions) {
            const [options] = await db
              .select({
                total: count(),
                correct: sql<number>`count(*) filter (where ${lmsAssessmentOptions.isCorrect})`,
              })
              .from(lmsAssessmentOptions)
              .where(eq(lmsAssessmentOptions.questionId, question.id));
            if ((options?.total ?? 0) < 2 || Number(options?.correct ?? 0) !== 1) {
              return res.status(409).json({ message: "Every question needs at least two options and one correct answer." });
            }
          }
        }
        const [updated] = await db
          .update(lmsAssessments)
          .set({ status: parsed.data.status, updatedAt: new Date() })
          .where(eq(lmsAssessments.id, assessment.id))
          .returning();
        await appendAudit(req.lmsUser!.id, `assessment.${parsed.data.status}`, "assessment", assessmentId);
        res.json(updated);
      } catch {
        res.status(500).json({ message: "Unable to update assessment status." });
      }
    },
  );

  app.get(
    "/api/lms/admin/users",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const users = await db
          .select({
            id: lmsUsers.id,
            phoneE164: lmsUsers.phoneE164,
            displayName: lmsUsers.displayName,
            isActive: lmsUsers.isActive,
            hasPassword: sql<boolean>`${lmsUsers.passwordHash} IS NOT NULL`,
          })
          .from(lmsUsers)
          .orderBy(asc(lmsUsers.displayName), asc(lmsUsers.id))
          .limit(500);
        const roleRows = users.length
          ? await db
              .select({ userId: lmsUserRoles.userId, role: lmsUserRoles.role })
              .from(lmsUserRoles)
              .where(inArray(lmsUserRoles.userId, users.map((user) => user.id)))
          : [];
        const rolesByUser = new Map<number, string[]>();
        for (const assignment of roleRows) {
          const current = rolesByUser.get(assignment.userId) ?? [];
          current.push(assignment.role);
          rolesByUser.set(assignment.userId, current);
        }
        res.json(
          users.map((user) => ({
            ...user,
            roles: rolesByUser.get(user.id) ?? [],
          })),
        );
      } catch {
        res.status(500).json({ message: "Unable to load accounts." });
      }
    },
  );

  app.post(
    "/api/lms/admin/users",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const parsed = z
        .object({
          phoneE164: z.string().trim().min(1).max(32),
          displayName: z.string().trim().min(2).max(180),
          role: z.enum(["student", "trainer"]),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Enter a valid phone, name, and role." });
      const phoneE164 = normalizeLmsPhone(parsed.data.phoneE164);
      if (!phoneE164) return res.status(400).json({ message: "Enter a valid phone, name, and role." });
      try {
        const user = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(lmsUsers)
            .values({ phoneE164, displayName: parsed.data.displayName })
            .onConflictDoNothing({ target: lmsUsers.phoneE164 })
            .returning();
          const account =
            created ??
            (
              await tx
                .select()
                .from(lmsUsers)
                .where(eq(lmsUsers.phoneE164, phoneE164))
                .limit(1)
            )[0];
          if (!account) throw new Error("Unable to create account.");
          await tx
            .update(lmsUsers)
            .set({ displayName: parsed.data.displayName, isActive: true, updatedAt: new Date() })
            .where(eq(lmsUsers.id, account.id));
          await tx
            .insert(lmsUserRoles)
            .values({ userId: account.id, role: parsed.data.role })
            .onConflictDoNothing();
          await tx.insert(lmsAuditLogs).values({
            actorId: req.lmsUser!.id,
            action: `user.${parsed.data.role}_provisioned`,
            entityType: "user",
            entityId: String(account.id),
          });
          return account;
        });
        res.status(201).json({
          id: user.id,
          phoneE164: user.phoneE164,
          displayName: parsed.data.displayName,
          role: parsed.data.role,
        });
      } catch {
        res.status(500).json({ message: "Unable to provision this account." });
      }
    },
  );

  app.post(
    "/api/lms/admin/users/:userId/password-setup",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const userId = Number(req.params.userId);
      if (!Number.isSafeInteger(userId) || userId < 1) {
        return res.status(400).json({ message: "Invalid account." });
      }
      try {
        const setupLink = await issueLmsPasswordSetupLink(userId);
        await appendAudit(
          req.lmsUser!.id,
          "user.password_setup_link_issued",
          "user",
          userId,
        );
        return res.json(setupLink);
      } catch (error) {
        if (error instanceof Error && error.message === "USER_NOT_FOUND") {
          return res.status(404).json({ message: "Account not found." });
        }
        return res.status(500).json({ message: "Unable to create a password setup link." });
      }
    },
  );

  app.post(
    "/api/lms/admin/trainers/:trainerId/assignments",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const trainerId = Number(req.params.trainerId);
      const parsed = z.object({ courseId: z.number().int().positive() }).safeParse(req.body);
      if (!Number.isSafeInteger(trainerId) || trainerId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid trainer assignment." });
      }
      try {
        const [isTrainer] = await db
          .select({ userId: lmsUserRoles.userId })
          .from(lmsUserRoles)
          .innerJoin(lmsUsers, eq(lmsUsers.id, lmsUserRoles.userId))
          .where(
            and(
              eq(lmsUserRoles.userId, trainerId),
              eq(lmsUserRoles.role, "trainer"),
              eq(lmsUsers.isActive, true),
            ),
          )
          .limit(1);
        const [course] = await db
          .select({ id: lmsCourses.id })
          .from(lmsCourses)
          .where(eq(lmsCourses.id, parsed.data.courseId))
          .limit(1);
        if (!isTrainer || !course) return res.status(404).json({ message: "Trainer or course not found." });
        const [assignment] = await db
          .insert(lmsTrainerAssignments)
          .values({
            trainerId,
            courseId: parsed.data.courseId,
            assignedBy: req.lmsUser!.id,
          })
          .onConflictDoNothing()
          .returning();
        await appendAudit(req.lmsUser!.id, "trainer.assigned", "course", parsed.data.courseId, { trainerId });
        res.status(201).json(assignment ?? { trainerId, courseId: parsed.data.courseId, alreadyAssigned: true });
      } catch {
        res.status(500).json({ message: "Unable to assign the trainer." });
      }
    },
  );

  app.get(
    "/api/lms/admin/trainer-assignments",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const assignments = await db
          .select({
            id: lmsTrainerAssignments.id,
            trainerId: lmsTrainerAssignments.trainerId,
            trainerName: lmsUsers.displayName,
            trainerPhone: lmsUsers.phoneE164,
            courseId: lmsCourses.id,
            courseTitle: lmsCourses.title,
            createdAt: lmsTrainerAssignments.createdAt,
          })
          .from(lmsTrainerAssignments)
          .innerJoin(lmsUsers, eq(lmsTrainerAssignments.trainerId, lmsUsers.id))
          .innerJoin(lmsCourses, eq(lmsTrainerAssignments.courseId, lmsCourses.id))
          .orderBy(asc(lmsCourses.title), asc(lmsUsers.displayName));
        res.json(assignments);
      } catch {
        res.status(500).json({ message: "Unable to load trainer assignments." });
      }
    },
  );

  app.delete(
    "/api/lms/admin/trainer-assignments/:assignmentId",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const assignmentId = Number(req.params.assignmentId);
      if (!Number.isSafeInteger(assignmentId) || assignmentId < 1) {
        return res.status(400).json({ message: "Invalid trainer assignment." });
      }
      try {
        const [assignment] = await db
          .delete(lmsTrainerAssignments)
          .where(eq(lmsTrainerAssignments.id, assignmentId))
          .returning({ id: lmsTrainerAssignments.id, trainerId: lmsTrainerAssignments.trainerId, courseId: lmsTrainerAssignments.courseId });
        if (!assignment) return res.status(404).json({ message: "Trainer assignment not found." });
        await appendAudit(req.lmsUser!.id, "trainer.unassigned", "course", assignment.courseId, { trainerId: assignment.trainerId });
        res.json({ removed: true });
      } catch {
        res.status(500).json({ message: "Unable to remove trainer assignment." });
      }
    },
  );

  app.get(
    "/api/lms/admin/enrollments",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const enrollments = await db
          .select({
            id: lmsEnrollments.id,
            studentId: lmsUsers.id,
            studentName: lmsUsers.displayName,
            studentPhone: lmsUsers.phoneE164,
            courseId: lmsCourses.id,
            courseTitle: lmsCourses.title,
            status: lmsEnrollments.status,
            enrolledAt: lmsEnrollments.enrolledAt,
          })
          .from(lmsEnrollments)
          .innerJoin(lmsUsers, eq(lmsEnrollments.studentId, lmsUsers.id))
          .innerJoin(lmsCourses, eq(lmsEnrollments.courseId, lmsCourses.id))
          .orderBy(desc(lmsEnrollments.enrolledAt))
          .limit(1000);
        res.json(enrollments);
      } catch {
        res.status(500).json({ message: "Unable to load course enrolments." });
      }
    },
  );

  app.post(
    "/api/lms/admin/enrollments",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const parsed = z.object({
        studentId: z.number().int().positive(),
        courseId: z.number().int().positive(),
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Choose a valid student and course." });
      try {
        const [student] = await db
          .select({ id: lmsUsers.id })
          .from(lmsUsers)
          .innerJoin(lmsUserRoles, eq(lmsUserRoles.userId, lmsUsers.id))
          .where(and(
            eq(lmsUsers.id, parsed.data.studentId),
            eq(lmsUsers.isActive, true),
            eq(lmsUserRoles.role, "student"),
          ))
          .limit(1);
        const [course] = await db
          .select({ id: lmsCourses.id })
          .from(lmsCourses)
          .where(eq(lmsCourses.id, parsed.data.courseId))
          .limit(1);
        if (!student || !course) return res.status(404).json({ message: "Student or course not found." });
        const [existing] = await db
          .select({ id: lmsEnrollments.id, status: lmsEnrollments.status })
          .from(lmsEnrollments)
          .where(and(
            eq(lmsEnrollments.studentId, student.id),
            eq(lmsEnrollments.courseId, course.id),
          ))
          .limit(1);
        if (existing) {
          if (existing.status === "active" || existing.status === "completed") {
            return res.status(409).json({ message: "This student already has an active or completed enrolment in the course." });
          }
          const [reactivated] = await db
            .update(lmsEnrollments)
            .set({ status: "active", enrolledAt: new Date(), completedAt: null })
            .where(eq(lmsEnrollments.id, existing.id))
            .returning();
          await appendAudit(req.lmsUser!.id, "enrollment.reactivated", "enrollment", reactivated.id, { studentId: student.id, courseId: course.id });
          return res.json(reactivated);
        }
        const [enrollment] = await db
          .insert(lmsEnrollments)
          .values({ studentId: student.id, courseId: course.id })
          .returning();
        await appendAudit(req.lmsUser!.id, "enrollment.created", "enrollment", enrollment.id, { studentId: student.id, courseId: course.id });
        res.status(201).json(enrollment);
      } catch {
        res.status(500).json({ message: "Unable to enrol this student." });
      }
    },
  );

  app.patch(
    "/api/lms/admin/enrollments/:enrollmentId/status",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const enrollmentId = Number(req.params.enrollmentId);
      const parsed = z.object({ status: z.enum(["active", "completed", "suspended", "withdrawn"]) }).safeParse(req.body);
      if (!Number.isSafeInteger(enrollmentId) || enrollmentId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Choose a valid enrolment status." });
      }
      try {
        const [updated] = await db
          .update(lmsEnrollments)
          .set({
            status: parsed.data.status,
            completedAt: parsed.data.status === "completed" ? new Date() : null,
          })
          .where(eq(lmsEnrollments.id, enrollmentId))
          .returning();
        if (!updated) return res.status(404).json({ message: "Enrolment not found." });
        await appendAudit(req.lmsUser!.id, `enrollment.${parsed.data.status}`, "enrollment", enrollmentId);
        res.json(updated);
      } catch {
        res.status(500).json({ message: "Unable to update enrolment status." });
      }
    },
  );

  app.get(
    "/api/lms/admin/reports",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const courses = await db.select({
          id: lmsCourses.id,
          title: lmsCourses.title,
          status: lmsCourses.status,
        }).from(lmsCourses).orderBy(asc(lmsCourses.title));
        const reports = await Promise.all(courses.map(async (course) => {
          const [enrollmentTotals] = await db.select({
            total: count(),
            active: sql<number>`count(*) filter (where ${lmsEnrollments.status} = 'active')`,
            completed: sql<number>`count(*) filter (where ${lmsEnrollments.status} = 'completed')`,
          }).from(lmsEnrollments).where(eq(lmsEnrollments.courseId, course.id));
          const [lessonTotals] = await db.select({ total: count() })
            .from(lmsLessons)
            .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
            .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
            .where(and(
              eq(lmsModules.courseId, course.id),
              eq(lmsModules.status, "published"),
              eq(lmsChapters.status, "published"),
              eq(lmsLessons.status, "published"),
            ));
          const [sessionTotals] = await db.select({
            total: count(),
            scheduled: sql<number>`count(*) filter (where ${lmsLiveSessions.status} = 'scheduled')`,
          }).from(lmsLiveSessions).where(eq(lmsLiveSessions.courseId, course.id));
          return {
            ...course,
            enrollments: enrollmentTotals.total,
            activeEnrollments: Number(enrollmentTotals.active),
            completedEnrollments: Number(enrollmentTotals.completed),
            publishedLessons: lessonTotals.total,
            liveSessions: sessionTotals.total,
            scheduledSessions: Number(sessionTotals.scheduled),
          };
        }));
        res.json(reports);
      } catch {
        res.status(500).json({ message: "Unable to load course reports." });
      }
    },
  );

  app.post(
    "/api/lms/admin/notifications",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const parsed = z.object({
        courseId: z.number().int().positive(),
        title: z.string().trim().min(2).max(180),
        body: z.string().trim().min(2).max(2000),
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Enter a title, message, and course." });
      try {
        const recipients = await db.selectDistinct({ userId: lmsEnrollments.studentId })
          .from(lmsEnrollments)
          .innerJoin(lmsUserRoles, eq(lmsUserRoles.userId, lmsEnrollments.studentId))
          .innerJoin(lmsUsers, eq(lmsUsers.id, lmsEnrollments.studentId))
          .where(and(
            eq(lmsEnrollments.courseId, parsed.data.courseId),
            eq(lmsEnrollments.status, "active"),
            eq(lmsUserRoles.role, "student"),
            eq(lmsUsers.isActive, true),
          ));
        const [course] = await db.select({ title: lmsCourses.title }).from(lmsCourses).where(eq(lmsCourses.id, parsed.data.courseId)).limit(1);
        if (!course) return res.status(404).json({ message: "Course not found." });
        if (recipients.length) {
          await db.insert(lmsNotifications).values(recipients.map(({ userId }) => ({
            userId,
            title: parsed.data.title,
            body: parsed.data.body,
            category: "course_announcement",
          })));
        }
        await appendAudit(req.lmsUser!.id, "notification.course_announcement", "course", parsed.data.courseId, { recipients: recipients.length });
        res.status(201).json({ sent: recipients.length, courseTitle: course.title });
      } catch {
        res.status(500).json({ message: "Unable to send the course notification." });
      }
    },
  );

  app.get(
    "/api/lms/manage/courses/:courseId/students",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const courseId = Number(req.params.courseId);
      if (!Number.isSafeInteger(courseId) || courseId < 1) {
        return res.status(400).json({ message: "Invalid course." });
      }
      try {
        if (!(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Course not found." });
        }
        const rows = await db
          .select({
            enrollmentId: lmsEnrollments.id,
            studentId: lmsUsers.id,
            displayName: lmsUsers.displayName,
            phoneE164: lmsUsers.phoneE164,
            enrolledAt: lmsEnrollments.enrolledAt,
            enrollmentStatus: lmsEnrollments.status,
          })
          .from(lmsEnrollments)
          .innerJoin(lmsUsers, eq(lmsEnrollments.studentId, lmsUsers.id))
          .where(eq(lmsEnrollments.courseId, courseId))
          .orderBy(desc(lmsEnrollments.enrolledAt));
        const students = await Promise.all(
          rows.map(async (row) => {
            const [progress] = await db
              .select({
                total: count(),
                completed: sql<number>`count(*) filter (where ${lmsLessonProgress.completedAt} is not null)`,
              })
              .from(lmsLessons)
              .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
              .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
              .leftJoin(
                lmsLessonProgress,
                and(
                  eq(lmsLessonProgress.lessonId, lmsLessons.id),
                  eq(lmsLessonProgress.enrollmentId, row.enrollmentId),
                ),
              )
              .where(
                and(
                  eq(lmsModules.courseId, courseId),
                  eq(lmsLessons.status, "published"),
                  eq(lmsChapters.status, "published"),
                  eq(lmsModules.status, "published"),
                ),
              );
            return {
              ...row,
              totalLessons: progress.total,
              completedLessons: Number(progress.completed),
              progressPercent:
                progress.total > 0
                  ? Math.round((Number(progress.completed) / progress.total) * 100)
                  : 0,
            };
          }),
        );
        res.json(students);
      } catch {
        res.status(500).json({ message: "Unable to load course progress." });
      }
    },
  );

  app.get(
    "/api/lms/student/certificates",
    requireLmsUser,
    requireLmsRole("student"),
    async (req, res) => {
      try {
        const enrollments = await db
          .select({
            enrollmentId: lmsEnrollments.id,
            courseId: lmsCourses.id,
            courseTitle: lmsCourses.title,
          })
          .from(lmsEnrollments)
          .innerJoin(lmsCourses, eq(lmsEnrollments.courseId, lmsCourses.id))
          .where(
            and(
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
              inArray(lmsEnrollments.status, ["active", "completed"]),
            ),
          );
        const certificates = await Promise.all(
          enrollments.map(async (enrollment) => {
            const certificate = await refreshCertificateEligibility(enrollment.enrollmentId);
            return {
              enrollmentId: enrollment.enrollmentId,
              certificateId: certificate?.id ?? null,
              courseTitle: enrollment.courseTitle,
              status: certificate?.status ?? "not_eligible",
              certificateNumber: certificate?.certificateNumber ?? null,
              issuedAt: certificate?.issuedAt ?? null,
              reviewNote: certificate?.reviewNote ?? null,
            };
          }),
        );
        res.json(certificates);
      } catch {
        res.status(500).json({ message: "Unable to load certificate status." });
      }
    },
  );

  app.post(
    "/api/lms/student/certificates/:enrollmentId/request-review",
    requireLmsUser,
    requireLmsRole("student"),
    async (req, res) => {
      const enrollmentId = Number(req.params.enrollmentId);
      if (!Number.isSafeInteger(enrollmentId) || enrollmentId < 1) {
        return res.status(400).json({ message: "Invalid enrolment." });
      }
      try {
        const [enrollment] = await db
          .select({ id: lmsEnrollments.id })
          .from(lmsEnrollments)
          .where(
            and(
              eq(lmsEnrollments.id, enrollmentId),
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
            ),
          )
          .limit(1);
        if (!enrollment) return res.status(404).json({ message: "Enrolment not found." });
        const certificate = await refreshCertificateEligibility(enrollmentId);
        if (!certificate || certificate.status !== "eligible") {
          return res.status(409).json({ message: "Certificate requirements are not complete yet." });
        }
        const [updated] = await db
          .update(lmsCertificates)
          .set({ status: "pending_review", updatedAt: new Date() })
          .where(eq(lmsCertificates.id, certificate.id))
          .returning();
        await appendAudit(req.lmsUser!.id, "certificate.review_requested", "certificate", certificate.id);
        res.json({ status: updated.status });
      } catch {
        res.status(500).json({ message: "Unable to request certificate review." });
      }
    },
  );

  app.get(
    "/api/lms/admin/certificates",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const items = await db
          .select({
            id: lmsCertificates.id,
            enrollmentId: lmsCertificates.enrollmentId,
            studentName: lmsUsers.displayName,
            phoneE164: lmsUsers.phoneE164,
            courseTitle: lmsCourses.title,
            status: lmsCertificates.status,
            certificateNumber: lmsCertificates.certificateNumber,
            reviewNote: lmsCertificates.reviewNote,
            issuedAt: lmsCertificates.issuedAt,
          })
          .from(lmsCertificates)
          .innerJoin(lmsEnrollments, eq(lmsCertificates.enrollmentId, lmsEnrollments.id))
          .innerJoin(lmsUsers, eq(lmsEnrollments.studentId, lmsUsers.id))
          .innerJoin(lmsCourses, eq(lmsEnrollments.courseId, lmsCourses.id))
          .orderBy(desc(lmsCertificates.updatedAt));
        res.json(items);
      } catch {
        res.status(500).json({ message: "Unable to load certificate reviews." });
      }
    },
  );

  app.post(
    "/api/lms/admin/certificates/:certificateId/review",
    requireLmsUser,
    requireLmsRole("admin"),
    async (req, res) => {
      const certificateId = Number(req.params.certificateId);
      const parsed = z
        .object({
          decision: z.enum(["approved", "rejected"]),
          reviewNote: z.string().trim().max(2000).default(""),
        })
        .safeParse(req.body);
      if (!Number.isSafeInteger(certificateId) || certificateId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid certificate review." });
      }
      try {
        const outcome = await db.transaction(async (tx) => {
          const [current] = await tx
            .select({
              id: lmsCertificates.id,
              status: lmsCertificates.status,
              studentName: lmsUsers.displayName,
            })
            .from(lmsCertificates)
            .innerJoin(lmsEnrollments, eq(lmsCertificates.enrollmentId, lmsEnrollments.id))
            .innerJoin(lmsUsers, eq(lmsEnrollments.studentId, lmsUsers.id))
            .where(eq(lmsCertificates.id, certificateId))
            .for("update")
            .limit(1);
          if (!current) return { ok: false as const, error: "Certificate not found.", statusCode: 404 };
          if (current.status !== "pending_review") {
            return { ok: false as const, error: "This certificate is not awaiting review.", statusCode: 409 };
          }
          if (parsed.data.decision === "approved" && !current.studentName?.trim()) {
            return { ok: false as const, error: "Add the student's full name before approving the certificate.", statusCode: 409 };
          }
          const issuedAt = parsed.data.decision === "approved" ? new Date() : null;
          const certificateNumber = issuedAt
            ? `AROMA-${issuedAt.getFullYear()}-${randomBytes(6).toString("hex").toUpperCase()}`
            : null;
          const [updated] = await tx
            .update(lmsCertificates)
            .set({
              status: parsed.data.decision,
              certificateNumber,
              approvedBy: parsed.data.decision === "approved" ? req.lmsUser!.id : null,
              issuedAt,
              reviewNote: parsed.data.reviewNote || null,
              updatedAt: new Date(),
            })
            .where(eq(lmsCertificates.id, certificateId))
            .returning();
          await tx.insert(lmsAuditLogs).values({
            actorId: req.lmsUser!.id,
            action: `certificate.${parsed.data.decision}`,
            entityType: "certificate",
            entityId: String(certificateId),
            metadata: { decision: parsed.data.decision },
          });
          return {
            ok: true as const,
            id: updated.id,
            status: updated.status,
            certificateNumber: updated.certificateNumber,
            issuedAt: updated.issuedAt,
          };
        });
        if (!outcome.ok) return res.status(outcome.statusCode).json({ message: outcome.error });
        return res.json(outcome);
      } catch {
        res.status(500).json({ message: "Unable to review this certificate." });
      }
    },
  );

  app.get(
    "/api/lms/certificates/:certificateId/pdf",
    requireLmsUser,
    async (req, res) => {
      const certificateId = Number(req.params.certificateId);
      if (!Number.isSafeInteger(certificateId) || certificateId < 1) {
        return res.status(400).json({ message: "Invalid certificate." });
      }
      if (!req.lmsUser!.roles.includes("admin") && !req.lmsUser!.roles.includes("student")) {
        return res.status(403).json({ message: "You do not have permission to access this certificate." });
      }
      try {
        const [certificate] = await db
          .select({
            id: lmsCertificates.id,
            status: lmsCertificates.status,
            certificateNumber: lmsCertificates.certificateNumber,
            issuedAt: lmsCertificates.issuedAt,
            studentId: lmsUsers.id,
            studentName: lmsUsers.displayName,
            courseTitle: lmsCourses.title,
          })
          .from(lmsCertificates)
          .innerJoin(lmsEnrollments, eq(lmsCertificates.enrollmentId, lmsEnrollments.id))
          .innerJoin(lmsUsers, eq(lmsEnrollments.studentId, lmsUsers.id))
          .innerJoin(lmsCourses, eq(lmsEnrollments.courseId, lmsCourses.id))
          .where(eq(lmsCertificates.id, certificateId))
          .limit(1);
        if (
          !certificate ||
          !canDownloadLmsCertificate({
            roles: req.lmsUser!.roles,
            userId: req.lmsUser!.id,
            studentId: certificate.studentId,
            status: certificate.status,
            hasCertificateNumber: Boolean(certificate.certificateNumber),
            hasIssueDate: Boolean(certificate.issuedAt),
            hasStudentName: Boolean(certificate.studentName?.trim()),
          })
        ) {
          return res.status(404).json({ message: "Approved certificate not found." });
        }
        const pdf = await PDFDocument.create();
        pdf.setTitle(`Aroma LEAP certificate ${certificate.certificateNumber}`);
        pdf.setAuthor("Aroma Institute of Café & Hospitality Management");
        pdf.setSubject(certificate.courseTitle);
        const page = pdf.addPage([842, 595]);
        const regular = await pdf.embedFont(StandardFonts.TimesRoman);
        const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
        const dark = rgb(0.28, 0.15, 0.09);
        const gold = rgb(0.69, 0.52, 0.28);
        page.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: dark, borderWidth: 2 });
        page.drawRectangle({ x: 38, y: 38, width: 766, height: 519, borderColor: gold, borderWidth: 1 });
        const centerText = (text: string, font: typeof regular, size: number, y: number, color = dark) => {
          const width = font.widthOfTextAtSize(text, size);
          page.drawText(text, { x: (842 - width) / 2, y, size, font, color });
        };
        centerText("AROMA INSTITUTE", bold, 17, 500, dark);
        centerText("OF CAFÉ & HOSPITALITY MANAGEMENT", regular, 10, 481, gold);
        centerText("AROMA LEAP · LEARN. EARN. ADVANCE. PAY.", regular, 9, 455, dark);
        centerText("CERTIFICATE OF COMPLETION", bold, 25, 394, dark);
        centerText("This certificate is proudly presented to", regular, 13, 350, dark);
        const studentName = certificate.studentName!.trim();
        const nameSize = Math.min(32, Math.max(20, 620 / Math.max(1, bold.widthOfTextAtSize(studentName, 1))));
        centerText(studentName, bold, nameSize, 300, dark);
        centerText("for successfully completing", regular, 13, 265, dark);
        const courseTitle = certificate.courseTitle.trim();
        const courseSize = Math.min(21, Math.max(14, 620 / Math.max(1, bold.widthOfTextAtSize(courseTitle, 1))));
        centerText(courseTitle, bold, courseSize, 229, dark);
        const issueDate = new Intl.DateTimeFormat("en-IN", {
          dateStyle: "long",
          timeZone: "Asia/Kolkata",
        }).format(certificate.issuedAt!);
        centerText(`Issued ${issueDate}`, regular, 12, 190, dark);
        page.drawLine({ start: { x: 290, y: 128 }, end: { x: 552, y: 128 }, thickness: 1, color: gold });
        centerText(certificate.certificateNumber!, regular, 10, 99, dark);
        const bytes = await pdf.save();
        const filename = `Aroma-LEAP-${certificate.certificateNumber!.replace(/[^A-Z0-9-]/g, "")}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "private, no-store");
        return res.status(200).send(Buffer.from(bytes));
      } catch {
        res.status(500).json({ message: "Unable to load this certificate." });
      }
    },
  );

  app.get(
    "/api/lms/manage/courses/:courseId/live-sessions",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const courseId = Number(req.params.courseId);
      if (!Number.isSafeInteger(courseId) || courseId < 1) {
        return res.status(400).json({ message: "Invalid course." });
      }
      if (!(await canManageCourse(courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
        return res.status(404).json({ message: "Course not found." });
      }
      const sessions = await db
        .select()
        .from(lmsLiveSessions)
        .where(eq(lmsLiveSessions.courseId, courseId))
        .orderBy(asc(lmsLiveSessions.startsAt));
      res.json(sessions);
    },
  );

  app.post(
    "/api/lms/manage/live-sessions",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const parsed = liveSessionInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Enter valid live session details." });
      if (
        parsed.data.endsAt &&
        new Date(parsed.data.endsAt) <= new Date(parsed.data.startsAt)
      ) {
        return res.status(400).json({ message: "The end time must be after the start time." });
      }
      try {
        if (!(await canManageCourse(parsed.data.courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Course not found." });
        }
        const trainerId = req.lmsUser!.roles.includes("admin")
          ? parsed.data.trainerId ?? req.lmsUser!.id
          : req.lmsUser!.id;
        if (req.lmsUser!.roles.includes("admin") && parsed.data.trainerId) {
          const [assignedTrainer] = await db
            .select({ id: lmsTrainerAssignments.id })
            .from(lmsTrainerAssignments)
            .where(and(
              eq(lmsTrainerAssignments.courseId, parsed.data.courseId),
              eq(lmsTrainerAssignments.trainerId, trainerId),
            ))
            .limit(1);
          if (!assignedTrainer) return res.status(400).json({ message: "Assign this trainer to the course before scheduling a session for them." });
        }
        const [session] = await db
          .insert(lmsLiveSessions)
          .values({
            courseId: parsed.data.courseId,
            trainerId,
            title: parsed.data.title,
            topic: parsed.data.topic,
            meetUrl: parsed.data.meetUrl,
            startsAt: new Date(parsed.data.startsAt),
            endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
          })
          .returning();
        await appendAudit(req.lmsUser!.id, "live_session.created", "live_session", session.id, {
          courseId: session.courseId,
        });
        res.status(201).json(session);
      } catch {
        res.status(500).json({ message: "Unable to create the live session." });
      }
    },
  );

  app.post(
    "/api/lms/manage/live-sessions/:sessionId/status",
    requireLmsUser,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      const sessionId = Number(req.params.sessionId);
      const parsed = z.object({ status: z.enum(["scheduled", "cancelled", "completed"]) }).safeParse(req.body);
      if (!Number.isSafeInteger(sessionId) || sessionId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid live session status." });
      }
      try {
        const [session] = await db
          .select({ id: lmsLiveSessions.id, courseId: lmsLiveSessions.courseId })
          .from(lmsLiveSessions)
          .where(eq(lmsLiveSessions.id, sessionId))
          .limit(1);
        if (!session || !(await canManageCourse(session.courseId, req.lmsUser!.id, req.lmsUser!.roles))) {
          return res.status(404).json({ message: "Live session not found." });
        }
        const [updated] = await db
          .update(lmsLiveSessions)
          .set({ status: parsed.data.status })
          .where(eq(lmsLiveSessions.id, sessionId))
          .returning();
        await appendAudit(req.lmsUser!.id, `live_session.${parsed.data.status}`, "live_session", sessionId);
        res.json(updated);
      } catch {
        res.status(500).json({ message: "Unable to update live session status." });
      }
    },
  );

  app.get(
    "/api/lms/admin/audit-logs",
    requireLmsUser,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const logs = await db
          .select({
            id: lmsAuditLogs.id,
            actorId: lmsAuditLogs.actorId,
            actorName: lmsUsers.displayName,
            action: lmsAuditLogs.action,
            entityType: lmsAuditLogs.entityType,
            entityId: lmsAuditLogs.entityId,
            metadata: lmsAuditLogs.metadata,
            createdAt: lmsAuditLogs.createdAt,
          })
          .from(lmsAuditLogs)
          .leftJoin(lmsUsers, eq(lmsAuditLogs.actorId, lmsUsers.id))
          .orderBy(desc(lmsAuditLogs.createdAt))
          .limit(500);
        res.json(logs);
      } catch {
        res.status(500).json({ message: "Unable to load audit logs." });
      }
    },
  );
}
