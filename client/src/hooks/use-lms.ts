import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type LmsRole = "student" | "trainer" | "admin";

export interface LmsUser {
  id: number;
  phoneE164: string;
  displayName: string | null;
  roles: LmsRole[];
}

export interface LmsAuthStatus {
  available: boolean;
  channel: string;
  message: string;
}

export interface StudentCourseSummary {
  enrollmentId: number;
  courseId: number;
  title: string;
  description: string;
  enrolledAt: string;
  completedLessons: number;
  totalLessons: number;
  progressPercent: number;
  continueLesson: { id: number; title: string } | null;
}

export interface StudentDashboard {
  student: { name: string | null };
  courses: StudentCourseSummary[];
  upcomingSessions: {
    id: number;
    title: string;
    topic: string;
    startsAt: string;
    endsAt: string | null;
    meetUrl: string;
    courseTitle: string;
  }[];
}

export interface StudentCertificate {
  enrollmentId: number;
  certificateId: number | null;
  courseTitle: string;
  status: "not_eligible" | "eligible" | "pending_review" | "approved" | "rejected";
  certificateNumber: string | null;
  issuedAt: string | null;
  reviewNote: string | null;
}

export interface AdminCertificate extends StudentCertificate {
  id: number;
  studentName: string | null;
  phoneE164: string;
}

export interface CourseOutline {
  course: { id: number; title: string; description: string };
  modules: {
    id: number;
    title: string;
    description: string;
    chapters: {
      id: number;
      title: string;
      description: string;
      locked: boolean;
      lessons: {
        id: number;
        title: string;
        description: string;
        durationMinutes: number | null;
        requiredForAssessment: boolean;
        youtubeUrl: string | null;
        completed: boolean;
        locked: boolean;
      }[];
    }[];
  }[];
}

export interface AssessmentData {
  assessment: {
    id: number;
    title: string;
    instructions: string;
    passingPercent: number;
    questionCount: number;
  };
  questions: {
    id: number;
    prompt: string;
    options: { id: number; label: string }[];
  }[];
  attempts: number;
  passed: boolean;
  attemptHistory: {
    attemptNumber: number;
    scorePercent: number;
    passed: boolean;
    submittedAt: string;
  }[];
}

export interface LmsCourse {
  id: number;
  slug: string;
  title: string;
  description: string;
  status: "draft" | "published" | "archived";
  createdAt?: string;
  updatedAt?: string;
}

export interface LmsInvitation {
  id: number;
  codeHint: string;
  courseId: number;
  courseTitle: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  maxUses: number;
  usesCount: number;
  reservedForPhone: string | null;
  createdAt: string;
}

export interface LmsAdminUser {
  id: number;
  phoneE164: string;
  displayName: string | null;
  isActive: boolean;
  hasPassword: boolean;
  roles: LmsRole[];
}

export async function requestJson<T>(method: string, url: string, data?: unknown): Promise<T> {
  const response = await apiRequest(method, url, data);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function optionalSession(): Promise<LmsUser | null> {
  const response = await fetch("/api/lms/auth/me", { credentials: "include" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Unable to check your sign-in status.");
  return response.json();
}

export function useLmsAuthStatus() {
  return useQuery<LmsAuthStatus>({
    queryKey: ["/api/lms/auth/status"],
    queryFn: () => requestJson("GET", "/api/lms/auth/status"),
    staleTime: 30_000,
  });
}

export function useLmsSession() {
  return useQuery<LmsUser | null>({
    queryKey: ["/api/lms/auth/me"],
    queryFn: optionalSession,
    staleTime: 30_000,
  });
}
export function useLmsPasswordLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { phone: string; password: string }) =>
      requestJson<LmsUser>("POST", "/api/lms/auth/password/login", input),
    onSuccess: (user) => queryClient.setQueryData(["/api/lms/auth/me"], user),
  });
}

export function useLmsPasswordSetup() {
  return useMutation({
    mutationFn: (input: { token: string; password: string }) =>
      requestJson<{ message: string }>("POST", "/api/lms/auth/password/setup", input),
  });
}

export function useLmsLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => requestJson<void>("POST", "/api/lms/auth/logout"),
    onSuccess: () => queryClient.clear(),
  });
}

export function useStudentDashboard(enabled = true) {
  return useQuery<StudentDashboard>({
    queryKey: ["/api/lms/student/dashboard"],
    queryFn: () => requestJson("GET", "/api/lms/student/dashboard"),
    enabled,
  });
}

export function useCourseOutline(courseId: number | null) {
  return useQuery<CourseOutline>({
    queryKey: ["/api/lms/student/courses", courseId, "outline"],
    queryFn: () => requestJson("GET", `/api/lms/student/courses/${courseId}/outline`),
    enabled: Number.isSafeInteger(courseId) && (courseId ?? 0) > 0,
  });
}

export function useMarkLessonComplete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { lessonId: number; completed: boolean }) =>
      requestJson<{ completed: boolean; updatedAt: string }>(
        "POST",
        `/api/lms/student/lessons/${input.lessonId}/progress`,
        { completed: input.completed },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lms/student"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lms/student/chapters"] });
    },
  });
}

export function useRedeemLmsInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      requestJson<{ enrollmentId: number; course: { id: number; title: string } }>(
        "POST",
        "/api/lms/invitations/redeem",
        { code },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lms/student"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lms/student/chapters"] });
    },
  });
}

