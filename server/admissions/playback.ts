export type PlaybackSample = {
  sequence: number;
  type: "play" | "sample" | "pause" | "seek" | "ended";
  position: number;
  duration: number;
};
export type PlaybackState = {
  lastPosition: number | null;
  lastObservedAt: Date | null;
  duration: number | null;
  ranges: [number, number][];
  sequence: number;
};

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const result: [number, number][] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

/** Browser observations, not elapsed-time completion. Gaps/seeks never add coverage. */
export function observePlayback(state: PlaybackState, sample: PlaybackSample, now: Date) {
  if (sample.sequence <= state.sequence) return { state, events: [] as string[], duplicate: true };
  if (sample.sequence !== state.sequence + 1) throw new Error("out_of_order");
  const duration = state.duration;
  if (!duration || Math.abs(sample.duration - duration) > 3 || sample.position > duration + 1) {
    throw new Error("invalid_media_duration");
  }
  let ranges = state.ranges.map(([a, b]) => [a, b] as [number, number]);
  const delta = state.lastPosition === null ? 0 : sample.position - state.lastPosition;
  const elapsed = state.lastObservedAt ? (now.getTime() - state.lastObservedAt.getTime()) / 1000 : 0;
  let observedInterval: [number, number] | undefined;
  if (
    (sample.type === "sample" || sample.type === "ended" || sample.type === "pause") &&
    state.lastPosition !== null && delta > 0 && delta <= 10 &&
    elapsed >= 0 && delta <= elapsed * 1.25 + 0.75
  ) {
    observedInterval = [state.lastPosition, Math.min(sample.position, duration)];
    ranges = mergeRanges([...ranges, observedInterval]);
    if (ranges.length > 256) throw new Error("too_many_discontinuities");
  }
  const events: string[] = sample.type === "play" ? ["started"] : [];
  for (const milestone of [25, 50, 75, 90]) {
    const boundary = duration * milestone / 100;
    const prefixCoverage = ranges.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, boundary) - a), 0);
    if (
      observedInterval && observedInterval[0] < boundary && observedInterval[1] >= boundary &&
      prefixCoverage >= boundary * 0.95
    ) events.push(String(milestone));
  }
  const covered = ranges.reduce((sum, [a, b]) => sum + b - a, 0);
  const observedPercent = Math.max(0, Math.min(100, Math.floor(covered / duration * 100)));
  if (
    sample.type === "ended" && sample.position >= duration - 0.25 && covered >= duration * 0.95 &&
    ranges.some(([a, b]) => a < duration - 0.25 && b >= duration - 0.25)
  ) {
    events.push("completed");
  }
  return {
    state: {
      ...state, sequence: sample.sequence, ranges, lastObservedAt: now,
      lastPosition: sample.type === "pause" ? null : sample.position,
    },
    events,
    observedPercent,
    duplicate: false,
  };
}
