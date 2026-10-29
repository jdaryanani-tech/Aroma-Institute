import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createVslPlaybackTracker } from "./analytics";

type UmamiWindow = Window & {
  umami?: {
    track(name: string, data?: Record<string, string | number | boolean>): void;
  };
};

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

test("VSL start fires only on the first play, including pause and resume cycles", () => {
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 390,
      umami: {
        track: (name: string, data?: Record<string, unknown>) => {
          events.push({ name, data });
        },
      },
    } as UmamiWindow,
  });

  const tracker = createVslPlaybackTracker();
  tracker.onPlay();
  // Pausing has no analytics handler; resuming emits another play event.
  tracker.onPlay();

  assert.deepEqual(events, [
    {
      name: "vsl_video_started",
      data: {
        video: "aroma_training",
        page: "vsl",
        device_category: "mobile",
      },
    },
  ]);
});

test("VSL completion fires on playback end with only the expected properties", () => {
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1280,
      umami: {
        track: (name: string, data?: Record<string, unknown>) => {
          events.push({ name, data });
        },
      },
    } as UmamiWindow,
  });

  const tracker = createVslPlaybackTracker();
  tracker.onEnded();
  tracker.onEnded();

  assert.deepEqual(events, [
    {
      name: "vsl_video_completed",
      data: {
        video: "aroma_training",
        page: "vsl",
        device_category: "desktop",
      },
    },
  ]);
});

test("VSL progress events fire once when playback naturally crosses each milestone", () => {
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1280,
      umami: {
        track: (name: string, data?: Record<string, unknown>) => {
          events.push({ name, data });
        },
      },
    } as UmamiWindow,
  });

  const tracker = createVslPlaybackTracker();
  tracker.onPlay(0);
  tracker.onTimeUpdate(20, 100, false);
  tracker.onTimeUpdate(26, 100, false);
  tracker.onTimeUpdate(52, 100, false);
  tracker.onTimeUpdate(78, 100, false);
  tracker.onTimeUpdate(92, 100, false);
  tracker.onTimeUpdate(100, 100, false);

  assert.deepEqual(
    events.filter((event) => event.name === "vsl_video_progress"),
    [25, 50, 75, 90].map((percent) => ({
      name: "vsl_video_progress",
      data: {
        video: "aroma_training",
        page: "vsl",
        progress_percent: percent,
        device_category: "desktop",
      },
    })),
  );
});

test("VSL seeks and replays do not emit duplicate or skipped milestones", () => {
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1280,
      umami: {
        track: (name: string, data?: Record<string, unknown>) => {
          events.push({ name, data });
        },
      },
    } as UmamiWindow,
  });

  const tracker = createVslPlaybackTracker();
  tracker.onPlay(0);
  tracker.onTimeUpdate(26, 100, false);
  tracker.onTimeUpdate(80, 100, true);
  tracker.onSeeked(80);
  tracker.onTimeUpdate(81, 100, false);
  tracker.onSeeked(0);
  tracker.onPlay(0);
  tracker.onTimeUpdate(26, 100, false);
  tracker.onTimeUpdate(52, 100, false);

  assert.deepEqual(
    events.filter((event) => event.name === "vsl_video_progress"),
    [25, 50].map((percent) => ({
      name: "vsl_video_progress",
      data: {
        video: "aroma_training",
        page: "vsl",
        progress_percent: percent,
        device_category: "desktop",
      },
    })),
  );
});
