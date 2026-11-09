#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  LegacySchemaGuardError,
  validateLegacySchemaChangeTarget,
} from "../server/db/legacy-schema-change-guard.js";

const action = process.argv[2];
if (action !== "migrate" && action !== "push") {
  console.error("Usage: guarded-drizzle.ts <migrate|push> [...drizzle arguments]");
  process.exit(2);
}

const forwardedArguments = process.argv.slice(3);
if (forwardedArguments.some((argument) => argument === "--config" || argument.startsWith("--config="))) {
  console.error("Custom Drizzle configs are not allowed through the legacy schema guard.");
  process.exit(2);
}

try {
  validateLegacySchemaChangeTarget(process.env);
} catch (error) {
  const code = error instanceof LegacySchemaGuardError ? error.code : "SCHEMA_GUARD_REJECTED";
  console.error(`Legacy Drizzle schema change blocked: ${code}`);
  console.error("Use an explicitly authorized, allowlisted loopback development database.");
  process.exit(1);
}

const childEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  TEMP: process.env.TEMP,
  CI: process.env.CI,
  NODE_ENV: process.env.NODE_ENV,
  AICHM_SCHEMA_CHANGE_INTENT: process.env.AICHM_SCHEMA_CHANGE_INTENT,
  AICHM_DEVELOPMENT_DATABASE_URL: process.env.AICHM_DEVELOPMENT_DATABASE_URL,
};

const result = spawnSync(
  "drizzle-kit",
  [action, "--config=drizzle.config.ts", ...forwardedArguments],
  { stdio: "inherit", env: childEnvironment },
);

if (result.error) {
  console.error("Unable to start the guarded Drizzle command.");
  process.exit(1);
}
process.exit(result.status ?? 1);
