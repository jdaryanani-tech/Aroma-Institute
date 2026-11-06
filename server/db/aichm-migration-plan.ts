export type MigrationTable = {
  table: string;
  dependsOn: string[];
};

export const PRESERVED_SUPABASE_PUBLIC_TABLES = [
  "leads",
  "conversations",
  "course_knowledge",
] as const;

export const FUTURE_CALENDAR_TABLES = [
  "calendar_resources",
  "calendar_batches",
  "calendar_batch_students",
  "calendar_events",
  "calendar_event_attendees",
  "staff_availability",
  "availability_exceptions",
  "notification_preferences",
  "push_subscriptions",
  "calendar_reminder_jobs",
  "notification_delivery_logs",
  "calendar_activity",
] as const;

export const AICHM_MIGRATION_ORDER: MigrationTable[] = [
  { table: "lms_users", dependsOn: [] },
  { table: "lms_user_roles", dependsOn: ["lms_users"] },
  { table: "lms_auth_rate_limits", dependsOn: [] },
  { table: "lms_otp_challenges", dependsOn: ["lms_users"] },
  { table: "lms_password_setup_tokens", dependsOn: ["lms_users"] },
  { table: "sessions", dependsOn: [] },
  { table: "admissions_capture_limits", dependsOn: [] },
  { table: "admissions_leads", dependsOn: [] },
  { table: "lms_courses", dependsOn: ["lms_users"] },
  { table: "lms_modules", dependsOn: ["lms_courses"] },
  { table: "lms_chapters", dependsOn: ["lms_modules"] },
  { table: "lms_lessons", dependsOn: ["lms_chapters"] },
  { table: "lms_assessments", dependsOn: ["lms_chapters"] },
  { table: "lms_assessment_versions", dependsOn: ["lms_assessments", "lms_users"] },
  { table: "lms_assessment_questions", dependsOn: ["lms_assessment_versions"] },
  { table: "lms_assessment_options", dependsOn: ["lms_assessment_questions"] },
  { table: "lms_enrollments", dependsOn: ["lms_users", "lms_courses"] },
  { table: "lms_lesson_progress", dependsOn: ["lms_enrollments", "lms_lessons"] },
  {
    table: "lms_assessment_attempts",
    dependsOn: ["lms_assessments", "lms_assessment_versions", "lms_enrollments"],
  },
  { table: "lms_certificates", dependsOn: ["lms_enrollments", "lms_users"] },
  { table: "lms_invitation_codes", dependsOn: ["lms_courses", "lms_users"] },
  {
    table: "lms_invitation_redemptions",
    dependsOn: ["lms_invitation_codes", "lms_enrollments", "lms_users"],
  },
  { table: "lms_trainer_assignments", dependsOn: ["lms_courses", "lms_users"] },
  { table: "lms_live_sessions", dependsOn: ["lms_courses", "lms_users"] },
  { table: "lms_attendance", dependsOn: ["lms_live_sessions", "lms_users"] },
  { table: "lms_resources", dependsOn: ["lms_lessons", "lms_users"] },
  { table: "lms_notifications", dependsOn: ["lms_users"] },
  { table: "lms_audit_logs", dependsOn: ["lms_users"] },
  { table: "inquiries", dependsOn: ["admissions_leads"] },
  { table: "counselling_delivery_attempts", dependsOn: ["inquiries"] },
  { table: "admissions_vsl_events", dependsOn: ["admissions_leads"] },
  { table: "admissions_vsl_playbacks", dependsOn: ["admissions_leads"] },
  { table: "admissions_crm_profiles", dependsOn: ["inquiries", "lms_users"] },
  { table: "admissions_crm_activities", dependsOn: ["inquiries", "lms_users"] },
  { table: "calendar_resources", dependsOn: ["lms_users"] },
  { table: "calendar_batches", dependsOn: ["lms_courses", "lms_users"] },
  { table: "calendar_batch_students", dependsOn: ["calendar_batches", "lms_users"] },
  { table: "staff_availability", dependsOn: ["lms_users"] },
  { table: "availability_exceptions", dependsOn: ["lms_users", "calendar_resources"] },
  { table: "notification_preferences", dependsOn: ["lms_users"] },
  { table: "push_subscriptions", dependsOn: ["lms_users"] },
  {
    table: "calendar_events",
    dependsOn: [
      "admissions_leads",
      "inquiries",
      "lms_courses",
      "lms_live_sessions",
      "calendar_batches",
      "calendar_resources",
      "lms_users",
    ],
  },
  { table: "calendar_event_attendees", dependsOn: ["calendar_events", "lms_users", "admissions_leads", "inquiries"] },
  { table: "calendar_reminder_jobs", dependsOn: ["calendar_events", "lms_notifications", "lms_users"] },
  { table: "notification_delivery_logs", dependsOn: ["lms_notifications", "push_subscriptions"] },
  { table: "calendar_activity", dependsOn: ["calendar_events", "lms_users"] },
];

