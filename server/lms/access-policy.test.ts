import assert from "node:assert/strict";
import test from "node:test";
import {
  canDownloadLmsCertificate,
  canManageLmsCourse,
  chapterPrerequisitesAreMet,
  hasCourseResourceAccess,
  MAX_LMS_RESOURCE_BYTES,
  nextAssessmentAttemptNumber,
  redeemLockedSingleUseInvitation,
  validateLmsResource,
} from "./access-policy";

test("resource uploads accept valid PDF and UTF-8 text files", () => {
  assert.deepEqual(
    validateLmsResource("../../lesson-notes.pdf", "application/pdf", Buffer.from("%PDF-1.7")),
    {
      ok: true,
      fileName: "lesson-notes.pdf",
      contentType: "application/pdf",
      extension: ".pdf",
    },
  );
  assert.equal(
    validateLmsResource("notes.txt", "text/plain; charset=utf-8", Buffer.from("Lesson notes")).ok,
    true,
  );
});

test("resource uploads reject oversized, mismatched, unsupported, and malformed files", () => {
  const oversized = validateLmsResource(
    "large.txt",
    "text/plain",
    Buffer.alloc(MAX_LMS_RESOURCE_BYTES + 1, "a"),
  );
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.message, /10 MB/);
  assert.equal(validateLmsResource("notes.pdf", "text/plain", Buffer.from("notes")).ok, false);
  assert.equal(validateLmsResource("notes.exe", "application/octet-stream", Buffer.from("x")).ok, false);
  assert.equal(validateLmsResource("fake.pdf", "application/pdf", Buffer.from("not a pdf")).ok, false);
  assert.equal(validateLmsResource("invalid.txt", "text/plain", Buffer.from([0xc3, 0x28])).ok, false);
});

test("resource access requires an active student enrollment or a staff course assignment", () => {
  assert.equal(hasCourseResourceAccess(["student"], "student", true, false), true);
  assert.equal(hasCourseResourceAccess(["student"], "student", false, false), false);
  assert.equal(hasCourseResourceAccess(["trainer"], "staff", false, true), true);
  assert.equal(hasCourseResourceAccess(["trainer"], "staff", false, false), false);
  assert.equal(hasCourseResourceAccess(["admin"], "staff", false, false), true);
  assert.equal(hasCourseResourceAccess(["student"], "staff", true, false), false);
});

test("trainer management is isolated to assigned courses while admins can manage all courses", () => {
  assert.equal(canManageLmsCourse(["trainer"], true), true);
  assert.equal(canManageLmsCourse(["trainer"], false), false);
  assert.equal(canManageLmsCourse(["student"], true), false);
  assert.equal(canManageLmsCourse(["admin"], false), true);
});

test("later chapters stay locked until prior lessons and assessments are complete", () => {
  const requirements = [
    { requiredLessonIds: [11, 12], assessmentId: 21 },
    { requiredLessonIds: [13], assessmentId: null },
  ];
  assert.equal(chapterPrerequisitesAreMet(requirements, new Set([11, 12, 13]), new Set([21])), true);
  assert.equal(chapterPrerequisitesAreMet(requirements, new Set([11, 13]), new Set([21])), false);
  assert.equal(chapterPrerequisitesAreMet(requirements, new Set([11, 12, 13]), new Set()), false);
});

test("assessment retries receive a new sequential attempt number", () => {
  assert.equal(nextAssessmentAttemptNumber(0), 1);
  assert.equal(nextAssessmentAttemptNumber(3), 4);
  assert.throws(() => nextAssessmentAttemptNumber(-1), RangeError);
});

test("certificate download is limited to approved records and their student or an admin", () => {
  const approvedForStudent = {
    roles: ["student"],
    userId: 4,
    studentId: 4,
    status: "approved",
    hasCertificateNumber: true,
    hasIssueDate: true,
    hasStudentName: true,
  };
  assert.equal(canDownloadLmsCertificate(approvedForStudent), true);
  assert.equal(canDownloadLmsCertificate({ ...approvedForStudent, studentId: 5 }), false);
  assert.equal(canDownloadLmsCertificate({ ...approvedForStudent, status: "pending_review" }), false);
  assert.equal(canDownloadLmsCertificate({ ...approvedForStudent, roles: ["trainer"] }), false);
  assert.equal(
    canDownloadLmsCertificate({ ...approvedForStudent, roles: ["admin"], studentId: 5 }),
    true,
  );
});

test("concurrent invitation redemption allows only one use of a single-use code", async () => {
  const invitation = { usesCount: 0, maxUses: 1 };
  let lockTail = Promise.resolve();
  let releaseCurrentLock: (() => void) | undefined;
  const loadInvitationForUpdate = async () => {
    let release!: () => void;
    const previous = lockTail;
    lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    releaseCurrentLock = release;
    return { ...invitation };
  };
  const releaseLock = () => releaseCurrentLock?.();
  const redeem = async () => {
    await Promise.resolve();
    invitation.usesCount += 1;
    return "enrolled";
  };

  const results = await Promise.all([
    redeemLockedSingleUseInvitation(loadInvitationForUpdate, redeem, undefined, releaseLock),
    redeemLockedSingleUseInvitation(loadInvitationForUpdate, redeem, undefined, releaseLock),
  ]);
  assert.equal(results.filter((result) => "result" in result).length, 1);
  assert.equal(results.filter((result) => "error" in result && result.status === 409).length, 1);
  assert.equal(invitation.usesCount, 1);
});
