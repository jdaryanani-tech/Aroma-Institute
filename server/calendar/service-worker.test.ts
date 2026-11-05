import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("admin and LEAP workers keep separate scopes and never cache private responses",()=>{
  const admin=readFileSync("client/public/admin-sw.js","utf8");
  const learn=readFileSync("client/public/learn/sw.js","utf8");
  const adminRegistration=readFileSync("client/src/crm/AdminInstallHelp.tsx","utf8");
  const learnRegistration=readFileSync("client/src/lms-ui/PwaInstallPrompt.tsx","utf8");
  for(const worker of [admin,learn]) {
    assert.match(worker,/addEventListener\(["']push["']/);
    assert.match(worker,/addEventListener\(["']notificationclick["']/);
    assert.match(worker,/respondWith\(fetch\(event\.request\)\)/);
    assert.doesNotMatch(worker,/caches\.open|cache\.put|respondWith\(caches/);
  }
  assert.match(adminRegistration,/register\(["']\/admin-sw\.js["'],\s*\{\s*scope:\s*["']\/admin["']/);
  assert.match(learnRegistration,/register\(["']\/learn\/sw\.js["'],\s*\{\s*scope:\s*["']\/learn\/["']/);
});
