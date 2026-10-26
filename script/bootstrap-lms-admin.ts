import { count, eq } from "drizzle-orm";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { lmsAuditLogs, lmsUserRoles, lmsUsers } from "@shared/lms-schema";
import { db, pool } from "../server/db";

async function main() {
  const terminal = createInterface({ input, output });
  try {
    const phoneE164 = (await terminal.question("Administrator phone in E.164 format (for OTP sign-in): ")).trim();
    const displayName = (await terminal.question("Administrator name: ")).trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phoneE164)) {
      throw new Error("Phone must include a country code, for example +919876543210.");
    }
    if (displayName.length < 2 || displayName.length > 180) {
      throw new Error("Name must be between 2 and 180 characters.");
    }

    await db.transaction(async (tx) => {
      const [existingAdmin] = await tx
        .select({ total: count() })
        .from(lmsUserRoles)
        .where(eq(lmsUserRoles.role, "admin"));
      if (existingAdmin.total > 0) {
        throw new Error("An administrator already exists. Use the LMS admin portal to manage accounts.");
      }

      const [existingUser] = await tx
        .select({ id: lmsUsers.id })
        .from(lmsUsers)
        .where(eq(lmsUsers.phoneE164, phoneE164))
        .limit(1);
      if (existingUser) {
        throw new Error("An account already exists for that phone. Ask an existing administrator to grant access.");
      }

      const [user] = await tx
        .insert(lmsUsers)
        .values({ phoneE164, displayName })
        .returning({ id: lmsUsers.id });
      await tx.insert(lmsUserRoles).values({ userId: user.id, role: "admin" });
      await tx.insert(lmsAuditLogs).values({
        actorId: user.id,
        action: "bootstrap.admin_created",
        entityType: "user",
        entityId: String(user.id),
        metadata: { role: "admin" },
      });
    });

    console.log("Administrator account created.");
    console.log("Sign-in will remain unavailable until the verified n8n OTP workflow is configured.");
  } finally {
    terminal.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unable to create the administrator.");
  process.exitCode = 1;
});
