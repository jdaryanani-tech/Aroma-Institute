import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as siteSchema from "@shared/schema";
import * as lmsSchema from "@shared/lms-schema";
import * as calendarSchema from "@shared/calendar-schema";
import * as avniSchema from "@shared/avni-schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Transcript table types remain available only as legacy documentation; they
// are intentionally excluded from the active application database schema.
export const db = drizzle(pool, {
  schema: {
    ...siteSchema,
    ...lmsSchema,
    ...calendarSchema,
    admissionsLegacyLeadLinks: avniSchema.admissionsLegacyLeadLinks,
  },
});
