import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  lmsAssessmentAttempts,
  lmsAssessmentOptions,
  lmsAssessmentQuestions,
  lmsAssessmentVersions,
  lmsAssessments,
  lmsAuditLogs,
  lmsChapters,
  lmsCertificates,
  lmsCourses,
  lmsEnrollments,
  lmsInvitationCodes,
  lmsInvitationRedemptions,
  lmsLessonProgress,
  lmsLessons,
  lmsLiveSessions,
  lmsModules,
  lmsResources,
  lmsUserRoles,
  lmsUsers,
  lmsTrainerAssignments,
} from "@shared/lms-schema";
import { db } from "../db";
import {
  destroyLmsSession,
  optionalLmsUser,
  requireLmsRole,
  requireLmsUser,
  type LmsRole,
} from "./auth";
import { calculateAssessmentScore } from "./assessment-scoring";
import {
  canDownloadLmsCertificate,
  chapterPrerequisitesAreMet,
  hasCourseResourceAccess,
  nextAssessmentAttemptNumber,
  redeemLockedSingleUseInvitation,
} from "./access-policy";
import { registerLmsPasswordAuthRoutes } from "./password-auth";

const createCourseSchema = z.object({
  title: z.string().trim().min(2).max(180),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(5000).default(""),
});

const createInvitationSchema = z.object({
  courseId: z.number().int().positive(),
  expiresAt: z.string().datetime().nullable().optional(),
  maxUses: z.number().int().min(1).max(1000).default(1),
  reservedForPhone: z.string().trim().max(20).nullable().optional(),
});

const markLessonSchema = z.object({
  completed: z.boolean().default(true),
});

const submitAssessmentSchema = z.object({
  answers: z.record(z.string(), z.number().int().positive()),
});

function hashCode(code: string) {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function normalizePhone(value: string) {
  return value.replace(/[^\d+]/g, "");
}

function writeAudit(
  actorId: number,
  action: string,
  entityType: string,
  entityId?: string | number,
  metadata: Record<string, unknown> = {},
) {
  return db.insert(lmsAuditLogs).values({
    actorId,
    action,
    entityType,
    entityId: entityId === undefined ? null : String(entityId),
    metadata,
  });
}

async function hasCoursePermission(
  userId: number,
  roles: LmsRole[],
  courseId: number,
  mode: "student" | "staff",
) {
  if (mode === "staff" && roles.includes("admin")) {
    return hasCourseResourceAccess(roles, mode, false, false);
  }
  if (mode === "student" && roles.includes("student")) {
    const [enrollment] = await db
      .select({ id: lmsEnrollments.id })
      .from(lmsEnrollments)
      .where(
        and(
          eq(lmsEnrollments.studentId, userId),
          eq(lmsEnrollments.courseId, courseId),
          eq(lmsEnrollments.status, "active"),
        ),
      )
      .limit(1);
    return hasCourseResourceAccess(roles, mode, Boolean(enrollment), false);
  }
  if (mode === "staff" && roles.includes("trainer")) {
    const [assignment] = await db
      .select({ id: lmsTrainerAssignments.id })
      .from(lmsTrainerAssignments)
      .where(
        and(
          eq(lmsTrainerAssignments.trainerId, userId),
          eq(lmsTrainerAssignments.courseId, courseId),
        ),
      )
      .limit(1);
    return hasCourseResourceAccess(roles, mode, false, Boolean(assignment));
  }
  return hasCourseResourceAccess(roles, mode, false, false);
}

async function findChapterCourse(chapterId: number) {
  const [row] = await db
    .select({
      chapterId: lmsChapters.id,
      moduleId: lmsModules.id,
      courseId: lmsCourses.id,
      chapterPosition: lmsChapters.position,
      modulePosition: lmsModules.position,
    })
    .from(lmsChapters)
    .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
    .innerJoin(lmsCourses, eq(lmsModules.courseId, lmsCourses.id))
    .where(eq(lmsChapters.id, chapterId))
    .limit(1);
  return row;
}

async function chapterContentIsUnlocked(enrollmentId: number, chapterId: number) {
  const location = await findChapterCourse(chapterId);
  if (!location) return false;

  const ordered = await db
    .select({
      id: lmsChapters.id,
      modulePosition: lmsModules.position,
      chapterPosition: lmsChapters.position,
    })
    .from(lmsChapters)
    .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
    .where(
      and(
        eq(lmsModules.courseId, location.courseId),
        eq(lmsModules.status, "published"),
        eq(lmsChapters.status, "published"),
      ),
    )
    .orderBy(asc(lmsModules.position), asc(lmsChapters.position), asc(lmsChapters.id));
  const currentIndex = ordered.findIndex((chapter) => chapter.id === chapterId);
  if (currentIndex < 0) return false;

  const prerequisites: Array<{ requiredLessonIds: number[]; assessmentId: number | null }> = [];
  const completedLessonIds = new Set<number>();
  const passedAssessmentIds = new Set<number>();
  for (const previousChapter of ordered.slice(0, currentIndex)) {
    const required = await db
      .select({ id: lmsLessons.id })
      .from(lmsLessons)
      .where(
        and(
          eq(lmsLessons.chapterId, previousChapter.id),
          eq(lmsLessons.status, "published"),
          eq(lmsLessons.requiredForAssessment, true),
        ),
      );
    if (required.length) {
      const completed = await db
        .select({ id: lmsLessonProgress.id })
        .from(lmsLessonProgress)
        .where(
          and(
            eq(lmsLessonProgress.enrollmentId, enrollmentId),
            inArray(
              lmsLessonProgress.lessonId,
              required.map(({ id }) => id),
            ),
            sql`${lmsLessonProgress.completedAt} IS NOT NULL`,
          ),
        );
      completed.forEach(({ id }) => completedLessonIds.add(id));
    }

    const [assessment] = await db
      .select({ id: lmsAssessments.id })
      .from(lmsAssessments)
      .where(
        and(
          eq(lmsAssessments.chapterId, previousChapter.id),
          eq(lmsAssessments.status, "published"),
        ),
      )
      .limit(1);
    if (assessment) {
      const [passed] = await db
        .select({ id: lmsAssessmentAttempts.id })
        .from(lmsAssessmentAttempts)
        .where(
          and(
            eq(lmsAssessmentAttempts.enrollmentId, enrollmentId),
            eq(lmsAssessmentAttempts.assessmentId, assessment.id),
            eq(lmsAssessmentAttempts.passed, true),
          ),
        )
        .limit(1);
      if (passed) passedAssessmentIds.add(assessment.id);
    }
    prerequisites.push({
      requiredLessonIds: required.map(({ id }) => id),
      assessmentId: assessment?.id ?? null,
    });
  }
  return chapterPrerequisitesAreMet(prerequisites, completedLessonIds, passedAssessmentIds);
}

async function chapterAssessmentIsUnlocked(enrollmentId: number, chapterId: number) {
  if (!(await chapterContentIsUnlocked(enrollmentId, chapterId))) return false;
  const required = await db
    .select({ id: lmsLessons.id })
    .from(lmsLessons)
    .where(
      and(
        eq(lmsLessons.chapterId, chapterId),
        eq(lmsLessons.status, "published"),
        eq(lmsLessons.requiredForAssessment, true),
      ),
    );
  if (!required.length) return true;
  const completed = await db
    .select({ id: lmsLessonProgress.id })
    .from(lmsLessonProgress)
    .where(
      and(
        eq(lmsLessonProgress.enrollmentId, enrollmentId),
        inArray(
          lmsLessonProgress.lessonId,
          required.map(({ id }) => id),
        ),
        sql`${lmsLessonProgress.completedAt} IS NOT NULL`,
      ),
    );
  return completed.length === required.length;
}

function requireAuthenticated(req: Request, res: Response, next: () => void) {
  return requireLmsUser(req, res, next);
}

function requireSameOriginForWrites(req: Request, res: Response, next: () => void) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) {
    return res.status(403).json({ message: "A same-origin request is required." });
  }
  try {
    const requestOrigin = new URL(origin).origin;
    const expectedOrigin = `${req.protocol}://${req.get("host")}`;
    if (requestOrigin !== expectedOrigin) {
      return res.status(403).json({ message: "A same-origin request is required." });
    }
  } catch {
    return res.status(403).json({ message: "A same-origin request is required." });
  }
  return next();
}

