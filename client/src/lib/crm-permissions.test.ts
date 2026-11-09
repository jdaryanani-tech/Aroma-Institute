import test from "node:test";
import assert from "node:assert/strict";
import { crmUiPermissions } from "../crm/permissions";

test("CRM UI gives administrators full controls and admissions scoped controls only", () => {
  const admin = crmUiPermissions(["admin"]);
  assert.equal(admin.canUseCrm, true);
  assert.equal(admin.canManageAssignments, true);
  assert.equal(admin.canSeeGlobalDiagnostics, true);
  assert.equal(admin.canRetryDelivery, true);
  assert.equal(admin.canSeeAssigneeControls, true);
  assert.equal(admin.manualStages, null);

  const admissions = crmUiPermissions(["admissions"]);
  assert.equal(admissions.canUseCrm, true);
  assert.equal(admissions.canManageAssignments, false);
  assert.equal(admissions.canSeeGlobalDiagnostics, false);
  assert.equal(admissions.canRetryDelivery, false);
  assert.equal(admissions.canSeeAssigneeControls, false);
  assert.deepEqual(admissions.manualStages, ["contacted", "qualified", "vsl_shared", "counselling_pending", "nurture", "lost"]);
});

test("CRM UI denies every non-CRM staff/student role and treats administrators as privileged", () => {
  for (const role of ["trainer", "student", "academic_coordinator", "operations"]) {
    assert.equal(crmUiPermissions([role]).canUseCrm, false);
  }
  const dualRole = crmUiPermissions(["admissions", "admin"]);
  assert.equal(dualRole.canUseCrm, true);
  assert.equal(dualRole.canManageAssignments, true);
  assert.equal(dualRole.manualStages, null);
});
