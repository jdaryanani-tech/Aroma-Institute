import { defineConfig } from "drizzle-kit";
import { requireGuardedDrizzleConfigUrl } from "./server/db/legacy-schema-change-guard";

const url = requireGuardedDrizzleConfigUrl(process.env);

export default defineConfig({
  out: "./migrations",
  schema: ["./shared/schema.ts", "./shared/lms-schema.ts", "./shared/calendar-schema.ts"],
  dialect: "postgresql",
  dbCredentials: { url },
});
