export type ScratchPostgresState = "running" | "stopped" | "unknown";

export type ScratchPostgresCleanupResult =
  | { ok: true; scratchRemoved: true }
  | {
      ok: false;
      scratchRemoved: false;
      scratchPreserved: boolean;
      errorCode:
        | "local_postgres_state_uncertain"
        | "local_postgres_stop_failed"
        | "local_postgres_stop_unconfirmed"
        | "scratch_directory_removal_failed";
    };

export async function stopConfirmAndRemoveScratchPostgres(input: {
  inspectState: () => Promise<ScratchPostgresState>;
  stop: () => Promise<void>;
  removeScratch: () => Promise<void>;
}): Promise<ScratchPostgresCleanupResult> {
  let state: ScratchPostgresState;
  try {
    state = await input.inspectState();
  } catch {
    return {
      ok: false,
      scratchRemoved: false,
      scratchPreserved: true,
      errorCode: "local_postgres_state_uncertain",
    };
  }

  if (state === "unknown") {
    return {
      ok: false,
      scratchRemoved: false,
      scratchPreserved: true,
      errorCode: "local_postgres_state_uncertain",
    };
  }

  if (state === "running") {
    try {
      await input.stop();
    } catch {
      return {
        ok: false,
        scratchRemoved: false,
        scratchPreserved: true,
        errorCode: "local_postgres_stop_failed",
      };
    }

    try {
      state = await input.inspectState();
    } catch {
      return {
        ok: false,
        scratchRemoved: false,
        scratchPreserved: true,
        errorCode: "local_postgres_state_uncertain",
      };
    }

    if (state !== "stopped") {
      return {
        ok: false,
        scratchRemoved: false,
        scratchPreserved: true,
        errorCode:
          state === "running"
            ? "local_postgres_stop_unconfirmed"
            : "local_postgres_state_uncertain",
      };
    }
  }

  try {
    await input.removeScratch();
    return { ok: true, scratchRemoved: true };
  } catch {
    return {
      ok: false,
      scratchRemoved: false,
      scratchPreserved: false,
      errorCode: "scratch_directory_removal_failed",
    };
  }
}
