import { pool } from "../server/db";
import { runCalendarReminderJobs } from "../server/calendar/reminders";

async function main() {
  if (process.env.AICHM_CALENDAR_REMINDERS_ENABLED !== "true") {
    throw new Error("Calendar reminder dispatcher is disabled. Enable it only in the scheduled deployment environment.");
  }
  const result = await runCalendarReminderJobs();
  console.info(`Calendar reminders: ${result.claimed} claimed, ${result.sent} sent, ${result.deferred} deferred, ${result.failed} failed.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Calendar reminder job failed.");
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
