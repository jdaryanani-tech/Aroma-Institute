import { defineConfig } from "drizzle-kit";
import { requireAichmForwardScratchDatabaseUrl } from "./server/db/aichm-forward-migration-guard";

const url = requireAichmForwardScratchDatabaseUrl();

export default defineConfig({
  dialect: "postgresql",
  out: "./migrations/aichm-forward",
  dbCredentials: { url },
  migrations: {
    schema: "aichm_forward_migration_meta",
    table: "__drizzle_migrations",
  },
});
