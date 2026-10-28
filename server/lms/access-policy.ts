import type { LmsRole } from "./auth";

export const MAX_LMS_RESOURCE_BYTES = 10 * 1024 * 1024;

const resourceTypes = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
} as const;

export type LmsResourceType = keyof typeof resourceTypes;

export type ResourceValidation =
  | { ok: true; fileName: string; contentType: string; extension: LmsResourceType }
  | { ok: false; message: string };

export function validateLmsResource(
  fileName: string,
  contentType: string,
  contents: Buffer,
): ResourceValidation {
  if (contents.byteLength === 0) return { ok: false, message: "The selected file is empty." };
  if (contents.byteLength > MAX_LMS_RESOURCE_BYTES) {
    return { ok: false, message: "Files must be 10 MB or smaller." };
  }

  const safeFileName = fileName
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  if (!safeFileName) return { ok: false, message: "Enter a valid file name." };

  const extension = safeFileName.slice(safeFileName.lastIndexOf(".")).toLowerCase();
  if (!(extension in resourceTypes)) {
    return { ok: false, message: "Only PDF and plain text files are allowed." };
  }

  const expectedType = resourceTypes[extension as LmsResourceType];
  const declaredType = contentType.split(";")[0].trim().toLowerCase();
  if (declaredType !== expectedType) {
    return { ok: false, message: "The file type does not match its extension." };
  }

  if (extension === ".pdf" && !contents.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return { ok: false, message: "This file is not a valid PDF." };
  }
  if (extension === ".txt") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      return { ok: false, message: "Text files must use UTF-8 encoding." };
    }
    if (contents.includes(0)) return { ok: false, message: "Text files cannot contain binary data." };
  }

  return {
    ok: true,
    fileName: safeFileName,
    contentType: expectedType,
    extension: extension as LmsResourceType,
  };
}

export function hasCourseResourceAccess(
  roles: readonly LmsRole[],
  mode: "student" | "staff",
  isActivelyEnrolled: boolean,
  isAssignedTrainer: boolean,
) {
  if (mode === "student") return roles.includes("student") && isActivelyEnrolled;
  return roles.includes("admin") || (roles.includes("trainer") && isAssignedTrainer);
}

export function canManageLmsCourse(roles: readonly string[], isAssignedTrainer: boolean) {
  return roles.includes("admin") || (roles.includes("trainer") && isAssignedTrainer);
}

export function chapterPrerequisitesAreMet(
  prerequisites: Array<{ requiredLessonIds: number[]; assessmentId: number | null }>,
  completedLessonIds: ReadonlySet<number>,
  passedAssessmentIds: ReadonlySet<number>,
) {
  return prerequisites.every(({ requiredLessonIds, assessmentId }) =>
    requiredLessonIds.every((lessonId) => completedLessonIds.has(lessonId)) &&
    (assessmentId === null || passedAssessmentIds.has(assessmentId)),
  );
}

export function nextAssessmentAttemptNumber(previousAttemptCount: number) {
  if (!Number.isSafeInteger(previousAttemptCount) || previousAttemptCount < 0) {
    throw new RangeError("Previous attempt count must be a non-negative integer.");
  }
  return previousAttemptCount + 1;
}

export function canDownloadLmsCertificate(input: {
  roles: readonly string[];
  userId: number;
  studentId: number;
  status: string;
  hasCertificateNumber: boolean;
  hasIssueDate: boolean;
  hasStudentName: boolean;
}) {
  return (
    (input.roles.includes("admin") || (input.roles.includes("student") && input.studentId === input.userId)) &&
    input.status === "approved" &&
    input.hasCertificateNumber &&
    input.hasIssueDate &&
    input.hasStudentName
  );
}

export async function redeemLockedSingleUseInvitation<TInvitation extends { usesCount: number; maxUses: number }, TResult>(
  loadInvitationForUpdate: () => Promise<TInvitation | null>,
  redeem: (invitation: TInvitation) => Promise<TResult>,
  validate?: (invitation: TInvitation) => { error: string; status: number } | null,
  releaseLock?: () => void,
) {
  try {
    const invitation = await loadInvitationForUpdate();
    if (!invitation) return { error: "This invitation code is invalid or revoked.", status: 404 };
    const validationError = validate?.(invitation);
    if (validationError) return validationError;
    if (invitation.usesCount >= invitation.maxUses) {
      return { error: "This invitation code has already been used.", status: 409 };
    }
    return { result: await redeem(invitation) };
  } finally {
    releaseLock?.();
  }
}
