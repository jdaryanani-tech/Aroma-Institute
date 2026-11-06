export type BackupRestoreScope = "full_database" | "public_schema";

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
