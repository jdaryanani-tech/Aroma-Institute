import { count, eq } from "drizzle-orm";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { lmsAuditLogs, lmsUserRoles, lmsUsers } from "@shared/lms-schema";
import { db, pool } from "../server/db";
import { hashLmsPassword, normalizeLmsPhone } from "../server/lms/password-security";

function readSecret(prompt: string) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Run this command in a terminal so the password can be entered without echo.");
  }

  output.write(prompt);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Password entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}

async function main() {
  const terminal = createInterface({ input, output });
  try {
    const phoneInput = (await terminal.question("Administrator phone (E.164 or 10-digit Indian mobile): ")).trim();
    const displayName = (await terminal.question("Administrator name: ")).trim();
    terminal.close();
    const phoneE164 = normalizeLmsPhone(phoneInput);
    if (!phoneE164) throw new Error("Enter a valid phone number.");
    if (displayName.length < 2 || displayName.length > 180) {
      throw new Error("Name must be between 2 and 180 characters.");
    }
    const password = await readSecret("Administrator password (at least 12 characters; input hidden): ");
    const confirmation = await readSecret("Confirm administrator password (input hidden): ");
    if (password.length < 12 || password.length > 128) {
      throw new Error("Password must be between 12 and 128 characters.");
    }
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const passwordHash = await hashLmsPassword(password);

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
        .values({ phoneE164, displayName, passwordHash })
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
    console.log("Sign in with the administrator phone number and password.");
  } finally {
    terminal.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unable to create the administrator.");
  process.exitCode = 1;
});
