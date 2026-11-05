import test from "node:test";
import assert from "node:assert/strict";
import { observePlayback, type PlaybackState, type PlaybackSample } from "./playback";
import { normalizeIndianMobile } from "../../shared/indian-mobile";

function initial(): PlaybackState {
  return { lastPosition: null, lastObservedAt: null, duration: 100, ranges: [], sequence: 0 };
}
test("Indian mobiles canonicalize consistently; invalid/non-Indian input is rejected", () => {
  for (const value of ["9000000001", "+91 90000 00001", "919000000001", " (90000)-00001 "]) {
    assert.equal(normalizeIndianMobile(value), "919000000001");
  }
  for (const value of ["1234567890", "+1 9000000001", "abc9000000001", "900000001", "++919000000001"]) {
    assert.equal(normalizeIndianMobile(value), null);
  }
});
test("only observed coverage emits milestones, and an ended observation is necessary for completion", () => {
  let state = initial();
  let clock = 0;
  const seen = new Set<string>();
  const observe = (type: PlaybackSample["type"], position: number) => {
    clock += 4000;
    const result = observePlayback(state, { type, position, duration: 100, sequence: state.sequence + 1 }, new Date(clock));
    state = result.state;
    for (const event of result.events) seen.add(event);
  };
  observe("play", 0);
  for (let pos = 4; pos <= 100; pos += 4) observe("sample", pos);
  assert.deepEqual(Array.from(seen), ["started", "25", "50", "75", "90"]);
  observe("ended", 100);
  assert.ok(seen.has("completed"));
  const duplicate = observePlayback(state, { type: "ended", position: 100, duration: 100, sequence: state.sequence }, new Date(clock));
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.events, []);
});
test("seeking to the end, a large jump, or elapsed time alone never implies watched/completed", () => {
  let state = observePlayback(initial(), { type: "play", position: 0, duration: 100, sequence: 1 }, new Date(0)).state;
  state = observePlayback(state, { type: "seek", position: 96, duration: 100, sequence: 2 }, new Date(999999)).state;
  const result = observePlayback(state, { type: "ended", position: 100, duration: 100, sequence: 3 }, new Date(1003999));
  assert.deepEqual(result.events, []);
  const jump = observePlayback(state, { type: "sample", position: 100, duration: 100, sequence: 3 }, new Date(1000000));
  assert.deepEqual(jump.state.ranges, []);
});
test("pause/resume does not count the paused interval; invalid sequences/durations fail", () => {
  let state = observePlayback(initial(), { type: "play", position: 0, duration: 100, sequence: 1 }, new Date(0)).state;
  state = observePlayback(state, { type: "pause", position: 4, duration: 100, sequence: 2 }, new Date(4000)).state;
  state = observePlayback(state, { type: "play", position: 80, duration: 100, sequence: 3 }, new Date(999999)).state;
  assert.deepEqual(state.ranges, [[0, 4]]);
  assert.throws(() => observePlayback(state, { type: "sample", position: 84, duration: 100, sequence: 5 }, new Date(1003999)), /out_of_order/);
  assert.throws(() => observePlayback(state, { type: "ended", position: 10, duration: 10, sequence: 4 }, new Date(1003999)), /invalid_media_duration/);
});
test("a short seek over a threshold never emits the skipped milestone, even with 95% prefix coverage", () => {
  const state: PlaybackState = { lastPosition: 24, lastObservedAt: new Date(24000), duration: 100, ranges: [[0, 24]], sequence: 6 };
  const seek = observePlayback(state, { type: "seek", position: 26, duration: 100, sequence: 7 }, new Date(25000));
  assert.deepEqual(seek.events, []);
  const afterSeek = observePlayback(seek.state, { type: "sample", position: 30, duration: 100, sequence: 8 }, new Date(29000));
  assert.deepEqual(afterSeek.events, []);
  const nearEnd: PlaybackState = { lastPosition: 96, lastObservedAt: new Date(96000), duration: 100, ranges: [[0, 96]], sequence: 24 };
  const skipEnd = observePlayback(nearEnd, { type: "seek", position: 100, duration: 100, sequence: 25 }, new Date(97000));
  assert.deepEqual(observePlayback(skipEnd.state, { type: "ended", position: 100, duration: 100, sequence: 26 }, new Date(98000)).events, []);
});
