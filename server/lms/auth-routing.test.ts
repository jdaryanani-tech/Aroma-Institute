import assert from "node:assert/strict";
import { test } from "node:test";
import { getAdminLoginDestination, getLmsPostLoginPath } from "../../shared/lms-auth-routing";

test("login destinations respect student, trainer, and admin roles", () => {
  assert.equal(getLmsPostLoginPath(["student"]), "/learn/dashboard");
  assert.equal(getLmsPostLoginPath(["trainer"]), "/trainer");
  assert.equal(getLmsPostLoginPath(["admin"]), "/lms-admin");
  assert.equal(getLmsPostLoginPath(["trainer", "student"]), "/learn/dashboard");
  assert.equal(getLmsPostLoginPath(["student", "admin"]), "/lms-admin");
});

test("the dedicated leads login returns only admins to the Leads Dashboard", () => {
  assert.equal(getAdminLoginDestination(["admin"]), "/admin");
  assert.equal(getAdminLoginDestination(["admin", "student"]), "/admin");
  assert.equal(getAdminLoginDestination(["student"]), null);
  assert.equal(getAdminLoginDestination(["trainer"]), null);
});
