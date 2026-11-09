import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./migrations",
  schema: ["./shared/schema.ts", "./shared/lms-schema.ts", "./shared/calendar-schema.ts"],
});
