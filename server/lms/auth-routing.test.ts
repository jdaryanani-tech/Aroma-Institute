import assert from "node:assert/strict";
import { test } from "node:test";
import { getLmsPostLoginPath } from "../../shared/lms-auth-routing";

test("login destinations respect student, trainer, and admin roles", () => {
  assert.equal(getLmsPostLoginPath(["student"]), "/learn/dashboard");
  assert.equal(getLmsPostLoginPath(["trainer"]), "/trainer");
  assert.equal(getLmsPostLoginPath(["admin"]), "/lms-admin");
  assert.equal(getLmsPostLoginPath(["trainer", "student"]), "/learn/dashboard");
  assert.equal(getLmsPostLoginPath(["student", "admin"]), "/lms-admin");
});
