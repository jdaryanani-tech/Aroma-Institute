type Observation = "play" | "sample" | "pause" | "seek" | "ended";
type Status = "initial" | "saving" | "saved" | "unlinked" | "error";
type Transport = (url: string, body: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
type MetaMilestone = { eventName: string; eventId: string; customData?: Record<string, string | number | boolean> };

const defaultTransport: Transport = (url, body) => fetch(url, {
  method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body), keepalive: true,
});

/** Serialized, retryable observations; lead identity is never accepted from JS. */
export function createDurableVslTracker(
  onStatus: (status: Status) => void,
  transport: Transport = defaultTransport,
  onMetaMilestones: (events: MetaMilestone[]) => void = () => undefined,
) {
  let playbackId: string | null = null;
  let initialized: Promise<void> | undefined;
  let sequence = 0;
  let lastSampleAt = 0;
  let stopped = false;
  let queue = Promise.resolve();
  const initialize = () => initialized ??= (async () => {
    const response = await transport("/api/vsl/playbacks", {});
    if (response.status === 401) { stopped = true; onStatus("unlinked"); return; }
    if (!response.ok) throw new Error("capture_unavailable");
    const data = await response.json();
    if (typeof data.playbackId !== "string") throw new Error("invalid_capture_response");
    playbackId = data.playbackId;
  })();

  return {
    observe(type: Observation, position: number, duration: number, seeking = false) {
      if (stopped || !Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
      if (type === "sample") {
        if (seeking || Date.now() - lastSampleAt < 4000) return;
        lastSampleAt = Date.now();
      }
      queue = queue.then(async () => {
        if (stopped) return;
        onStatus("saving");
        await initialize();
        if (!playbackId || stopped) return;
        const body = { playbackId, sequence: ++sequence, type, position, duration };
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await transport("/api/vsl/events", body);
            if (response.ok) {
              const result = await response.json().catch(() => null);
              if (Array.isArray(result?.metaEvents)) onMetaMilestones(result.metaEvents);
              onStatus("saved");
              return;
            }
            if (response.status < 500) throw new Error("capture_rejected");
          } catch (error) {
            if (attempt === 2 || (error instanceof Error && error.message === "capture_rejected")) throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
        throw new Error("capture_failed");
      }).catch(() => { stopped = true; onStatus("error"); });
    },
    // Lets safe automated tests await the exact same queue used by the player.
    flush: () => queue,
  };
}
