import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as siteSchema from "@shared/schema";
import * as lmsSchema from "@shared/lms-schema";
import * as calendarSchema from "@shared/calendar-schema";
import * as avniSchema from "@shared/avni-schema";
import {
  buildApplicationPoolConfig,
  resolveApplicationRuntimeMode,
} from "./db/application-runtime-connection";

export const applicationRuntimeMode = resolveApplicationRuntimeMode(process.env);

export const pool = new Pool(buildApplicationPoolConfig(applicationRuntimeMode));

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
