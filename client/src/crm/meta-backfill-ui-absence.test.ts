import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const adminPage = readFileSync(resolve(root, "client/src/pages/Admin.tsx"), "utf8");
const adminStyles = readFileSync(resolve(root, "client/src/crm/admin.css"), "utf8");

test("Admissions Workspace does not mount or advertise historical Meta import", () => {
  assert.doesNotMatch(adminPage, /MetaHistoricalBackfill|Historical Meta Lead Import|meta-backfill/i);
  assert.equal(existsSync(resolve(root, "client/src/crm/MetaHistoricalBackfill.tsx")), false);
  assert.doesNotMatch(adminStyles, /\.crm-meta-backfill/);
});