export interface InventoryTable {
  schema_name?: string;
  table_name?: string;
  exact_rows?: string | null;
  schema?: string;
  table?: string;
  exactRows?: string;
  relkind?: string;
}

export interface InventorySnapshot {
  database?: {
    database_name?: string;
  };
  overview?: {
    database_name?: string;
  };
  tables?: InventoryTable[];
  exactTableCounts?: InventoryTable[];
}

function inventoryRows(snapshot: InventorySnapshot): InventoryTable[] {
  return snapshot.exactTableCounts ?? snapshot.tables ?? [];
}

function rowCount(
  snapshot: InventorySnapshot,
  schema: string,
  table: string,
): string | null {
  const match = inventoryRows(snapshot).find(
    (row) =>
      (row.schema_name ?? row.schema) === schema &&
      (row.table_name ?? row.table) === table,
  );
  if (!match) return null;
  return match.exact_rows ?? match.exactRows ?? null;
}

export function assertDryRunOnly(args: string[]): void {
  if (args.includes("--apply")) {
    throw new Error(
      "Apply mode is not implemented in this preparation scaffold; no database writes are possible.",
    );
  }
  const unsupported = args.filter((arg) => arg !== "--dry-run");
  if (unsupported.length) {
    throw new Error("Only the default dry-run mode is supported by this scaffold.");
  }
}

export function validateMigrationOrder(order: MigrationTable[] = AICHM_MIGRATION_ORDER): void {
  const position = new Map(order.map((entry, index) => [entry.table, index]));
  if (position.size !== order.length) {
    throw new Error("Migration plan contains duplicate table names.");
  }
  for (const entry of order) {
    for (const dependency of entry.dependsOn) {
      const dependencyPosition = position.get(dependency);
      const tablePosition = position.get(entry.table);
      if (dependencyPosition === undefined || dependencyPosition >= tablePosition!) {
        throw new Error(`Migration dependency order is invalid for ${entry.table}.`);
      }
    }
  }
}

export function buildMigrationDryRunPlan(
  source: InventorySnapshot,
  target: InventorySnapshot,
) {
  validateMigrationOrder();
  const sourceDatabase = source.database?.database_name ?? source.overview?.database_name ?? "unknown";
  const targetDatabase = target.database?.database_name ?? target.overview?.database_name ?? "unknown";
  if (sourceDatabase === targetDatabase && sourceDatabase !== "unknown") {
    throw new Error("Source and target database names match; refusing to plan a migration.");
  }

  const sourceTableNames = new Set(
    inventoryRows(source)
      .filter((row) => (row.schema_name ?? row.schema) === "public")
      .map((row) => row.table_name ?? row.table)
      .filter((name): name is string => Boolean(name)),
  );

  const mappedTables = AICHM_MIGRATION_ORDER.map(({ table, dependsOn }) => {
    const sourcePresent = sourceTableNames.has(table);
    const sourceRows = sourcePresent ? rowCount(source, "public", table) : null;
    const targetRows = rowCount(target, "aichm", table);
    return {
      source: sourcePresent ? `public.${table}` : null,
      target: `aichm.${table}`,
      sourceRows,
      targetRows,
      dependsOn,
      state: !sourcePresent
        ? FUTURE_CALENDAR_TABLES.includes(table as (typeof FUTURE_CALENDAR_TABLES)[number])
          ? "future-calendar-schema"
          : "source-table-not-in-snapshot"
        : targetRows === null
          ? "target-schema-not-created"
          : "comparison-only",
    };
  });

  const preservedTables = PRESERVED_SUPABASE_PUBLIC_TABLES.map((table) => ({
    table: `public.${table}`,
    rows: rowCount(target, "public", table),
    action: "preserve-in-place; never copy or overwrite",
  }));

  return {
    mode: "dry-run",
    sourceDatabase,
    targetDatabase,
    writesEnabled: false,
    rowContentsRead: false,
    keyConflictCheck: "not performed; no primary-key values were read",
    phoneReconciliation: "not performed; candidate matches require a separately approved, privacy-safe review",
    targetSchema: "aichm",
    mappedTables,
    preservedTables,
  };
}