export function useStudentAssessment(chapterId: number | null) {
  return useQuery<AssessmentData>({
    queryKey: ["/api/lms/student/chapters", chapterId, "assessment"],
    queryFn: () =>
      requestJson("GET", `/api/lms/student/chapters/${chapterId}/assessment`),
    enabled: Number.isSafeInteger(chapterId) && (chapterId ?? 0) > 0,
  });
}

export function useSubmitLmsAssessment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assessmentId: number; answers: Record<string, number> }) =>
      requestJson<{
        id: number;
        attemptNumber: number;
        scorePercent: number;
        passed: boolean;
        submittedAt: string;
        explanations: { questionId: number; explanation: string | null }[];
      }>("POST", `/api/lms/student/assessments/${input.assessmentId}/attempts`, {
        answers: input.answers,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lms/student"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lms/student/chapters"] });
    },
  });
}

export function useStudentLiveSessions(enabled = true) {
  return useQuery<StudentDashboard["upcomingSessions"]>({
    queryKey: ["/api/lms/student/live-sessions"],
    queryFn: () => requestJson("GET", "/api/lms/student/live-sessions"),
    enabled,
  });
}

export function useStudentCertificates(enabled = true) {
  return useQuery<StudentCertificate[]>({
    queryKey: ["/api/lms/student/certificates"],
    queryFn: () => requestJson("GET", "/api/lms/student/certificates"),
    enabled,
  });
}

export function useRequestCertificateReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enrollmentId: number) =>
      requestJson<{ status: StudentCertificate["status"] }>(
        "POST",
        `/api/lms/student/certificates/${enrollmentId}/request-review`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lms/student/certificates"] }),
  });
}

export function useAdminCertificates(enabled = true) {
  return useQuery<AdminCertificate[]>({
    queryKey: ["/api/lms/admin/certificates"],
    queryFn: () => requestJson("GET", "/api/lms/admin/certificates"),
    enabled,
  });
}

export function useReviewLmsCertificate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { certificateId: number; decision: "approved" | "rejected"; reviewNote?: string }) =>
      requestJson<{ id: number; status: AdminCertificate["status"]; certificateNumber: string | null; issuedAt: string | null }>(
        "POST",
        `/api/lms/admin/certificates/${input.certificateId}/review`,
        { decision: input.decision, reviewNote: input.reviewNote ?? "" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lms/student/certificates"] });
    },
  });
}

export function useTrainerCourses(enabled = true) {
  return useQuery<LmsCourse[]>({
    queryKey: ["/api/lms/trainer/courses"],
    queryFn: () => requestJson("GET", "/api/lms/trainer/courses"),
    enabled,
  });
}

export function useAdminOverview(enabled = true) {
  return useQuery<{
    students: number;
    trainers: number;
    courses: number;
    activeEnrollments: number;
    pendingCertificates: number;
  }>({
    queryKey: ["/api/lms/admin/overview"],
    queryFn: () => requestJson("GET", "/api/lms/admin/overview"),
    enabled,
  });
}

export function useAdminCourses(enabled = true) {
  return useQuery<LmsCourse[]>({
    queryKey: ["/api/lms/admin/courses"],
    queryFn: () => requestJson("GET", "/api/lms/admin/courses"),
    enabled,
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery<LmsAdminUser[]>({
    queryKey: ["/api/lms/admin/users"],
    queryFn: () => requestJson("GET", "/api/lms/admin/users"),
    enabled,
  });
}

export function useCreateLmsUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { phoneE164: string; displayName: string; role: "student" | "trainer" }) =>
      requestJson<{ id: number; phoneE164: string; displayName: string; role: "student" | "trainer" }>(
        "POST",
        "/api/lms/admin/users",
        input,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/overview"] });
    },
  });
}

export function useCreateLmsPasswordSetupLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) =>
      requestJson<{ setupPath: string; expiresAt: string }>(
        "POST",
        `/api/lms/admin/users/${userId}/password-setup`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/users"] }),
  });
}

export function useCreateLmsCourse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (course: { title: string; slug: string; description: string }) =>
      requestJson<LmsCourse>("POST", "/api/lms/admin/courses", course),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/courses"] }),
  });
}

export function useSetLmsCourseStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { courseId: number; status: LmsCourse["status"] }) =>
      requestJson<LmsCourse>(
        "PATCH",
        `/api/lms/admin/courses/${input.courseId}/status`,
        { status: input.status },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/courses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/overview"] });
    },
  });
}

export function useAdminInvitations(enabled = true) {
  return useQuery<LmsInvitation[]>({
    queryKey: ["/api/lms/admin/invitations"],
    queryFn: () => requestJson("GET", "/api/lms/admin/invitations"),
    enabled,
  });
}

export function useCreateLmsInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      courseId: number;
      expiresAt?: string | null;
      maxUses?: number;
      reservedForPhone?: string | null;
    }) => requestJson<{ id: number; code: string; message: string }>(
      "POST",
      "/api/lms/admin/invitations",
      input,
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/invitations"] }),
  });
}

export function useRevokeLmsInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: number) =>
      requestJson<{ revoked: boolean }>(
        "POST",
        `/api/lms/admin/invitations/${invitationId}/revoke`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lms/admin/invitations"] }),
  });
}
