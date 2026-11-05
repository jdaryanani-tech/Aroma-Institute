import { randomUUID } from "node:crypto";
import { pool } from "../db";
import { lmsNotifications, lmsUserRoles } from "@shared/lms-schema";
import { calendarEvents, calendarReminderJobs, notificationPreferences } from "@shared/calendar-schema";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { sendPushNotification } from "./push";
import { quietHoursDelayMinutes, reminderRetryDelayMs } from "./policy";

export async function runCalendarReminderJobs(batchSize = 50) {
  const client = await pool.connect();
  let jobs: Array<{ id: string; event_id: string | null; event_version: number | null; user_id: number; idempotency_key: string; attempt_count: number; lock_token: string }> = [];
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id,event_id,event_version,user_id,idempotency_key,attempt_count
       FROM calendar_reminder_jobs
       WHERE ((state='pending' AND due_at<=now()) OR (state='sending' AND locked_at<now()-interval '5 minutes'))
         AND attempt_count<5
       ORDER BY due_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [batchSize],
    );
    jobs = selected.rows.map((row) => ({ ...row, lock_token: randomUUID(), attempt_count: Number(row.attempt_count) + 1 }));
    for (const job of jobs) {
      await client.query(
        `UPDATE calendar_reminder_jobs
         SET state='sending',attempt_count=$2,locked_at=now(),lock_token=$3,updated_at=now()
         WHERE id=$1`,
        [job.id, job.attempt_count, job.lock_token],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let sent = 0;
  let deferred = 0;
  let failed = 0;
  for (const job of jobs) {
    const [event] = job.event_id
      ? await db.select().from(calendarEvents).where(eq(calendarEvents.id, job.event_id)).limit(1)
      : [];
    const cancellationJob=job.idempotency_key.endsWith(":cancelled");
    if (!event || (event.status === "cancelled"&&!cancellationJob) || event.status==="completed" ||
        (job.event_version!==null&&event.version!==job.event_version)) {
      await pool.query(
        `UPDATE calendar_reminder_jobs SET state='failed',last_error='Event is no longer active or this reminder was superseded.',
         lock_token=NULL,locked_at=NULL,updated_at=now() WHERE id=$1 AND lock_token=$2`,
        [job.id, job.lock_token],
      );
      failed++;
      continue;
    }
    const [categoryPreference] = await db.select().from(notificationPreferences).where(and(
      eq(notificationPreferences.userId, job.user_id),
      eq(notificationPreferences.category, event.category),
    )).limit(1);
    const [defaultPreference] = categoryPreference ? [] : await db.select().from(notificationPreferences).where(and(
      eq(notificationPreferences.userId, job.user_id),
      eq(notificationPreferences.category, "default"),
    )).limit(1);
    const preference=categoryPreference??defaultPreference;
    const now = new Date();
    const delay = quietHoursDelayMinutes(now, preference?.timezone ?? event.timezone,
      preference?.quietHoursStart ?? null, preference?.quietHoursEnd ?? null);
    if (delay > 0) {
      await pool.query(
        `UPDATE calendar_reminder_jobs SET state='pending',due_at=$3,locked_at=NULL,lock_token=NULL,
         last_error=NULL,updated_at=now() WHERE id=$1 AND lock_token=$2`,
        [job.id, job.lock_token, new Date(now.getTime() + delay * 60_000)],
      );
      deferred++;
      continue;
    }
    let notificationId: number | null = null;
    {
      const [inserted] = await db.insert(lmsNotifications).values({
        userId: job.user_id,
        title: cancellationJob?"Schedule cancelled":event.title,
        body: cancellationJob?"An event was cancelled. Open the app to view the updated schedule.":
          `Upcoming ${event.eventType.replaceAll("_", " ")} · ${new Intl.DateTimeFormat("en-IN", {
            timeZone: event.timezone, dateStyle: "medium", timeStyle: "short",
          }).format(event.startsAt)}`,
        category: event.category,
        priority: "normal",
        link: event.studentId ? `/learn/calendar?event=${event.id}` : `/admin/calendar?event=${event.id}`,
        metadata: { eventId: event.id },
        idempotencyKey: job.idempotency_key,
      }).onConflictDoNothing({ target: lmsNotifications.idempotencyKey }).returning({ id: lmsNotifications.id });
      if (inserted) notificationId = inserted.id;
      else {
        const [existing] = await db.select({ id: lmsNotifications.id }).from(lmsNotifications)
          .where(eq(lmsNotifications.idempotencyKey, job.idempotency_key)).limit(1);
        notificationId = existing?.id ?? null;
      }
    }
    if (notificationId && preference?.pushEnabled !== false) {
      const roles = await db.select({ role: lmsUserRoles.role }).from(lmsUserRoles).where(eq(lmsUserRoles.userId, job.user_id));
      const scope = roles.some(row => row.role === "student") && !roles.some(row => row.role !== "student") ? "learn" : "admin";
      const result = await sendPushNotification({
        userId: job.user_id,
        notificationId,
        scope,
        url: event.studentId ? "/learn/calendar" : "/admin/calendar",
        attemptNumber: job.attempt_count,
      });
      if (result.failed > 0 && job.attempt_count < 5) {
        await pool.query(
          `UPDATE calendar_reminder_jobs SET state='pending',due_at=now()+($3::text||' milliseconds')::interval,
           locked_at=NULL,lock_token=NULL,last_error='Transient push delivery failure.',updated_at=now()
           WHERE id=$1 AND lock_token=$2`,
          [job.id, job.lock_token, reminderRetryDelayMs(job.attempt_count)],
        );
        deferred++;
        continue;
      }
      if (result.failed > 0 && result.sent === 0) {
        await pool.query(
          `UPDATE calendar_reminder_jobs SET state='failed',last_error='Push delivery retries exhausted.',
           locked_at=NULL,lock_token=NULL,updated_at=now() WHERE id=$1 AND lock_token=$2`,
          [job.id, job.lock_token],
        );
        failed++;
        continue;
      }
    }
    await pool.query(
      `UPDATE calendar_reminder_jobs SET state='sent',notification_id=$3,completed_at=now(),
       locked_at=NULL,lock_token=NULL,last_error=NULL,updated_at=now()
       WHERE id=$1 AND lock_token=$2`,
      [job.id, job.lock_token, notificationId],
    );
    sent++;
  }
  return { claimed: jobs.length, sent, deferred, failed };
}
