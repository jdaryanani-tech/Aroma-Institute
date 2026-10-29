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
      data: { video: "aroma_training", page: "vsl" },
    },
  ]);
});

test("VSL completion fires on playback end with only the expected properties", () => {
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
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
      data: { video: "aroma_training", page: "vsl" },
    },
  ]);
});