export function registerLmsRoutes(app: Express) {
  app.use("/api/lms", requireSameOriginForWrites);
  registerLmsPasswordAuthRoutes(app);

  app.get("/api/lms/auth/status", (_req, res) => {
    res.json({
      available: true,
      channel: "Password",
      message: "Sign in with the phone number on your Aroma LEAP account and your password.",
    });
  });

  app.post("/api/lms/auth/otp/request", (_req, res) => {
    return res.status(503).json({
      message: "OTP sign-in is not configured. No code was sent.",
      code: "OTP_PROVIDER_NOT_CONFIGURED",
    });
  });

  app.post("/api/lms/auth/otp/verify", (_req, res) => {
    return res.status(503).json({
      message: "OTP verification is not configured. No session was created.",
      code: "OTP_PROVIDER_NOT_CONFIGURED",
    });
  });

  app.get("/api/lms/auth/me", optionalLmsUser, (req, res) => {
    if (!req.lmsUser) return res.json(null);
    res.json({
      id: req.lmsUser!.id,
      phoneE164: req.lmsUser!.phoneE164,
      displayName: req.lmsUser!.displayName,
      roles: req.lmsUser!.roles,
    });
  });

  app.post("/api/lms/auth/logout", requireAuthenticated, async (req, res) => {
    try {
      await destroyLmsSession(req);
      res.clearCookie("aroma.sid", { path: "/" });
      res.status(204).end();
    } catch {
      res.status(500).json({ message: "Unable to end the session" });
    }
  });

  app.post(
    "/api/lms/invitations/redeem",
    requireAuthenticated,
    requireLmsRole("student"),
    async (req, res) => {
      const code = z.string().trim().min(6).max(80).safeParse(req.body?.code);
      if (!code.success) return res.status(400).json({ message: "Enter a valid invitation code." });

      try {
        const result = await db.transaction(async (tx) => {
          return redeemLockedSingleUseInvitation(
            async () => {
              const [invitation] = await tx
                .select()
                .from(lmsInvitationCodes)
                .where(eq(lmsInvitationCodes.codeHash, hashCode(code.data)))
                .for("update")
                .limit(1);
              return invitation ?? null;
            },
            async (invitation) => {
              const [course] = await tx
                .select({ id: lmsCourses.id, title: lmsCourses.title, status: lmsCourses.status })
                .from(lmsCourses)
                .where(eq(lmsCourses.id, invitation.courseId))
                .limit(1);
              if (!course || course.status !== "published") {
                return { error: "This course is not available for enrolment.", status: 409 };
              }

              const [existing] = await tx
                .select({ id: lmsEnrollments.id })
                .from(lmsEnrollments)
                .where(
                  and(
                    eq(lmsEnrollments.studentId, req.lmsUser!.id),
                    eq(lmsEnrollments.courseId, course.id),
                    eq(lmsEnrollments.status, "active"),
                  ),
                )
                .limit(1);
              if (existing) {
                return { error: "You are already enrolled in this course.", status: 409 };
              }

              const [enrollment] = await tx
                .insert(lmsEnrollments)
                .values({ studentId: req.lmsUser!.id, courseId: course.id })
                .returning({ id: lmsEnrollments.id });
              await tx
                .update(lmsInvitationCodes)
                .set({ usesCount: sql`${lmsInvitationCodes.usesCount} + 1` })
                .where(eq(lmsInvitationCodes.id, invitation.id));
              await tx.insert(lmsInvitationRedemptions).values({
                invitationId: invitation.id,
                studentId: req.lmsUser!.id,
                enrollmentId: enrollment.id,
              });
              await tx.insert(lmsAuditLogs).values({
                actorId: req.lmsUser!.id,
                action: "invitation.redeemed",
                entityType: "invitation",
                entityId: String(invitation.id),
                metadata: { courseId: course.id, enrollmentId: enrollment.id },
              });
              return { enrollmentId: enrollment.id, course };
            },
            (invitation) => {
              if (invitation.status !== "active") {
                return { error: "This invitation code is invalid or revoked.", status: 404 };
              }
              if (invitation.expiresAt && invitation.expiresAt <= new Date()) {
                return { error: "This invitation code has expired.", status: 410 };
              }
              if (
                invitation.reservedForPhone &&
                invitation.reservedForPhone !== req.lmsUser!.phoneE164
              ) {
                return { error: "This invitation code was issued to another student.", status: 403 };
              }
              return null;
            },
          );
        });

        if ("error" in result) {
          return res.status(result.status ?? 500).json({ message: result.error });
        }
        if ("error" in result.result) {
          return res.status(result.result.status ?? 500).json({ message: result.result.error });
        }
        return res.status(201).json(result.result);
      } catch {
        return res.status(500).json({ message: "Unable to redeem this invitation code." });
      }
    },
  );

  app.get(
    "/api/lms/student/dashboard",
    requireAuthenticated,
    requireLmsRole("student"),
    async (req, res) => {
      try {
        const courseRows = await db
          .select({
            enrollmentId: lmsEnrollments.id,
            courseId: lmsCourses.id,
            title: lmsCourses.title,
            description: lmsCourses.description,
            enrolledAt: lmsEnrollments.enrolledAt,
          })
          .from(lmsEnrollments)
          .innerJoin(lmsCourses, eq(lmsEnrollments.courseId, lmsCourses.id))
          .where(
            and(
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
              eq(lmsEnrollments.status, "active"),
              eq(lmsCourses.status, "published"),
            ),
          )
          .orderBy(desc(lmsEnrollments.enrolledAt));

        const courses = await Promise.all(
          courseRows.map(async (course) => {
            const [totals] = await db
              .select({ total: count() })
              .from(lmsLessons)
              .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
              .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
              .where(
                and(
                  eq(lmsModules.courseId, course.courseId),
                  eq(lmsLessons.status, "published"),
                  eq(lmsChapters.status, "published"),
                  eq(lmsModules.status, "published"),
                ),
              );

            const [done] = await db
              .select({ total: count() })
              .from(lmsLessonProgress)
              .innerJoin(lmsLessons, eq(lmsLessonProgress.lessonId, lmsLessons.id))
              .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
              .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
              .where(
                and(
                  eq(lmsLessonProgress.enrollmentId, course.enrollmentId),
                  sql`${lmsLessonProgress.completedAt} IS NOT NULL`,
                  eq(lmsLessons.status, "published"),
                  eq(lmsChapters.status, "published"),
                  eq(lmsModules.status, "published"),
                ),
              );

            const [nextLesson] = await db
              .select({ id: lmsLessons.id, title: lmsLessons.title })
              .from(lmsLessons)
              .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
              .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
              .leftJoin(
                lmsLessonProgress,
                and(
                  eq(lmsLessonProgress.lessonId, lmsLessons.id),
                  eq(lmsLessonProgress.enrollmentId, course.enrollmentId),
                ),
              )
              .where(
                and(
                  eq(lmsModules.courseId, course.courseId),
                  eq(lmsLessons.status, "published"),
                  eq(lmsChapters.status, "published"),
                  eq(lmsModules.status, "published"),
                  isNull(lmsLessonProgress.completedAt),
                ),
              )
              .orderBy(asc(lmsModules.position), asc(lmsChapters.position), asc(lmsLessons.position))
              .limit(1);

            return {
              ...course,
              completedLessons: done?.total ?? 0,
              totalLessons: totals?.total ?? 0,
              progressPercent:
                totals?.total && totals.total > 0
                  ? Math.round(((done?.total ?? 0) / totals.total) * 100)
                  : 0,
              continueLesson: nextLesson ?? null,
            };
          }),
        );

        const upcomingSessions = await db
          .select({
            id: lmsLiveSessions.id,
            title: lmsLiveSessions.title,
            topic: lmsLiveSessions.topic,
            startsAt: lmsLiveSessions.startsAt,
            endsAt: lmsLiveSessions.endsAt,
            meetUrl: lmsLiveSessions.meetUrl,
            courseTitle: lmsCourses.title,
          })
          .from(lmsLiveSessions)
          .innerJoin(lmsCourses, eq(lmsLiveSessions.courseId, lmsCourses.id))
          .innerJoin(lmsEnrollments, eq(lmsEnrollments.courseId, lmsCourses.id))
          .where(
            and(
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
              eq(lmsEnrollments.status, "active"),
              eq(lmsLiveSessions.status, "scheduled"),
              gt(lmsLiveSessions.startsAt, new Date()),
            ),
          )
          .orderBy(asc(lmsLiveSessions.startsAt))
          .limit(5);

        res.json({ student: { name: req.lmsUser!.displayName }, courses, upcomingSessions });
      } catch {
        res.status(500).json({ message: "Unable to load your dashboard." });
      }
    },
  );

  app.get(
    "/api/lms/student/courses/:courseId/outline",
    requireAuthenticated,
    requireLmsRole("student"),
    async (req, res) => {
      const courseId = Number(req.params.courseId);
      if (!Number.isSafeInteger(courseId) || courseId < 1) {
        return res.status(400).json({ message: "Invalid course." });
      }

      try {
        const allowed = await hasCoursePermission(
          req.lmsUser!.id,
          req.lmsUser!.roles,
          courseId,
          "student",
        );
        if (!allowed) return res.status(404).json({ message: "Course not found." });

        const [course] = await db
          .select()
          .from(lmsCourses)
          .where(and(eq(lmsCourses.id, courseId), eq(lmsCourses.status, "published")))
          .limit(1);
        if (!course) return res.status(404).json({ message: "Course not found." });

        const enrollment = await db
          .select({ id: lmsEnrollments.id })
          .from(lmsEnrollments)
          .where(
            and(
              eq(lmsEnrollments.courseId, courseId),
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
              eq(lmsEnrollments.status, "active"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]);

        const outline = await db
          .select({
            moduleId: lmsModules.id,
            moduleTitle: lmsModules.title,
            moduleDescription: lmsModules.description,
            modulePosition: lmsModules.position,
            chapterId: lmsChapters.id,
            chapterTitle: lmsChapters.title,
            chapterDescription: lmsChapters.description,
            chapterPosition: lmsChapters.position,
            lessonId: lmsLessons.id,
            lessonTitle: lmsLessons.title,
            lessonDescription: lmsLessons.description,
            lessonDurationMinutes: lmsLessons.durationMinutes,
            lessonPosition: lmsLessons.position,
            lessonRequired: lmsLessons.requiredForAssessment,
            lessonYoutubeUrl: lmsLessons.youtubeUrl,
            lessonCompletedAt: lmsLessonProgress.completedAt,
          })
          .from(lmsModules)
          .innerJoin(lmsChapters, eq(lmsChapters.moduleId, lmsModules.id))
          .leftJoin(lmsLessons, eq(lmsLessons.chapterId, lmsChapters.id))
          .leftJoin(
            lmsLessonProgress,
            and(
              eq(lmsLessonProgress.lessonId, lmsLessons.id),
              eq(lmsLessonProgress.enrollmentId, enrollment!.id),
            ),
          )
          .where(
            and(
              eq(lmsModules.courseId, courseId),
              eq(lmsModules.status, "published"),
              eq(lmsChapters.status, "published"),
              sql`(${lmsLessons.id} IS NULL OR ${lmsLessons.status} = 'published')`,
            ),
          )
          .orderBy(
            asc(lmsModules.position),
            asc(lmsChapters.position),
            asc(lmsLessons.position),
          );

        const lessonIds = Array.from(
          new Set(outline.flatMap((row) => (row.lessonId ? [row.lessonId] : []))),
        );
        const resourceRows = lessonIds.length
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
        const resourcesByLesson = new Map<number, typeof resourceRows>();
        for (const resource of resourceRows) {
          const current = resourcesByLesson.get(resource.lessonId) ?? [];
          current.push(resource);
          resourcesByLesson.set(resource.lessonId, current);
        }

        const chapterAccess = new Map<number, boolean>();
        for (const row of outline) {
          if (!chapterAccess.has(row.chapterId)) {
            chapterAccess.set(
              row.chapterId,
              await chapterContentIsUnlocked(enrollment!.id, row.chapterId),
            );
          }
        }

        const grouped = new Map<number, any>();
        for (const row of outline) {
          if (!grouped.has(row.moduleId)) {
            grouped.set(row.moduleId, {
              id: row.moduleId,
              title: row.moduleTitle,
              description: row.moduleDescription,
              chapters: new Map<number, any>(),
            });
          }
          const module = grouped.get(row.moduleId);
          if (!module.chapters.has(row.chapterId)) {
            module.chapters.set(row.chapterId, {
              id: row.chapterId,
              title: row.chapterTitle,
              description: row.chapterDescription,
              locked: !chapterAccess.get(row.chapterId),
              lessons: [],
            });
          }
          if (row.lessonId) {
            module.chapters.get(row.chapterId).lessons.push({
              id: row.lessonId,
              title: row.lessonTitle,
              description: chapterAccess.get(row.chapterId) ? row.lessonDescription : "",
              durationMinutes: row.lessonDurationMinutes,
              requiredForAssessment: row.lessonRequired,
              youtubeUrl: chapterAccess.get(row.chapterId) ? row.lessonYoutubeUrl : null,
              completed: chapterAccess.get(row.chapterId) && Boolean(row.lessonCompletedAt),
              locked: !chapterAccess.get(row.chapterId),
              resources: chapterAccess.get(row.chapterId)
                ? resourcesByLesson.get(row.lessonId) ?? []
                : [],
            });
          }
        }

        res.json({
          course,
          modules: Array.from(grouped.values()).map((module) => ({
            ...module,
            chapters: Array.from(module.chapters.values()),
          })),
        });
      } catch {
        res.status(500).json({ message: "Unable to load this course." });
      }
    },
  );

  app.get(
    "/api/lms/resources/:resourceId",
    requireAuthenticated,
    async (req, res) => {
      const resourceId = Number(req.params.resourceId);
      if (!Number.isSafeInteger(resourceId) || resourceId < 1) {
        return res.status(400).json({ message: "Invalid course resource." });
      }
      try {
        const [resource] = await db
          .select({
            id: lmsResources.id,
            fileName: lmsResources.fileName,
            contentType: lmsResources.contentType,
            byteSize: lmsResources.byteSize,
            courseId: lmsCourses.id,
            courseStatus: lmsCourses.status,
            moduleStatus: lmsModules.status,
            chapterId: lmsChapters.id,
            chapterStatus: lmsChapters.status,
            lessonStatus: lmsLessons.status,
          })
          .from(lmsResources)
          .innerJoin(lmsLessons, eq(lmsResources.lessonId, lmsLessons.id))
          .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
          .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
          .innerJoin(lmsCourses, eq(lmsModules.courseId, lmsCourses.id))
          .where(eq(lmsResources.id, resourceId))
          .limit(1);
        if (!resource) return res.status(404).json({ message: "Course resource not found." });

        const staffAccess = await hasCoursePermission(
          req.lmsUser!.id,
          req.lmsUser!.roles,
          resource.courseId,
          "staff",
        );
        if (!staffAccess) {
          const studentAccess = await hasCoursePermission(
            req.lmsUser!.id,
            req.lmsUser!.roles,
            resource.courseId,
            "student",
          );
          if (
            !studentAccess ||
            resource.courseStatus !== "published" ||
            resource.moduleStatus !== "published" ||
            resource.chapterStatus !== "published" ||
            resource.lessonStatus !== "published"
          ) {
            return res.status(404).json({ message: "Course resource not found." });
          }
          const [enrollment] = await db
            .select({ id: lmsEnrollments.id })
            .from(lmsEnrollments)
            .where(
              and(
                eq(lmsEnrollments.studentId, req.lmsUser!.id),
                eq(lmsEnrollments.courseId, resource.courseId),
                eq(lmsEnrollments.status, "active"),
              ),
            )
            .limit(1);
          if (!enrollment || !(await chapterContentIsUnlocked(enrollment.id, resource.chapterId))) {
            return res.status(404).json({ message: "Course resource not found." });
          }
        }

        const [storedFile] = await db
          .select({ fileData: lmsResources.fileData })
          .from(lmsResources)
          .where(eq(lmsResources.id, resourceId))
          .limit(1);
        if (!storedFile?.fileData) {
          return res.status(404).json({ message: "Course resource file not found." });
        }
        const contents = storedFile.fileData;
        res.setHeader("Content-Type", resource.contentType);
        res.setHeader("Content-Length", contents.byteLength);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(resource.fileName.replace(/[\r\n]/g, ""))}`,
        );
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.status(200).send(contents);
      } catch {
        return res.status(500).json({ message: "Course resource could not be retrieved." });
      }
    },
  );

  app.post(
    "/api/lms/student/lessons/:lessonId/progress",
    requireAuthenticated,
    requireLmsRole("student"),
    async (req, res) => {
      const lessonId = Number(req.params.lessonId);
      const parsed = markLessonSchema.safeParse(req.body);
      if (!Number.isSafeInteger(lessonId) || lessonId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid lesson progress request." });
      }

      try {
        const [lesson] = await db
          .select({
            id: lmsLessons.id,
            chapterId: lmsLessons.chapterId,
            status: lmsLessons.status,
            courseId: lmsCourses.id,
          })
          .from(lmsLessons)
          .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
          .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
          .innerJoin(lmsCourses, eq(lmsModules.courseId, lmsCourses.id))
          .where(eq(lmsLessons.id, lessonId))
          .limit(1);
        if (!lesson || lesson.status !== "published") {
          return res.status(404).json({ message: "Lesson not found." });
        }

        const [enrollment] = await db
          .select({ id: lmsEnrollments.id })
          .from(lmsEnrollments)
          .where(
            and(
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
              eq(lmsEnrollments.courseId, lesson.courseId),
              eq(lmsEnrollments.status, "active"),
            ),
          )
          .limit(1);
        if (!enrollment) return res.status(404).json({ message: "Lesson not found." });
        if (!(await chapterContentIsUnlocked(enrollment.id, lesson.chapterId))) {
          return res.status(423).json({ message: "This lesson is locked until the previous chapter requirements are met." });
        }

        const [existingProgress] = await db
          .select({ id: lmsLessonProgress.id })
          .from(lmsLessonProgress)
          .where(
            and(
              eq(lmsLessonProgress.enrollmentId, enrollment.id),
              eq(lmsLessonProgress.lessonId, lessonId),
            ),
          )
          .limit(1);

        const completedAt = parsed.data.completed ? new Date() : null;
        const [progress] = existingProgress
          ? await db
              .update(lmsLessonProgress)
              .set({ completedAt, updatedAt: new Date() })
              .where(eq(lmsLessonProgress.id, existingProgress.id))
              .returning()
          : await db
              .insert(lmsLessonProgress)
              .values({ enrollmentId: enrollment.id, lessonId, completedAt })
              .returning();
        res.json({ completed: Boolean(progress.completedAt), updatedAt: progress.updatedAt });
      } catch {
        res.status(500).json({ message: "Unable to update lesson progress." });
      }
    },
  );

  app.get(
    "/api/lms/student/chapters/:chapterId/assessment",
    requireAuthenticated,
    requireLmsRole("student"),
    async (req, res) => {
      const chapterId = Number(req.params.chapterId);
      if (!Number.isSafeInteger(chapterId) || chapterId < 1) {
        return res.status(400).json({ message: "Invalid chapter." });
      }
      try {
        const location = await findChapterCourse(chapterId);
        if (!location) return res.status(404).json({ message: "Assessment not found." });
        const [enrollment] = await db
          .select({ id: lmsEnrollments.id })
          .from(lmsEnrollments)
          .where(
            and(
              eq(lmsEnrollments.courseId, location.courseId),
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
              eq(lmsEnrollments.status, "active"),
            ),
          )
          .limit(1);
        if (!enrollment) return res.status(404).json({ message: "Assessment not found." });
        if (!(await chapterAssessmentIsUnlocked(enrollment.id, chapterId))) {
          return res.status(423).json({ message: "Complete the required lessons and previous assessments first." });
        }

        const [assessment] = await db
          .select()
          .from(lmsAssessments)
          .where(
            and(
              eq(lmsAssessments.chapterId, chapterId),
              eq(lmsAssessments.status, "published"),
            ),
          )
          .limit(1);
        if (!assessment) return res.status(404).json({ message: "Assessment not found." });
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
        if (!version) return res.status(404).json({ message: "Assessment not found." });

        const questions = await db
          .select({
            id: lmsAssessmentQuestions.id,
            prompt: lmsAssessmentQuestions.prompt,
            position: lmsAssessmentQuestions.position,
            optionId: lmsAssessmentOptions.id,
            optionLabel: lmsAssessmentOptions.label,
            optionPosition: lmsAssessmentOptions.position,
          })
          .from(lmsAssessmentQuestions)
          .leftJoin(
            lmsAssessmentOptions,
            eq(lmsAssessmentOptions.questionId, lmsAssessmentQuestions.id),
          )
          .where(eq(lmsAssessmentQuestions.versionId, version.id))
          .orderBy(asc(lmsAssessmentQuestions.position), asc(lmsAssessmentOptions.position));

        const grouped = new Map<number, { id: number; prompt: string; options: { id: number; label: string }[] }>();
        for (const row of questions) {
          if (!grouped.has(row.id)) {
            grouped.set(row.id, { id: row.id, prompt: row.prompt, options: [] });
          }
          if (row.optionId) {
            grouped.get(row.id)!.options.push({ id: row.optionId, label: row.optionLabel! });
          }
        }
        const [attemptSummary] = await db
          .select({
            attempts: count(),
            passed: sql<number>`count(*) filter (where ${lmsAssessmentAttempts.passed})`,
          })
          .from(lmsAssessmentAttempts)
          .where(
            and(
              eq(lmsAssessmentAttempts.enrollmentId, enrollment.id),
              eq(lmsAssessmentAttempts.assessmentId, assessment.id),
            ),
          );
        const attemptHistory = await db
          .select({
            attemptNumber: lmsAssessmentAttempts.attemptNumber,
            scorePercent: lmsAssessmentAttempts.scorePercent,
            passed: lmsAssessmentAttempts.passed,
            submittedAt: lmsAssessmentAttempts.submittedAt,
          })
          .from(lmsAssessmentAttempts)
          .where(
            and(
              eq(lmsAssessmentAttempts.enrollmentId, enrollment.id),
              eq(lmsAssessmentAttempts.assessmentId, assessment.id),
            ),
          )
          .orderBy(desc(lmsAssessmentAttempts.submittedAt))
          .limit(20);
        res.json({
          assessment: {
            id: assessment.id,
            title: assessment.title,
            instructions: version.instructions,
            passingPercent: version.passingPercent,
            questionCount: grouped.size,
          },
          questions: Array.from(grouped.values()),
          attempts: attemptSummary?.attempts ?? 0,
          passed: Boolean(attemptSummary?.passed),
          attemptHistory,
        });
      } catch {
        res.status(500).json({ message: "Unable to load this assessment." });
      }
    },
  );

  app.post(
    "/api/lms/student/assessments/:assessmentId/attempts",
    requireAuthenticated,
    requireLmsRole("student"),
    async (req, res) => {
      const assessmentId = Number(req.params.assessmentId);
      const parsed = submitAssessmentSchema.safeParse(req.body);
      if (!Number.isSafeInteger(assessmentId) || assessmentId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid assessment submission." });
      }

      try {
        const outcome = await db.transaction(async (tx) => {
          const [assessment] = await tx
            .select()
            .from(lmsAssessments)
            .where(
              and(
                eq(lmsAssessments.id, assessmentId),
                eq(lmsAssessments.status, "published"),
              ),
            )
            .limit(1);
          if (!assessment) return { error: "Assessment not found.", status: 404 };

          const [chapter] = await tx
            .select({
              chapterId: lmsChapters.id,
              courseId: lmsModules.courseId,
            })
            .from(lmsChapters)
            .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
            .where(eq(lmsChapters.id, assessment.chapterId))
            .limit(1);
          if (!chapter) return { error: "Assessment not found.", status: 404 };

          const [enrollment] = await tx
            .select()
            .from(lmsEnrollments)
            .where(
              and(
                eq(lmsEnrollments.studentId, req.lmsUser!.id),
                eq(lmsEnrollments.courseId, chapter.courseId),
                eq(lmsEnrollments.status, "active"),
              ),
            )
            .for("update")
            .limit(1);
          if (!enrollment) return { error: "Assessment not found.", status: 404 };
          if (!(await chapterAssessmentIsUnlocked(enrollment.id, chapter.chapterId))) {
            return { error: "Complete the required lessons and previous assessments first.", status: 423 };
          }

          const [version] = await tx
            .select()
            .from(lmsAssessmentVersions)
            .where(
              and(
                eq(lmsAssessmentVersions.assessmentId, assessmentId),
                eq(lmsAssessmentVersions.version, assessment.activeVersion),
              ),
            )
            .limit(1);
          if (!version) return { error: "Assessment version not found.", status: 404 };

          const questions = await tx
            .select({ id: lmsAssessmentQuestions.id })
            .from(lmsAssessmentQuestions)
            .where(eq(lmsAssessmentQuestions.versionId, version.id));
          if (questions.length === 0) return { error: "This assessment has no questions.", status: 409 };

          const questionIds = questions.map(({ id }) => id);
          if (
            Object.keys(parsed.data.answers).length !== questionIds.length ||
            Object.keys(parsed.data.answers).some((id) => !questionIds.includes(Number(id)))
          ) {
            return { error: "Answer every question before submitting.", status: 400 };
          }

          const chosenOptionIds = Object.values(parsed.data.answers);
          const options = await tx
            .select({
              id: lmsAssessmentOptions.id,
              questionId: lmsAssessmentOptions.questionId,
              isCorrect: lmsAssessmentOptions.isCorrect,
            })
            .from(lmsAssessmentOptions)
            .where(inArray(lmsAssessmentOptions.id, chosenOptionIds));
          const optionById = new Map(options.map((option) => [option.id, option]));
          if (
            Object.entries(parsed.data.answers).some(([questionId, optionId]) => {
              const option = optionById.get(optionId);
              return !option || option.questionId !== Number(questionId);
            })
          ) {
            return { error: "One or more selected answers are invalid.", status: 400 };
          }

          const correct = Object.entries(parsed.data.answers).filter(
            ([questionId, optionId]) =>
              optionById.get(optionId)?.questionId === Number(questionId) &&
              optionById.get(optionId)?.isCorrect,
          ).length;
          const { scorePercent, passed } = calculateAssessmentScore(correct, questionIds.length);
          const [previousAttempts] = await tx
            .select({ total: count() })
            .from(lmsAssessmentAttempts)
            .where(
              and(
                eq(lmsAssessmentAttempts.enrollmentId, enrollment.id),
                eq(lmsAssessmentAttempts.assessmentId, assessmentId),
              ),
            );
          const attemptNumber = nextAssessmentAttemptNumber(previousAttempts?.total ?? 0);
          const [attempt] = await tx
            .insert(lmsAssessmentAttempts)
            .values({
              enrollmentId: enrollment.id,
              assessmentId,
              versionId: version.id,
              attemptNumber,
              answers: parsed.data.answers,
              scorePercent,
              passed,
            })
            .returning({
              id: lmsAssessmentAttempts.id,
              attemptNumber: lmsAssessmentAttempts.attemptNumber,
              scorePercent: lmsAssessmentAttempts.scorePercent,
              passed: lmsAssessmentAttempts.passed,
              submittedAt: lmsAssessmentAttempts.submittedAt,
            });
          return { attempt, showExplanations: version.showExplanationsAfterAttempt, versionId: version.id };
        });

        if ("error" in outcome) {
          return res.status(outcome.status ?? 500).json({ message: outcome.error });
        }
        const explanations = outcome.showExplanations
          ? await db
              .select({
                questionId: lmsAssessmentQuestions.id,
                explanation: lmsAssessmentQuestions.explanation,
              })
              .from(lmsAssessmentQuestions)
              .where(eq(lmsAssessmentQuestions.versionId, outcome.versionId))
          : [];
        return res.status(201).json({ ...outcome.attempt, explanations });
      } catch {
        return res.status(500).json({ message: "Unable to submit this assessment." });
      }
    },
  );

  app.get(
    "/api/lms/student/live-sessions",
    requireAuthenticated,
    requireLmsRole("student"),
    async (req, res) => {
      try {
        const sessions = await db
          .select({
            id: lmsLiveSessions.id,
            title: lmsLiveSessions.title,
            topic: lmsLiveSessions.topic,
            startsAt: lmsLiveSessions.startsAt,
            endsAt: lmsLiveSessions.endsAt,
            meetUrl: lmsLiveSessions.meetUrl,
            status: lmsLiveSessions.status,
            courseTitle: lmsCourses.title,
          })
          .from(lmsLiveSessions)
          .innerJoin(lmsCourses, eq(lmsLiveSessions.courseId, lmsCourses.id))
          .innerJoin(lmsEnrollments, eq(lmsEnrollments.courseId, lmsCourses.id))
          .where(
            and(
              eq(lmsEnrollments.studentId, req.lmsUser!.id),
              eq(lmsEnrollments.status, "active"),
              gt(lmsLiveSessions.startsAt, new Date()),
            ),
          )
          .orderBy(asc(lmsLiveSessions.startsAt));
        res.json(sessions);
      } catch {
        res.status(500).json({ message: "Unable to load live sessions." });
      }
    },
  );

  app.get(
    "/api/lms/trainer/courses",
    requireAuthenticated,
    requireLmsRole("trainer", "admin"),
    async (req, res) => {
      try {
        const query = db
          .select({
            id: lmsCourses.id,
            slug: lmsCourses.slug,
            title: lmsCourses.title,
            description: lmsCourses.description,
            status: lmsCourses.status,
          })
          .from(lmsCourses)
          .innerJoin(lmsTrainerAssignments, eq(lmsTrainerAssignments.courseId, lmsCourses.id));
        const courses =
          req.lmsUser!.roles.includes("admin")
            ? await db
                .select({
                  id: lmsCourses.id,
                  slug: lmsCourses.slug,
                  title: lmsCourses.title,
                  description: lmsCourses.description,
                  status: lmsCourses.status,
                })
                .from(lmsCourses)
                .orderBy(asc(lmsCourses.title))
            : await query
                .where(eq(lmsTrainerAssignments.trainerId, req.lmsUser!.id))
                .orderBy(asc(lmsCourses.title));
        res.json(courses);
      } catch {
        res.status(500).json({ message: "Unable to load assigned courses." });
      }
    },
  );

  app.get(
    "/api/lms/admin/overview",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const [[students], [trainers], [courses], [enrollments], [pendingCertificates]] =
          await Promise.all([
            db
              .select({ total: count() })
              .from(lmsUserRoles)
              .where(eq(lmsUserRoles.role, "student")),
            db
              .select({ total: count() })
              .from(lmsUserRoles)
              .where(eq(lmsUserRoles.role, "trainer")),
            db.select({ total: count() }).from(lmsCourses),
            db
              .select({ total: count() })
              .from(lmsEnrollments)
              .where(eq(lmsEnrollments.status, "active")),
            db
              .select({ total: count() })
              .from(lmsCertificates)
              .where(eq(lmsCertificates.status, "pending_review")),
          ]);
        res.json({
          students: students.total,
          trainers: trainers.total,
          courses: courses.total,
          activeEnrollments: enrollments.total,
          pendingCertificates: pendingCertificates.total,
        });
      } catch {
        res.status(500).json({ message: "Unable to load the admin overview." });
      }
    },
  );

  app.get(
    "/api/lms/admin/courses",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const courses = await db
          .select()
          .from(lmsCourses)
          .orderBy(desc(lmsCourses.updatedAt), asc(lmsCourses.title));
        res.json(courses);
      } catch {
        res.status(500).json({ message: "Unable to load courses." });
      }
    },
  );

  app.post(
    "/api/lms/admin/courses",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (req, res) => {
      const parsed = createCourseSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Enter a valid course title and slug." });
      try {
        const [course] = await db
          .insert(lmsCourses)
          .values({ ...parsed.data, createdBy: req.lmsUser!.id })
          .returning();
        await writeAudit(req.lmsUser!.id, "course.created", "course", course.id);
        res.status(201).json(course);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          return res.status(409).json({ message: "That course slug is already in use." });
        }
        res.status(500).json({ message: "Unable to create the course." });
      }
    },
  );

  app.patch(
    "/api/lms/admin/courses/:courseId/status",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (req, res) => {
      const courseId = Number(req.params.courseId);
      const parsed = z.object({ status: z.enum(["draft", "published", "archived"]) }).safeParse(req.body);
      if (!Number.isSafeInteger(courseId) || courseId < 1 || !parsed.success) {
        return res.status(400).json({ message: "Invalid course status request." });
      }
      try {
        if (parsed.data.status === "published") {
          const [content] = await db
            .select({ total: count() })
            .from(lmsLessons)
            .innerJoin(lmsChapters, eq(lmsLessons.chapterId, lmsChapters.id))
            .innerJoin(lmsModules, eq(lmsChapters.moduleId, lmsModules.id))
            .where(
              and(
                eq(lmsModules.courseId, courseId),
                eq(lmsModules.status, "published"),
                eq(lmsChapters.status, "published"),
                eq(lmsLessons.status, "published"),
              ),
            );
          if (!content?.total) {
            return res.status(409).json({ message: "Publish at least one module, chapter, and lesson before publishing this course." });
          }
        }
        const [course] = await db
          .update(lmsCourses)
          .set({ status: parsed.data.status, updatedAt: new Date() })
          .where(eq(lmsCourses.id, courseId))
          .returning();
        if (!course) return res.status(404).json({ message: "Course not found." });
        await writeAudit(req.lmsUser!.id, `course.${parsed.data.status}`, "course", course.id);
        res.json(course);
      } catch {
        res.status(500).json({ message: "Unable to update the course." });
      }
    },
  );

  app.get(
    "/api/lms/admin/students",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const students = await db
          .select({
            id: lmsUsers.id,
            displayName: lmsUsers.displayName,
            phoneE164: lmsUsers.phoneE164,
            isActive: lmsUsers.isActive,
            createdAt: lmsUsers.createdAt,
          })
          .from(lmsUsers)
          .innerJoin(lmsUserRoles, eq(lmsUserRoles.userId, lmsUsers.id))
          .where(eq(lmsUserRoles.role, "student"))
          .orderBy(desc(lmsUsers.createdAt));
        res.json(students);
      } catch {
        res.status(500).json({ message: "Unable to load students." });
      }
    },
  );

  app.get(
    "/api/lms/admin/trainers",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const trainers = await db
          .select({
            id: lmsUsers.id,
            displayName: lmsUsers.displayName,
            phoneE164: lmsUsers.phoneE164,
            isActive: lmsUsers.isActive,
            createdAt: lmsUsers.createdAt,
          })
          .from(lmsUsers)
          .innerJoin(lmsUserRoles, eq(lmsUserRoles.userId, lmsUsers.id))
          .where(eq(lmsUserRoles.role, "trainer"))
          .orderBy(desc(lmsUsers.createdAt));
        res.json(trainers);
      } catch {
        res.status(500).json({ message: "Unable to load trainers." });
      }
    },
  );

  app.get(
    "/api/lms/admin/invitations",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (_req, res) => {
      try {
        const invitations = await db
          .select({
            id: lmsInvitationCodes.id,
            codeHint: sql<string>`substring(${lmsInvitationCodes.codeHash}, 1, 8)`,
            courseId: lmsInvitationCodes.courseId,
            courseTitle: lmsCourses.title,
            status: lmsInvitationCodes.status,
            expiresAt: lmsInvitationCodes.expiresAt,
            maxUses: lmsInvitationCodes.maxUses,
            usesCount: lmsInvitationCodes.usesCount,
            reservedForPhone: lmsInvitationCodes.reservedForPhone,
            createdAt: lmsInvitationCodes.createdAt,
          })
          .from(lmsInvitationCodes)
          .innerJoin(lmsCourses, eq(lmsInvitationCodes.courseId, lmsCourses.id))
          .orderBy(desc(lmsInvitationCodes.createdAt));
        res.json(invitations);
      } catch {
        res.status(500).json({ message: "Unable to load invitations." });
      }
    },
  );

  app.post(
    "/api/lms/admin/invitations",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (req, res) => {
      const parsed = createInvitationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Enter valid invitation details." });
      }
      try {
        const [course] = await db
          .select({ id: lmsCourses.id })
          .from(lmsCourses)
          .where(and(eq(lmsCourses.id, parsed.data.courseId), eq(lmsCourses.status, "published")))
          .limit(1);
        if (!course) return res.status(404).json({ message: "Published course not found." });

        const rawCode = randomBytes(12).toString("base64url").toUpperCase();
        const [invitation] = await db
          .insert(lmsInvitationCodes)
          .values({
            codeHash: hashCode(rawCode),
            courseId: course.id,
            expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
            maxUses: parsed.data.maxUses,
            reservedForPhone: parsed.data.reservedForPhone
              ? normalizePhone(parsed.data.reservedForPhone)
              : null,
            createdBy: req.lmsUser!.id,
          })
          .returning({ id: lmsInvitationCodes.id });
        await writeAudit(req.lmsUser!.id, "invitation.created", "invitation", invitation.id, {
          courseId: course.id,
          maxUses: parsed.data.maxUses,
        });
        res.status(201).json({
          id: invitation.id,
          code: rawCode,
          message: "Copy this code now. It cannot be shown again.",
        });
      } catch {
        res.status(500).json({ message: "Unable to create the invitation code." });
      }
    },
  );

  app.post(
    "/api/lms/admin/invitations/:invitationId/revoke",
    requireAuthenticated,
    requireLmsRole("admin"),
    async (req, res) => {
      const invitationId = Number(req.params.invitationId);
      if (!Number.isSafeInteger(invitationId) || invitationId < 1) {
        return res.status(400).json({ message: "Invalid invitation." });
      }
      try {
        const [invitation] = await db
          .update(lmsInvitationCodes)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(lmsInvitationCodes.id, invitationId))
          .returning({ id: lmsInvitationCodes.id });
        if (!invitation) return res.status(404).json({ message: "Invitation not found." });
        await writeAudit(req.lmsUser!.id, "invitation.revoked", "invitation", invitation.id);
        res.json({ revoked: true });
      } catch {
        res.status(500).json({ message: "Unable to revoke this invitation." });
      }
    },
  );
}
