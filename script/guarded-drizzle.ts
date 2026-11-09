import { spawnSync } from "node:child_process";
import {
  LegacySchemaGuardError,
  verifyLegacySchemaChangeTarget,
} from "../server/db/legacy-schema-change-guard";

const usage =
  "Usage: npm run db:migrate|db:push -- [Drizzle options]\n" +
  "Development target identity setup: AICHM_SCHEMA_CHANGE_INTENT=development npm run db:identify:development";

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  if (action !== "migrate" && action !== "push" && action !== "identify") {
    throw new LegacySchemaGuardError("SCHEMA_GUARD_COMMAND_REJECTED");
  }
  if (args.some((arg) => arg === "--config" || arg.startsWith("--config="))) {
    throw new LegacySchemaGuardError("SCHEMA_GUARD_CONFIG_OVERRIDE_REJECTED");
  }

  const verified = await verifyLegacySchemaChangeTarget(
    process.env,
    undefined,
    { allowMissingDevelopmentId: action === "identify" },
  );

  if (action === "identify") {
    process.stdout.write(`AICHM_DEVELOPMENT_DATABASE_ID=${verified.targetIdentityId}\n`);
    return;
  }

  process.stdout.write("Development database identity verified; starting guarded Drizzle command.\n");
  const childEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    CI: process.env.CI,
    NODE_ENV: process.env.NODE_ENV === "test" ? "test" : "development",
    AICHM_DEVELOPMENT_DATABASE_URL: verified.targetUrl,
    AICHM_DEVELOPMENT_DATABASE_ID: verified.targetIdentityId,
    AICHM_SCHEMA_CHANGE_VERIFIED_TARGET_ID: verified.targetIdentityId,
  };
  const result = spawnSync(
    "drizzle-kit",
    [action, "--config=drizzle.config.ts", ...args],
    { cwd: process.cwd(), env: childEnvironment, stdio: "inherit" },
  );
  if (result.error) {
    throw new LegacySchemaGuardError("SCHEMA_GUARD_DRIZZLE_COMMAND_UNAVAILABLE");
  }
  process.exitCode = result.status ?? 1;
}

main().catch((error: unknown) => {
  const safeMessage =
    error instanceof LegacySchemaGuardError
      ? error.code
      : "SCHEMA_GUARD_BLOCKED";
  console.error(`Schema command blocked or failed safely: ${safeMessage}`);
  process.exitCode = 1;
});
