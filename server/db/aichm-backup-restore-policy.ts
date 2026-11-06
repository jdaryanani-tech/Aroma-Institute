export type BackupRestoreScope =
  | "full_database"
  | "public_schema"
  | "supabase_application";
export type BackupCreationMode = "initial" | "refresh_source" | "refresh_supabase";

export function selectDumpScopes(
  mode: BackupCreationMode,
  existingScopes: readonly BackupRestoreScope[],
): BackupRestoreScope[] {
  if (mode === "refresh_source") return ["full_database"];
  if (mode === "refresh_supabase") return ["supabase_application"];
  return (["full_database", "supabase_application"] as const).filter(
    (scope) => !existingScopes.includes(scope),
  );
}

export interface BackupRestoreReference {
  manifest: {
    source: {
      scope: BackupRestoreScope;
    };
  };
}

export function selectRestoreBackups<T extends BackupRestoreReference>(
  backups: readonly T[],
  sourceProductionOnly: boolean,
): T[] {
  if (!sourceProductionOnly) return [...backups];
  const sourceBackups = backups.filter(
    (backup) => backup.manifest.source.scope === "full_database",
  );
  return sourceBackups.length === 1 ? [sourceBackups[0]] : [];
}
