export type BackupRestoreScope = "full_database" | "public_schema";
export type BackupCreationMode = "initial" | "refresh_source";

export function selectDumpScopes(
  mode: BackupCreationMode,
  existingScopes: readonly BackupRestoreScope[],
): BackupRestoreScope[] {
  if (mode === "refresh_source") return ["full_database"];
  return (["full_database", "public_schema"] as const).filter(
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
