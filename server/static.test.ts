import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { once } from "node:events";
import test from "node:test";
import { serveStatic } from "./static";

test("static serving returns JSON 404 for missing APIs and keeps app/page routes intact", async () => {
  const publicDir = await mkdtemp(path.join(os.tmpdir(), "aroma-static-test-"));
  await writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>app shell</title>");
  const app = express();
  app.get("/api/registered", (_req, res) => res.json({ ok: true }));
  serveStatic(app, publicDir);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const missingApi = await fetch(`http://127.0.0.1:${address.port}/api/missing`);
    assert.equal(missingApi.status, 404);
    assert.match(missingApi.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await missingApi.json(), { code: "api_route_not_found" });

    const root = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await root.text(), /app shell/);

    const registeredApi = await fetch(`http://127.0.0.1:${address.port}/api/registered`);
    assert.equal(registeredApi.status, 200);
    assert.deepEqual(await registeredApi.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    await rm(publicDir, { recursive: true, force: true });
  }
});
