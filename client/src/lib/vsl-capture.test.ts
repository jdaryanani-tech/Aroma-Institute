import test from "node:test";
import assert from "node:assert/strict";
import { createDurableVslTracker } from "./vsl-capture";

test("durable capture uses only a server-issued playback id, ordered observations, and same-id retries", async () => {
  const calls: { url: string; body: any }[] = [];
  const statuses: string[] = [];
  let rejectedOnce = false;
  const tracker = createDurableVslTracker(status => statuses.push(status), async (url, body) => {
    calls.push({ url, body });
    if (url.endsWith("/playbacks")) return { ok: true, status: 201, json: async () => ({ playbackId: "server-issued" }) };
    if (!rejectedOnce) { rejectedOnce = true; throw new Error("temporary_network_failure"); }
    return { ok: true, status: 200, json: async () => ({ saved: true }) };
  });
  tracker.observe("play", 0, 100);
  tracker.observe("seek", 60, 100);
  tracker.observe("ended", 100, 100);
  await tracker.flush();
  const observations = calls.filter(call => call.url.endsWith("/events"));
  assert.equal(observations.length, 4);
  assert.deepEqual(observations[0].body, observations[1].body);
  assert.deepEqual(observations.map(call => call.body.sequence), [1, 1, 2, 3]);
  assert.ok(observations.every(call => !("leadId" in call.body)));
  assert.equal(statuses.at(-1), "saved");
});
test("unregistered direct viewers keep watching without sending unassociated events", async () => {
  const statuses: string[] = [];
  let requests = 0;
  const tracker = createDurableVslTracker(status => statuses.push(status), async () => {
    requests++;
    return { ok: false, status: 401, json: async () => ({}) };
  });
  tracker.observe("play", 0, 100);
  tracker.observe("ended", 100, 100);
  await tracker.flush();
  assert.equal(requests, 1);
  assert.equal(statuses.at(-1), "unlinked");
});
