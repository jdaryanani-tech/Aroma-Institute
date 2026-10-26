import "./lms.css";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  ArrowDownRight, ArrowLeft, ArrowRight, Bell, BookOpen, CalendarDays, Check, CheckCircle2,
  CircleAlert, ClipboardCheck, Clock3, Coffee, FileBarChart2, GraduationCap, History,
  KeyRound, Layers3, LoaderCircle, LockKeyhole, LogOut, Plus, Send, ShieldAlert,
  UserRound, UserRoundCheck, UserRoundX, Users, X,
} from "lucide-react";
import {
  useAdminAuditLogs, useAdminCertificates, useAdminCourseReports, useAdminCourses, useAdminEnrollments, useAdminInvitations, useAdminOverview, useAdminTrainerAssignments, useAdminUsers, useAssignLmsTrainer, useCourseOutline, useCreateAdminEnrollment, useCreateLmsCourse,
  useCreateManagedLiveSession,
  useCreateLmsInvitation, useCreateLmsPasswordSetupLink, useCreateLmsUser, useLmsAuthStatus, useLmsLogout,
  useLmsNotifications, useMarkLmsNotificationRead, useManagedCourseStudents, useManagedLiveSessions,
  useRemoveLmsTrainerAssignment, useSendLmsCourseNotification, useSetAdminEnrollmentStatus,
  useSetManagedLiveSessionStatus, useUpdateLmsProfile,
  useLmsPasswordLogin, useLmsPasswordSetup, useLmsSession, useMarkLessonComplete,
  useRedeemLmsInvitation, useRevokeLmsInvitation, useSetLmsCourseStatus,
  useRequestCertificateReview, useStudentAssessment, useStudentCertificates, useStudentDashboard,
  useReviewLmsCertificate, useSubmitLmsAssessment, useTrainerCourses,
} from "@/hooks/use-lms";
import type { AdminEnrollment, CourseOutline, LmsCourse, LmsInvitation, LmsUser } from "@/hooks/use-lms";

type IconComponent = typeof Coffee;
function Icon({ icon: Symbol, size = 18 }: { icon: IconComponent; size?: number }) {
  return <Symbol size={size} strokeWidth={1.8} aria-hidden="true" />;
}
function BrandHeader({ user, onLogout }: { user?: LmsUser | null; onLogout?: () => void }) {
  return <header className="lms-header"><div className="lms-shell lms-header-inner">
    <Link href="/learn" className="lms-brand" aria-label="Aroma LEAP learning home">
      <span className="lms-mark">A</span><span><span className="lms-brand-name">Aroma LEAP</span><span className="lms-brand-sub">Learning space</span></span>
    </Link>
    <div className="lms-header-right">
      {user?.displayName && <span className="lms-user-chip">{user.displayName}</span>}
      {onLogout && <button className="lms-button lms-button-secondary lms-button-sm" onClick={onLogout}><Icon icon={LogOut} size={15} /> Sign out</button>}
    </div>
  </div></header>;
}
function PageFrame({ children, user, onLogout }: { children: ReactNode; user?: LmsUser | null; onLogout?: () => void }) {
  return <div className="lms"><BrandHeader user={user} onLogout={onLogout} /><main className="lms-shell lms-main lms-fade-in">{children}</main></div>;
}
function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="lms-alert lms-alert-error" role="alert"><Icon icon={CircleAlert} /><span>{message}<br /><button className="lms-switch" onClick={retry}>Try again</button></span></div>;
}
function LoadingRows({ count = 3 }: { count?: number }) {
  return <div className="lms-space" aria-label="Loading content" aria-busy="true">{Array.from({ length: count }, (_, i) => <div key={i} className="lms-skeleton" style={{ height: i === 0 ? 88 : 58 }} />)}</div>;
}
function EmptyState({ icon = BookOpen, title, detail, action }: { icon?: IconComponent; title: string; detail: string; action?: ReactNode }) {
  return <div className="lms-empty"><div className="lms-empty-mark"><Icon icon={icon} size={20} /></div><h3>{title}</h3><p className="lms-muted">{detail}</p>{action}</div>;
}
function useLogoutAction() {
  const logout = useLmsLogout();
  const [, setLocation] = useLocation();
  return () => logout.mutate(undefined, { onSuccess: () => setLocation("/learn") });
}
function formatDate(value: string, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, withTime ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", year: "numeric" }).format(date);
}
function niceError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
function ProfileNotifications({ user }: { user: LmsUser }) {
  const updateProfile = useUpdateLmsProfile();
  const notifications = useLmsNotifications(true);
  const markRead = useMarkLmsNotificationRead();
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [profileMessage, setProfileMessage] = useState("");
  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    setProfileMessage("");
    updateProfile.mutate(displayName.trim(), {
      onSuccess: profile => setProfileMessage(`Profile updated${profile.displayName ? ` for ${profile.displayName}` : ""}.`),
      onError: error => setProfileMessage(niceError(error, "Your profile could not be updated.")),
    });
  };
  return <section className="lms-grid lms-grid-2 lms-account-tools">
    <section className="lms-panel">
      <div className="lms-panel-head"><div><div className="lms-eyebrow">Your account</div><h2>Profile</h2></div><Icon icon={UserRound} /></div>
      <form onSubmit={saveProfile}>
        <div className="lms-field"><label htmlFor={`profile-name-${user.id}`}>Display name</label><input id={`profile-name-${user.id}`} className="lms-input" value={displayName} onChange={event => setDisplayName(event.target.value)} minLength={2} maxLength={180} required /></div>
        <div className="lms-field"><label>Phone number</label><div className="lms-input lms-readonly">{user.phoneE164}</div><span className="lms-help">Contact an administrator if this number needs to change.</span></div>
        {profileMessage && <div className={`lms-alert ${updateProfile.isError ? "lms-alert-error" : "lms-alert-success"}`} role="status" style={{ marginBottom: 12 }}>{profileMessage}</div>}
        <button className="lms-button lms-button-secondary" type="submit" disabled={updateProfile.isPending || displayName.trim().length < 2}>{updateProfile.isPending ? "Saving…" : "Save profile"}</button>
      </form>
    </section>
    <section className="lms-panel">
      <div className="lms-panel-head"><div><div className="lms-eyebrow">Updates</div><h2>Notifications</h2></div><span className="lms-tag">{notifications.data?.filter(item => !item.readAt).length ?? "—"} unread</span></div>
      {notifications.isLoading ? <LoadingRows count={2} /> : notifications.isError ? <ErrorState message={niceError(notifications.error, "Notifications could not be loaded.")} retry={() => void notifications.refetch()} /> : !notifications.data?.length ? <EmptyState icon={Bell} title="No notifications" detail="Course announcements and account updates will appear here." /> :
        <div className="lms-notification-list">{notifications.data.map(notification => <article className={`lms-notification ${notification.readAt ? "is-read" : ""}`} key={notification.id}>
          <div><strong>{notification.title}</strong><p>{notification.body}</p><span className="lms-help">{notification.category.replaceAll("_", " ")} · {formatDate(notification.createdAt, true)}</span></div>
          {!notification.readAt && <button className="lms-button lms-button-secondary lms-button-sm" onClick={() => markRead.mutate(notification.id)} disabled={markRead.isPending}>Mark read</button>}
        </article>)}</div>}
      {markRead.isError && <div className="lms-alert lms-alert-error" role="alert" style={{ marginTop: 12 }}>{niceError(markRead.error, "Notification could not be updated.")}</div>}
    </section>
  </section>;
}
function SessionGuard({ children, allow }: { children: (user: LmsUser) => ReactNode; allow: string }) {
  const session = useLmsSession();
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (!session.isLoading && !session.isError && !session.data) setLocation("/learn");
  }, [session.isLoading, session.isError, session.data, setLocation]);
  if (session.isLoading) return <div className="lms"><BrandHeader /><main className="lms-shell lms-main"><LoadingRows /></main></div>;
  if (session.isError) return <div className="lms"><BrandHeader /><main className="lms-shell lms-main"><ErrorState message={niceError(session.error, "We could not check your sign-in status.")} retry={() => void session.refetch()} /></main></div>;
  if (!session.data) {
    return <div className="lms"><BrandHeader /><main className="lms-shell lms-main"><p>Taking you to sign in…</p></main></div>;
  }
  if (!session.data.roles.includes(allow as LmsUser["roles"][number])) return <PageFrame user={session.data}><EmptyState icon={ShieldAlert} title="This space is not assigned to your account" detail="Ask your Aroma Institute coordinator if you need access to this area." /></PageFrame>;
  return <>{children(session.data)}</>;
}

export function LearnLoginPage() {
  const authStatus = useLmsAuthStatus();
  const session = useLmsSession();
  const login = useLmsPasswordLogin();
  const [, setLocation] = useLocation();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!session.data) return;
    const destination = session.data.roles.includes("admin") ? "/lms-admin" : session.data.roles.includes("trainer") && !session.data.roles.includes("student") ? "/trainer" : "/learn/dashboard";
    setLocation(destination);
  }, [session.data, setLocation]);
  const signIn = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    login.mutate({ phone: phone.trim(), password }, {
      onSuccess: (user) => setLocation(user.roles.includes("admin") ? "/lms-admin" : user.roles.includes("trainer") && !user.roles.includes("student") ? "/trainer" : "/learn/dashboard"),
      onError: (error) => setFormError(niceError(error, "Phone number or password is incorrect.")),
    });
  };
  return <div className="lms lms-auth-wrap">
    <aside className="lms-auth-aside">
      <Link href="/learn" className="lms-brand" style={{ color: "inherit" }}><span className="lms-mark" style={{ background: "#c49b57", color: "#37261a" }}>A</span><span><span className="lms-brand-name">Aroma LEAP</span><span className="lms-brand-sub" style={{ color: "rgba(255,247,233,.58)" }}>Learning space</span></span></Link>
      <div><div className="lms-eyebrow">Practice becomes profession</div><h1>Learn the craft.<br />Serve with care.</h1><p>Your training ground for the details that make hospitality memorable — from the first dial-in to the final guest goodbye.</p></div>
      <div className="lms-auth-caption">Aroma Institute · Café & Hospitality Management</div>
    </aside>
    <main className="lms-auth-main"><div className="lms-auth-form">
      <div className="lms-eyebrow">Student access</div>
      <h2>Welcome to your learning space</h2>
      <p>Sign in with the phone number on your Aroma LEAP account and your password.</p>
      {session.isError && <ErrorState message={niceError(session.error, "Unable to check sign-in status.")} retry={() => void session.refetch()} />}
      {authStatus.isError && <ErrorState message={niceError(authStatus.error, "Sign-in availability could not be checked.")} retry={() => void authStatus.refetch()} />}
      {!authStatus.isLoading && !authStatus.isError && !authStatus.data?.available &&
        <div className="lms-alert lms-alert-warning" role="status"><Icon icon={LockKeyhole} /><span>{authStatus.data?.message || "Password sign-in is currently unavailable. Contact your institute coordinator."}</span></div>}
      {formError && <div className="lms-alert lms-alert-error" role="alert">{formError}</div>}
      <form onSubmit={signIn}>
        <div className="lms-field"><label htmlFor="lms-phone">Phone number</label><input id="lms-phone" className="lms-input" type="tel" autoComplete="tel" placeholder="+91 98765 43210" value={phone} onChange={e => setPhone(e.target.value)} required /></div>
        <div className="lms-field"><label htmlFor="lms-password">Password</label><input id="lms-password" className="lms-input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
        <button className="lms-button" type="submit" disabled={!phone.trim() || !password || login.isPending || !authStatus.data?.available} style={{ width: "100%" }}>
          {login.isPending ? <><Icon icon={LoaderCircle} /> Signing in…</> : <>Sign in <Icon icon={ArrowRight} size={16} /></>}
        </button>
      </form>
      <p className="lms-help" style={{ marginTop: 16 }}>First time here or need a reset? Ask your institute coordinator for a one-time password setup link.</p>
      <div className="lms-footer-note">
        Student course access depends on your account's active enrolments.
      </div>
    </div></main>
  </div>;
}

export function PasswordSetupPage() {
  const setup = useLmsPasswordSetup();
  const [, setLocation] = useLocation();
  const [token] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
  });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [formError, setFormError] = useState("");
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    if (!token) {
      setFormError("This setup link is invalid or expired. Ask your institute coordinator for a new one.");
      return;
    }
    if (password !== confirmation) {
      setFormError("The passwords do not match.");
      return;
    }
    setup.mutate({ token, password }, {
      onSuccess: () => {
        setPassword("");
        setConfirmation("");
        setComplete(true);
      },
      onError: error => setFormError(niceError(error, "This setup link is invalid or expired.")),
    });
  };

  return <div className="lms lms-auth-wrap">
    <aside className="lms-auth-aside">
      <Link href="/learn" className="lms-brand" style={{ color: "inherit" }}><span className="lms-mark" style={{ background: "#c49b57", color: "#37261a" }}>A</span><span><span className="lms-brand-name">Aroma LEAP</span><span className="lms-brand-sub" style={{ color: "rgba(255,247,233,.58)" }}>Learning space</span></span></Link>
      <div><div className="lms-eyebrow">Secure account setup</div><h1>Set your password.<br />Start learning.</h1><p>Choose a private password for your Aroma LEAP account. Your password is stored securely as a one-way hash.</p></div>
      <div className="lms-auth-caption">Aroma Institute · Café & Hospitality Management</div>
    </aside>
    <main className="lms-auth-main"><div className="lms-auth-form">
      <div className="lms-eyebrow">One-time setup link</div>
      <h2>{complete ? "Your password is ready" : "Create your password"}</h2>
      {complete ? <>
        <div className="lms-alert lms-alert-success" role="status">Password set. You can now sign in to the learning space.</div>
        <Link className="lms-button" href="/learn" style={{ width: "100%", justifyContent: "center" }}>Continue to sign in <Icon icon={ArrowRight} size={16} /></Link>
      </> : <>
        <p>Use at least 12 characters. Don’t reuse a password from another account.</p>
        {!token && <div className="lms-alert lms-alert-warning" role="status"><Icon icon={LockKeyhole} /><span>This setup link is missing or invalid. Ask your institute coordinator for a fresh link.</span></div>}
        {formError && <div className="lms-alert lms-alert-error" role="alert">{formError}</div>}
        <form onSubmit={submit}>
          <div className="lms-field"><label htmlFor="lms-new-password">New password</label><input id="lms-new-password" className="lms-input" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} required /></div>
          <div className="lms-field"><label htmlFor="lms-confirm-password">Confirm password</label><input id="lms-confirm-password" className="lms-input" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></div>
          <button className="lms-button" type="submit" disabled={!token || setup.isPending || password.length < 12 || !confirmation} style={{ width: "100%" }}>{setup.isPending ? "Saving securely…" : "Set password"}</button>
        </form>
        <button className="lms-switch" type="button" onClick={() => setLocation("/learn")}>Back to sign in</button>
      </>}
    </div></main>
  </div>;
}

export function StudentDashboardPage() {
  return <SessionGuard allow="student">{user => <StudentDashboardContent user={user} />}</SessionGuard>;
}
function StudentDashboardContent({ user }: { user: LmsUser }) {
  const dashboard = useStudentDashboard(true);
  const certificates = useStudentCertificates(true);
  const requestCertificateReview = useRequestCertificateReview();
  const redeem = useRedeemLmsInvitation();
  const logout = useLogoutAction();
  const [invitationCode, setInvitationCode] = useState("");
  const [invitationMessage, setInvitationMessage] = useState("");
  const [certificateMessage, setCertificateMessage] = useState("");
  const redeemInvitation = (event: FormEvent) => {
    event.preventDefault();
    setInvitationMessage("");
    redeem.mutate(invitationCode.trim(), {
      onSuccess: (result) => {
        setInvitationCode("");
        setInvitationMessage(`Invitation accepted. You are enrolled in ${result.course.title}.`);
      },
      onError: (error) => setInvitationMessage(niceError(error, "This invitation could not be redeemed.")),
    });
  };
  if (dashboard.isLoading) return <div className="lms"><BrandHeader user={user} onLogout={logout} /><main className="lms-shell lms-main"><LoadingRows /></main></div>;
  if (dashboard.isError) return <PageFrame user={user} onLogout={logout}><ErrorState message={niceError(dashboard.error, "Your learning dashboard could not be loaded.")} retry={() => void dashboard.refetch()} /></PageFrame>;
  const data = dashboard.data!;
  const totalLessons = data.courses.reduce((sum, c) => sum + c.totalLessons, 0);
  const completed = data.courses.reduce((sum, c) => sum + c.completedLessons, 0);
  const sessions = [...data.upcomingSessions].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return <PageFrame user={user} onLogout={logout}>
    <div className="lms-page-head"><div><div className="lms-eyebrow">Your practice, in progress</div><h1>Good to have you here{data.student.name ? `, ${data.student.name.split(" ")[0]}` : ""}.</h1><p className="lms-subtitle">Pick up where you left off, and make space for your next session.</p></div><div className="lms-tag">Aroma LEAP / Student</div></div>
    <div className="lms-stat-grid">
      <div className="lms-stat"><span>Enrolled courses</span><strong>{data.courses.length}</strong><span>In your learning plan</span></div>
      <div className="lms-stat"><span>Lessons completed</span><strong>{completed}<small style={{ font: "14px 'DM Sans'", color: "var(--lms-muted)" }}> / {totalLessons}</small></strong><span>Across your courses</span></div>
      <div className="lms-stat"><span>Live sessions</span><strong>{sessions.length}</strong><span>Coming up</span></div>
      <div className="lms-stat"><span>Learning focus</span><strong style={{ fontSize: 21 }}>Hands-on</strong><span>Built for the floor</span></div>
    </div>
    <div className="lms-grid lms-grid-2">
      <section>
        <div className="lms-panel-head"><div><div className="lms-eyebrow">Your courses</div><h2>Keep your momentum</h2></div></div>
        {data.courses.length ? <div className="lms-grid lms-grid-courses">{data.courses.map(course => <article key={course.enrollmentId} className="lms-panel lms-course-card">
          <div className="lms-course-band" /><div className="lms-course-body">
            <div className="lms-course-meta"><span className="lms-tag">Course</span><span className="lms-muted" style={{ fontSize: 11 }}>{course.completedLessons}/{course.totalLessons} lessons</span></div>
            <h3>{course.title}</h3><p className="lms-muted" style={{ fontSize: 13, minHeight: 42 }}>{course.description}</p>
            <div className="lms-progress" role="progressbar" aria-label={`${course.title} progress`} aria-valuenow={course.progressPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, Math.max(0, course.progressPercent))}%` }} /></div>
            <div className="lms-progress-row"><span>{course.progressPercent}% complete</span><span>{course.continueLesson ? "Next lesson ready" : "Course outline"}</span></div>
            <Link className="lms-course-link" href={`/learn/courses/${course.courseId}`}>{course.continueLesson ? `Continue: ${course.continueLesson.title}` : "Open course"} <Icon icon={ArrowRight} size={14} /></Link>
          </div>
        </article>)}</div> : <div className="lms-panel"><EmptyState title="Your course list is waiting" detail="Enter the invitation code from your coordinator to enrol in a course." icon={GraduationCap} />
          <form onSubmit={redeemInvitation} style={{ maxWidth: 480, margin: "0 auto" }}>
            <div className="lms-field"><label htmlFor="student-invitation">Invitation code</label><input id="student-invitation" className="lms-input lms-mono" autoComplete="off" value={invitationCode} onChange={event => setInvitationCode(event.target.value)} required /></div>
            {invitationMessage && <div className={`lms-alert ${redeem.isSuccess ? "lms-alert-success" : "lms-alert-error"}`} role="status" style={{ marginBottom: 14 }}>{invitationMessage}</div>}
            <button className="lms-button" type="submit" disabled={!invitationCode.trim() || redeem.isPending}>{redeem.isPending ? "Checking invitation…" : "Redeem invitation"} <Icon icon={KeyRound} size={15} /></button>
          </form>
        </div>}
      </section>
      <aside className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">On the calendar</div><h2>Upcoming sessions</h2></div><Icon icon={CalendarDays} /></div>
        {sessions.length ? sessions.map(session => {
          const dt = new Date(session.startsAt);
          return <article className="lms-session" key={session.id}><div className="lms-date-block"><b>{Number.isNaN(dt.getTime()) ? "—" : dt.getDate()}</b><span>{Number.isNaN(dt.getTime()) ? "TBC" : new Intl.DateTimeFormat(undefined, { month: "short" }).format(dt)}</span></div><div><div className="lms-session-title">{session.title}</div><div className="lms-session-detail">{session.topic} · {formatDate(session.startsAt, true)}</div><div className="lms-session-detail">{session.courseTitle}</div>{session.meetUrl && <a className="lms-course-link" href={session.meetUrl} target="_blank" rel="noreferrer" style={{ marginTop: 7 }}>Open session <Icon icon={ArrowDownRight} size={13} /></a>}</div></article>;
        }) : <EmptyState icon={CalendarDays} title="No sessions scheduled" detail="Your trainer's upcoming live sessions will show here." />}
      </aside>
    </div>
    <ProfileNotifications user={user} />
    <section className="lms-panel lms-certificate-panel">
      <div className="lms-panel-head"><div><div className="lms-eyebrow">Course completion</div><h2>Certificates</h2></div><Icon icon={GraduationCap} /></div>
      {certificates.isLoading ? <LoadingRows count={2} /> : certificates.isError ? <ErrorState message={niceError(certificates.error, "Certificate status could not be loaded.")} retry={() => void certificates.refetch()} /> : !certificates.data?.length ? <EmptyState icon={GraduationCap} title="No certificate records yet" detail="Certificate status will appear after you enrol in a course." /> :
        <div className="lms-certificate-list">{certificates.data.map(certificate => <article className="lms-certificate-row" key={certificate.enrollmentId}>
          <div><strong>{certificate.courseTitle}</strong><div className="lms-help">{certificate.status.replaceAll("_", " ")}</div>{certificate.reviewNote && <div className="lms-help">{certificate.reviewNote}</div>}{certificate.certificateNumber && <div className="lms-help lms-mono">{certificate.certificateNumber}</div>}</div>
          <div className="lms-row">
            {certificate.status === "eligible" && <button className="lms-button lms-button-secondary lms-button-sm" disabled={requestCertificateReview.isPending} onClick={() => { setCertificateMessage(""); requestCertificateReview.mutate(certificate.enrollmentId, { onSuccess: () => setCertificateMessage("Your certificate is now waiting for administrator review."), onError: error => setCertificateMessage(niceError(error, "The review request could not be submitted.")) }); }}>Request review</button>}
            {certificate.status === "approved" && certificate.certificateId && <a className="lms-button lms-button-sm" href={`/api/lms/certificates/${certificate.certificateId}/pdf`}>Download PDF <Icon icon={ArrowDownRight} size={14} /></a>}
          </div>
        </article>)}</div>}
      {certificateMessage && <div className={`lms-alert ${requestCertificateReview.isError ? "lms-alert-error" : "lms-alert-success"}`} role="status" style={{ marginTop: 14 }}>{certificateMessage}</div>}
      {requestCertificateReview.isError && !certificateMessage && <div className="lms-alert lms-alert-error" role="alert" style={{ marginTop: 14 }}>{niceError(requestCertificateReview.error, "The review request could not be submitted.")}</div>}
    </section>
  </PageFrame>;
}

function getYoutubeEmbed(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    let id = "";
    if (parsed.hostname === "youtu.be" || parsed.hostname === "www.youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] || "";
    else if (parsed.hostname === "youtube.com" || parsed.hostname === "www.youtube.com" || parsed.hostname === "m.youtube.com") {
      if (parsed.pathname === "/watch") id = parsed.searchParams.get("v") || "";
      else if (/^\/(embed|shorts)\/[A-Za-z0-9_-]+/.test(parsed.pathname)) id = parsed.pathname.split("/")[2] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  } catch { return null; }
}
type Lesson = CourseOutline["modules"][number]["chapters"][number]["lessons"][number];
function allLessons(outline: CourseOutline): Lesson[] {
  return outline.modules.flatMap(module => module.chapters.flatMap(chapter => chapter.lessons));
}
export function CoursePage() {
  return <SessionGuard allow="student">{user => <CoursePageContent user={user} />}</SessionGuard>;
}

function CoursePageContent({ user }: { user: LmsUser }) {
  const params = useParams<{ courseId: string }>();
  const id = Number(params.courseId);
  const outlineQuery = useCourseOutline(Number.isSafeInteger(id) && id > 0 ? id : null);
  const mark = useMarkLessonComplete();
  const [assessmentChapterId, setAssessmentChapterId] = useState<number | null>(null);
  const assessmentQuery = useStudentAssessment(assessmentChapterId);
  const assessmentSubmit = useSubmitLmsAssessment();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [latestAttempt, setLatestAttempt] = useState<{
    scorePercent: number;
    passed: boolean;
    attemptNumber: number;
    explanations: { questionId: number; explanation: string | null }[];
  } | null>(null);
  const logout = useLogoutAction();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  if (!Number.isSafeInteger(id) || id <= 0) return <PageFrame><ErrorState message="This course address is not valid." retry={() => window.history.back()} /></PageFrame>;
  if (outlineQuery.isLoading) return <div className="lms"><BrandHeader user={user} onLogout={logout} /><main className="lms-shell lms-main"><LoadingRows count={4} /></main></div>;
  if (outlineQuery.isError) return <PageFrame user={user} onLogout={logout}><ErrorState message={niceError(outlineQuery.error, "The course outline could not be loaded.")} retry={() => void outlineQuery.refetch()} /></PageFrame>;
  const outline = outlineQuery.data!;
  const lessons = allLessons(outline);
  const availableLessons = lessons.filter(item => !item.locked);
  const selected = availableLessons.find(item => item.id === selectedId) || availableLessons.find(item => !item.completed) || availableLessons[0] || lessons[0] || null;
  const video = selected ? getYoutubeEmbed(selected.youtubeUrl) : null;
  const done = lessons.filter(item => item.completed).length;
  const toggleComplete = (lesson: Lesson) => mark.mutate({ lessonId: lesson.id, completed: !lesson.completed });
  const submitAssessment = (event: FormEvent) => {
    event.preventDefault();
    const assessment = assessmentQuery.data?.assessment;
    if (!assessment) return;
    assessmentSubmit.mutate({ assessmentId: assessment.id, answers }, {
      onSuccess: result => setLatestAttempt(result),
    });
  };
  const openAssessment = (chapterId: number) => {
    setAssessmentChapterId(chapterId);
    setAnswers({});
    setLatestAttempt(null);
  };
  return <PageFrame user={user} onLogout={logout}>
    <div className="lms-page-head"><div><Link href="/learn/dashboard" className="lms-course-link" style={{ marginBottom: 12 }}><Icon icon={ArrowLeft} size={14} /> Back to learning</Link><div className="lms-eyebrow">Course workspace</div><h1>{outline.course.title}</h1><p className="lms-subtitle">{outline.course.description}</p></div><span className="lms-tag">{done} / {lessons.length} lessons complete</span></div>
    {outline.modules.length === 0 || lessons.length === 0 ? <EmptyState title="Course content is being prepared" detail="Your trainer will add the learning outline here." /> :
      <div className="lms-course-layout">
        <section className="lms-panel">
          {selected ? <><div className="lms-panel-head"><div><div className="lms-eyebrow">Now learning</div><h2>{selected.title}</h2></div>{selected.durationMinutes && <span className="lms-tag"><Icon icon={Clock3} size={12} /> {selected.durationMinutes} min</span>}</div>
            {video ? <div className="lms-video"><iframe title={`Video lesson: ${selected.title}`} src={video} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen /></div> :
              <div className="lms-empty" style={{ marginBottom: 18 }}><div className="lms-empty-mark"><Icon icon={BookOpen} /></div><h3>Lesson materials</h3><p className="lms-muted">{selected.youtubeUrl ? "The lesson video link is not a valid secure YouTube URL." : "There is no video attached to this lesson. Use the lesson notes below and mark your practice when complete."}</p></div>}
            {selected.description && <p style={{ marginTop: 18, color: "var(--lms-muted)" }}>{selected.description}</p>}
            {selected.requiredForAssessment && <p className="lms-help">Required for assessment</p>}
            <button className={`lms-button ${selected.completed ? "lms-button-secondary" : ""}`} onClick={() => toggleComplete(selected)} disabled={mark.isPending || selected.locked} aria-pressed={selected.completed}>
              {selected.locked ? <><Icon icon={LockKeyhole} /> Locked</> : mark.isPending ? "Saving progress…" : selected.completed ? <><Icon icon={CheckCircle2} /> Completed — mark as incomplete</> : <><Icon icon={Check} /> Mark lesson complete</>}
            </button>
            {mark.isError && <p className="lms-help" role="alert">{niceError(mark.error, "Progress could not be saved.")}</p>}
          </> : <EmptyState title="No lessons yet" detail="This course outline has no lessons to display." />}
        </section>
        <aside className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Course outline</div><h2>Lessons</h2></div><span className="lms-tag">{done}/{lessons.length}</span></div>
          <div className="lms-lesson-list">{outline.modules.map(module => <div key={module.id} className="lms-module"><div className="lms-module-title"><span>{module.title}</span><span className="lms-muted">{module.chapters.reduce((n, c) => n + c.lessons.length, 0)}</span></div>{module.chapters.map(chapter => <div key={chapter.id} style={{ marginBottom: 9 }}><div className="lms-chapter-row"><div className="lms-overline">{chapter.title}{chapter.locked && <span className="lms-muted"> · Locked</span>}</div><button type="button" className="lms-text-button" disabled={chapter.locked} onClick={() => openAssessment(chapter.id)}><Icon icon={ClipboardCheck} size={13} /> Assessment</button></div>{chapter.lessons.map(lesson => <div key={lesson.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button type="button" className="lms-lesson" aria-current={selected?.id === lesson.id ? "true" : undefined} onClick={() => setSelectedId(lesson.id)} disabled={lesson.locked}><span className={`lms-check ${lesson.completed ? "is-done" : ""}`}>{lesson.locked ? <Icon icon={LockKeyhole} size={11} /> : lesson.completed && <Icon icon={Check} size={11} />}</span><span><span className="lms-lesson-name">{lesson.title}</span><span className="lms-lesson-time">{lesson.locked ? "Complete previous chapter requirements to unlock" : `${lesson.durationMinutes ? `${lesson.durationMinutes} min` : "Lesson"}${lesson.requiredForAssessment ? " · Assessment required" : ""}`}</span></span></button>
            <button className="lms-icon-button" type="button" aria-label={`${lesson.completed ? "Mark incomplete" : "Mark complete"}: ${lesson.title}`} title={lesson.completed ? "Mark incomplete" : "Mark complete"} disabled={mark.isPending || lesson.locked} onClick={() => toggleComplete(lesson)} style={{ width: 30, height: 30, flex: "none" }}><Icon icon={lesson.locked ? LockKeyhole : lesson.completed ? CheckCircle2 : Check} size={14} /></button>
          </div>)}</div>)}</div>)}</div>
        </aside>
      </div>}
      {assessmentChapterId !== null && <section className="lms-panel lms-assessment-panel">
        <div className="lms-panel-head"><div><div className="lms-eyebrow">Chapter assessment</div><h2>{assessmentQuery.data?.assessment.title ?? "Assessment"}</h2></div><button className="lms-button lms-button-secondary lms-button-sm" onClick={() => setAssessmentChapterId(null)}>Close</button></div>
        {assessmentQuery.isLoading ? <LoadingRows count={3} /> : assessmentQuery.isError ? <ErrorState message={niceError(assessmentQuery.error, "This assessment could not be loaded.")} retry={() => void assessmentQuery.refetch()} /> : assessmentQuery.data && <>
          <p className="lms-muted">{assessmentQuery.data.assessment.instructions || "Choose one answer for each question. You need 100% to pass, and you can retry as often as needed."}</p>
          <div className="lms-assessment-summary"><span>{assessmentQuery.data.assessment.questionCount} questions</span><span>{assessmentQuery.data.attempts} attempts</span><span>{assessmentQuery.data.passed ? "Passed" : "Not passed yet"}</span></div>
          {assessmentQuery.data.attemptHistory.length > 0 && <div className="lms-attempt-history"><strong>Recent attempts</strong>{assessmentQuery.data.attemptHistory.map(attempt => <div key={attempt.attemptNumber} className="lms-attempt-row"><span>Attempt {attempt.attemptNumber} · {formatDate(attempt.submittedAt, true)}</span><span className={attempt.passed ? "lms-result-pass" : "lms-result-fail"}>{attempt.scorePercent}% · {attempt.passed ? "Passed" : "Not passed"}</span></div>)}</div>}
          <form onSubmit={submitAssessment} className="lms-assessment-form">
            {assessmentQuery.data.questions.map((question, index) => <fieldset key={question.id} className="lms-question">
              <legend><span className="lms-question-number">{index + 1}</span>{question.prompt}</legend>
              <div className="lms-option-list">{question.options.map(option => <label key={option.id} className={`lms-assessment-option ${answers[String(question.id)] === option.id ? "is-selected" : ""}`}>
                <input type="radio" name={`question-${question.id}`} checked={answers[String(question.id)] === option.id} onChange={() => setAnswers(current => ({ ...current, [String(question.id)]: option.id }))} />
                <span>{option.label}</span>
              </label>)}</div>
            </fieldset>)}
            {latestAttempt && <div className={`lms-alert ${latestAttempt.passed ? "lms-alert-success" : "lms-alert-warning"}`} role="status">
              <Icon icon={latestAttempt.passed ? CheckCircle2 : CircleAlert} />
              <span><strong>{latestAttempt.passed ? "Passed — 100%." : `Not passed — ${latestAttempt.scorePercent}%.`}</strong> Attempt {latestAttempt.attemptNumber}. {latestAttempt.passed ? "This chapter requirement is complete." : "You can review the material and try again."}</span>
            </div>}
            {latestAttempt && latestAttempt.explanations.length > 0 && <div className="lms-explanations"><strong>Review notes</strong>{latestAttempt.explanations.filter(item => item.explanation).map(item => <p key={item.questionId}>{item.explanation}</p>)}</div>}
            {assessmentSubmit.isError && <div className="lms-alert lms-alert-error" role="alert">{niceError(assessmentSubmit.error, "Your answers could not be submitted.")}</div>}
            <button className="lms-button" type="submit" disabled={assessmentSubmit.isPending || Object.keys(answers).length !== assessmentQuery.data.questions.length}>
              {assessmentSubmit.isPending ? "Submitting…" : latestAttempt ? "Try again" : "Submit answers"} <Icon icon={ArrowRight} size={15} />
            </button>
          </form>
        </>}
      </section>}
  </PageFrame>;
}

export function TrainerPage() {
  return <SessionGuard allow="trainer">{user => <TrainerContent user={user} />}</SessionGuard>;
}
function TrainerContent({ user }: { user: LmsUser }) {
  const courses = useTrainerCourses(true);
  const logout = useLogoutAction();
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(null);
  const students = useManagedCourseStudents(selectedCourseId);
  const sessions = useManagedLiveSessions(selectedCourseId);
  const createSession = useCreateManagedLiveSession();
  const setSessionStatus = useSetManagedLiveSessionStatus();
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionTopic, setSessionTopic] = useState("");
  const [sessionUrl, setSessionUrl] = useState("");
  const [sessionStart, setSessionStart] = useState("");
  const [sessionEnd, setSessionEnd] = useState("");
  const [sessionMessage, setSessionMessage] = useState("");
  useEffect(() => {
    if (selectedCourseId === null && courses.data?.length) setSelectedCourseId(courses.data[0].id);
    else if (selectedCourseId !== null && courses.data && !courses.data.some(course => course.id === selectedCourseId)) {
      setSelectedCourseId(courses.data[0]?.id ?? null);
    }
  }, [courses.data, selectedCourseId]);
  if (courses.isLoading) return <div className="lms"><BrandHeader user={user} onLogout={logout} /><main className="lms-shell lms-main"><LoadingRows /></main></div>;
  const submitSession = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedCourseId) return;
    setSessionMessage("");
    createSession.mutate({
      courseId: selectedCourseId,
      title: sessionTitle.trim(),
      topic: sessionTopic.trim(),
      meetUrl: sessionUrl.trim(),
      startsAt: new Date(sessionStart).toISOString(),
      ...(sessionEnd ? { endsAt: new Date(sessionEnd).toISOString() } : {}),
    }, {
      onSuccess: () => {
        setSessionTitle(""); setSessionTopic(""); setSessionUrl(""); setSessionStart(""); setSessionEnd("");
        setSessionMessage("Live session scheduled. Enrolled students can now see it.");
      },
      onError: error => setSessionMessage(niceError(error, "Live session could not be scheduled.")),
    });
  };
  return <PageFrame user={user} onLogout={logout}>
    <div className="lms-page-head"><div><div className="lms-eyebrow">Trainer workspace</div><h1>Teaching, with intention.</h1><p className="lms-subtitle">Review learner progress and schedule sessions for your assigned courses.</p></div><span className="lms-tag">Trainer</span></div>
    {courses.isError ? <ErrorState message={niceError(courses.error, "Assigned courses could not be loaded.")} retry={() => void courses.refetch()} /> :
      courses.data?.length ? <div className="lms-grid lms-grid-courses">{courses.data.map(course => <TrainerCourseCard key={course.id} course={course} />)}</div> :
      <EmptyState icon={GraduationCap} title="No courses assigned yet" detail="When the institute assigns a course to you, it will appear here." />}
    {courses.data?.length ? <>
      <section className="lms-panel lms-trainer-operations">
        <div className="lms-panel-head"><div><div className="lms-eyebrow">Learner progress</div><h2>Course roster</h2><p className="lms-help">Only learners enrolled in a course assigned to your account are shown.</p></div>
          <select className="lms-select lms-course-picker" aria-label="Choose assigned course" value={selectedCourseId ?? ""} onChange={event => setSelectedCourseId(Number(event.target.value))}>{courses.data.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select>
        </div>
        {students.isLoading ? <LoadingRows count={2} /> : students.isError ? <ErrorState message={niceError(students.error, "The learner roster could not be loaded.")} retry={() => void students.refetch()} /> : !students.data?.length ? <EmptyState icon={Users} title="No enrolled learners yet" detail="Student progress will appear when learners enrol in this course." /> :
          <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>Student</th><th>Enrolled</th><th>Status</th><th>Progress</th></tr></thead><tbody>{students.data.map(student => <tr key={student.enrollmentId}>
            <td><strong>{student.displayName || "Name not provided"}</strong><div className="lms-help">{student.phoneE164}</div></td><td>{formatDate(student.enrolledAt)}</td><td><span className={`lms-status lms-status-${student.enrollmentStatus}`}>{student.enrollmentStatus}</span></td><td><strong>{student.progressPercent}%</strong><div className="lms-help">{student.completedLessons} of {student.totalLessons} published lessons</div></td>
          </tr>)}</tbody></table></div>}
      </section>
      <section className="lms-grid lms-grid-2 lms-trainer-operations">
        <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Live learning</div><h2>Schedule a session</h2></div><Icon icon={CalendarDays} /></div>
          <form onSubmit={submitSession}>
            <div className="lms-field"><label htmlFor="trainer-session-title">Session title</label><input id="trainer-session-title" className="lms-input" value={sessionTitle} onChange={event => setSessionTitle(event.target.value)} maxLength={180} required /></div>
            <div className="lms-field"><label htmlFor="trainer-session-topic">Topic</label><textarea id="trainer-session-topic" className="lms-textarea" value={sessionTopic} onChange={event => setSessionTopic(event.target.value)} maxLength={2000} /></div>
            <div className="lms-field"><label htmlFor="trainer-session-url">Google Meet link</label><input id="trainer-session-url" type="url" className="lms-input" placeholder="https://meet.google.com/..." value={sessionUrl} onChange={event => setSessionUrl(event.target.value)} required /></div>
            <div className="lms-grid lms-grid-2"><div className="lms-field"><label htmlFor="trainer-session-start">Starts</label><input id="trainer-session-start" type="datetime-local" className="lms-input" value={sessionStart} onChange={event => setSessionStart(event.target.value)} required /></div><div className="lms-field"><label htmlFor="trainer-session-end">Ends (optional)</label><input id="trainer-session-end" type="datetime-local" className="lms-input" value={sessionEnd} onChange={event => setSessionEnd(event.target.value)} /></div></div>
            {sessionMessage && <div className={`lms-alert ${createSession.isError ? "lms-alert-error" : "lms-alert-success"}`} role="status" style={{ marginBottom: 12 }}>{sessionMessage}</div>}
            <button className="lms-button" type="submit" disabled={createSession.isPending}>{createSession.isPending ? "Scheduling…" : "Schedule live session"}</button>
          </form>
        </section>
        <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Course calendar</div><h2>Manage sessions</h2></div><Icon icon={CalendarDays} /></div>
          {sessions.isLoading ? <LoadingRows count={2} /> : sessions.isError ? <ErrorState message={niceError(sessions.error, "Live sessions could not be loaded.")} retry={() => void sessions.refetch()} /> : !sessions.data?.length ? <EmptyState icon={CalendarDays} title="No sessions scheduled" detail="Schedule the first live session for this course." /> :
            <div className="lms-managed-sessions">{sessions.data.map(session => <article key={session.id} className="lms-managed-session">
              <div><strong>{session.title}</strong><div className="lms-help">{session.topic || "No topic details"} · {formatDate(session.startsAt, true)}</div><a href={session.meetUrl} target="_blank" rel="noreferrer" className="lms-course-link">Open Meet link <Icon icon={ArrowDownRight} size={13} /></a></div>
              <div className="lms-session-actions"><span className={`lms-status lms-status-${session.status}`}>{session.status}</span>{session.status === "scheduled" && <><button className="lms-button lms-button-secondary lms-button-sm" disabled={setSessionStatus.isPending} onClick={() => setSessionStatus.mutate({ sessionId: session.id, courseId: session.courseId, status: "completed" })}>Complete</button><button className="lms-button lms-button-danger lms-button-sm" disabled={setSessionStatus.isPending} onClick={() => setSessionStatus.mutate({ sessionId: session.id, courseId: session.courseId, status: "cancelled" })}>Cancel</button></>}</div>
            </article>)}</div>}
          {setSessionStatus.isError && <div className="lms-alert lms-alert-error" role="alert" style={{ marginTop: 12 }}>{niceError(setSessionStatus.error, "Session status could not be updated.")}</div>}
        </section>
      </section>
    </> : null}
    <ProfileNotifications user={user} />
  </PageFrame>;
}
function TrainerCourseCard({ course }: { course: LmsCourse }) {
  return <article className="lms-panel lms-course-card"><div className="lms-course-band" /><div className="lms-course-body"><div className="lms-course-meta"><span className={`lms-status lms-status-${course.status}`}>{course.status}</span><span className="lms-mono lms-muted" style={{ fontSize: 11 }}>{course.slug}</span></div><h3>{course.title}</h3><p className="lms-muted">{course.description}</p><Link className="lms-button lms-button-secondary lms-button-sm" href={`/manage/courses/${course.id}`}>Manage course outline <Icon icon={ArrowRight} size={14} /></Link></div></article>;
}

function AdminOperations({ courses, users }: { courses: LmsCourse[]; users: ReturnType<typeof useAdminUsers>["data"] }) {
  const assignments = useAdminTrainerAssignments(true);
  const enrollments = useAdminEnrollments(true);
  const reports = useAdminCourseReports(true);
  const auditLogs = useAdminAuditLogs(true);
  const assignTrainer = useAssignLmsTrainer();
  const removeAssignment = useRemoveLmsTrainerAssignment();
  const createEnrollment = useCreateAdminEnrollment();
  const setEnrollmentStatus = useSetAdminEnrollmentStatus();
  const sendNotification = useSendLmsCourseNotification();
  const trainers = (users ?? []).filter(account => account.isActive && account.roles.includes("trainer"));
  const students = (users ?? []).filter(account => account.isActive && account.roles.includes("student"));
  const [trainerId, setTrainerId] = useState("");
  const [assignmentCourseId, setAssignmentCourseId] = useState("");
  const [enrollmentStudentId, setEnrollmentStudentId] = useState("");
  const [enrollmentCourseId, setEnrollmentCourseId] = useState("");
  const [announcementCourseId, setAnnouncementCourseId] = useState("");
  const [announcementTitle, setAnnouncementTitle] = useState("");
  const [announcementBody, setAnnouncementBody] = useState("");
  const [feedback, setFeedback] = useState("");
  const submitAssignment = (event: FormEvent) => {
    event.preventDefault();
    setFeedback("");
    assignTrainer.mutate({ trainerId: Number(trainerId), courseId: Number(assignmentCourseId) }, {
      onSuccess: () => setFeedback("Trainer assigned to the course."),
      onError: error => setFeedback(niceError(error, "Trainer assignment could not be saved.")),
    });
  };
  const submitEnrollment = (event: FormEvent) => {
    event.preventDefault();
    setFeedback("");
    createEnrollment.mutate({ studentId: Number(enrollmentStudentId), courseId: Number(enrollmentCourseId) }, {
      onSuccess: () => setFeedback("Student enrolled in the course."),
      onError: error => setFeedback(niceError(error, "Student could not be enrolled.")),
    });
  };
  const submitAnnouncement = (event: FormEvent) => {
    event.preventDefault();
    setFeedback("");
    sendNotification.mutate({ courseId: Number(announcementCourseId), title: announcementTitle.trim(), body: announcementBody.trim() }, {
      onSuccess: result => {
        setFeedback(`Notification sent to ${result.sent} enrolled ${result.sent === 1 ? "student" : "students"} in ${result.courseTitle}.`);
        setAnnouncementTitle(""); setAnnouncementBody("");
      },
      onError: error => setFeedback(niceError(error, "Notification could not be sent.")),
    });
  };
  const onStatusChange = (enrollment: AdminEnrollment, status: AdminEnrollment["status"]) => {
    if (status === enrollment.status) return;
    setFeedback("");
    setEnrollmentStatus.mutate({ enrollmentId: enrollment.id, status }, {
      onSuccess: () => setFeedback("Enrolment status updated."),
      onError: error => setFeedback(niceError(error, "Enrolment status could not be updated.")),
    });
  };
  return <>
    {feedback && <div className={`lms-alert ${assignTrainer.isError || createEnrollment.isError || sendNotification.isError || setEnrollmentStatus.isError ? "lms-alert-error" : "lms-alert-success"}`} role="status" style={{ marginBottom: 16 }}>{feedback}</div>}
    <div className="lms-grid lms-grid-2">
      <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Teaching teams</div><h2>Trainer assignments</h2></div><Icon icon={UserRoundCheck} /></div>
        <form className="lms-grid lms-grid-2 lms-compact-form" onSubmit={submitAssignment}>
          <div className="lms-field"><label htmlFor="assignment-trainer">Trainer</label><select id="assignment-trainer" className="lms-select" value={trainerId} onChange={event => setTrainerId(event.target.value)} required><option value="">Choose trainer</option>{trainers.map(trainer => <option key={trainer.id} value={trainer.id}>{trainer.displayName || trainer.phoneE164}</option>)}</select></div>
          <div className="lms-field"><label htmlFor="assignment-course">Course</label><select id="assignment-course" className="lms-select" value={assignmentCourseId} onChange={event => setAssignmentCourseId(event.target.value)} required><option value="">Choose course</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></div>
          <div><button className="lms-button" type="submit" disabled={!trainers.length || !courses.length || assignTrainer.isPending}>{assignTrainer.isPending ? "Assigning…" : "Assign trainer"}</button></div>
        </form>
        {assignments.isLoading ? <LoadingRows count={2} /> : assignments.isError ? <ErrorState message={niceError(assignments.error, "Trainer assignments could not be loaded.")} retry={() => void assignments.refetch()} /> : !assignments.data?.length ? <EmptyState icon={UserRoundX} title="No course assignments yet" detail="Assign a trainer to a course to let them manage its learning space." /> :
          <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>Trainer</th><th>Course</th><th></th></tr></thead><tbody>{assignments.data.map(assignment => <tr key={assignment.id}><td><strong>{assignment.trainerName || "Trainer"}</strong><div className="lms-help">{assignment.trainerPhone}</div></td><td>{assignment.courseTitle}</td><td><button className="lms-button lms-button-danger lms-button-sm" disabled={removeAssignment.isPending} onClick={() => { if (window.confirm(`Remove ${assignment.trainerName || "this trainer"} from ${assignment.courseTitle}?`)) removeAssignment.mutate(assignment.id); }}>Remove</button></td></tr>)}</tbody></table></div>}
        {removeAssignment.isError && <div className="lms-alert lms-alert-error" role="alert">{niceError(removeAssignment.error, "Trainer assignment could not be removed.")}</div>}
      </section>
      <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Learner access</div><h2>Manage enrolments</h2></div><Icon icon={Users} /></div>
        <form className="lms-grid lms-grid-2 lms-compact-form" onSubmit={submitEnrollment}>
          <div className="lms-field"><label htmlFor="enrol-student">Student</label><select id="enrol-student" className="lms-select" value={enrollmentStudentId} onChange={event => setEnrollmentStudentId(event.target.value)} required><option value="">Choose student</option>{students.map(student => <option key={student.id} value={student.id}>{student.displayName || student.phoneE164}</option>)}</select></div>
          <div className="lms-field"><label htmlFor="enrol-course">Course</label><select id="enrol-course" className="lms-select" value={enrollmentCourseId} onChange={event => setEnrollmentCourseId(event.target.value)} required><option value="">Choose course</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></div>
          <div><button className="lms-button" type="submit" disabled={!students.length || !courses.length || createEnrollment.isPending}>{createEnrollment.isPending ? "Enrolling…" : "Enrol student"}</button></div>
        </form>
        {enrollments.isLoading ? <LoadingRows count={2} /> : enrollments.isError ? <ErrorState message={niceError(enrollments.error, "Enrolments could not be loaded.")} retry={() => void enrollments.refetch()} /> : !enrollments.data?.length ? <EmptyState icon={GraduationCap} title="No enrolments yet" detail="Enrol an existing student into a course above." /> :
          <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>Student</th><th>Course</th><th>Status</th><th>Enrolled</th></tr></thead><tbody>{enrollments.data.map(enrollment => <tr key={enrollment.id}><td><strong>{enrollment.studentName || "Student"}</strong><div className="lms-help">{enrollment.studentPhone}</div></td><td>{enrollment.courseTitle}</td><td><select aria-label={`Status for ${enrollment.studentName || "student"} in ${enrollment.courseTitle}`} className="lms-select lms-status-select" value={enrollment.status} onChange={event => onStatusChange(enrollment, event.target.value as AdminEnrollment["status"])} disabled={setEnrollmentStatus.isPending}>{["active", "completed", "suspended", "withdrawn"].map(status => <option key={status} value={status}>{status}</option>)}</select></td><td>{formatDate(enrollment.enrolledAt)}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
    <div className="lms-grid lms-grid-2 lms-admin-secondary">
      <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Course updates</div><h2>Send notification</h2><p className="lms-help">Only active students enrolled in the selected course will receive this message.</p></div><Icon icon={Send} /></div>
        <form onSubmit={submitAnnouncement}>
          <div className="lms-field"><label htmlFor="announcement-course">Course</label><select id="announcement-course" className="lms-select" value={announcementCourseId} onChange={event => setAnnouncementCourseId(event.target.value)} required><option value="">Choose course</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></div>
          <div className="lms-field"><label htmlFor="announcement-title">Title</label><input id="announcement-title" className="lms-input" value={announcementTitle} onChange={event => setAnnouncementTitle(event.target.value)} maxLength={180} required /></div>
          <div className="lms-field"><label htmlFor="announcement-body">Message</label><textarea id="announcement-body" className="lms-textarea" value={announcementBody} onChange={event => setAnnouncementBody(event.target.value)} maxLength={2000} required /></div>
          <button className="lms-button" type="submit" disabled={sendNotification.isPending || !courses.length}>{sendNotification.isPending ? "Sending…" : "Send to enrolled students"}</button>
        </form>
      </section>
      <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Institute overview</div><h2>Course reports</h2></div><Icon icon={FileBarChart2} /></div>
        {reports.isLoading ? <LoadingRows count={2} /> : reports.isError ? <ErrorState message={niceError(reports.error, "Course reports could not be loaded.")} retry={() => void reports.refetch()} /> : !reports.data?.length ? <EmptyState icon={FileBarChart2} title="No course data yet" detail="Reports will show up as courses and enrolments are added." /> :
          <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>Course</th><th>Enrolled</th><th>Completed</th><th>Live sessions</th></tr></thead><tbody>{reports.data.map(report => <tr key={report.id}><td><strong>{report.title}</strong><div className="lms-help">{report.status} · {report.publishedLessons} published lessons</div></td><td>{report.activeEnrollments} active <div className="lms-help">{report.enrollments} total</div></td><td>{report.completedEnrollments}</td><td>{report.scheduledSessions} scheduled <div className="lms-help">{report.liveSessions} total</div></td></tr>)}</tbody></table></div>}
      </section>
    </div>
    <section className="lms-panel lms-audit-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Accountability</div><h2>Audit log</h2><p className="lms-help">Recent administrative and learning-management changes.</p></div><Icon icon={History} /></div>
      {auditLogs.isLoading ? <LoadingRows count={2} /> : auditLogs.isError ? <ErrorState message={niceError(auditLogs.error, "Audit history could not be loaded.")} retry={() => void auditLogs.refetch()} /> : !auditLogs.data?.length ? <EmptyState icon={History} title="No audit events yet" detail="Administrative actions will be recorded here." /> :
        <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th></tr></thead><tbody>{auditLogs.data.map(log => <tr key={log.id}><td>{formatDate(log.createdAt, true)}</td><td>{log.actorName || "System"}</td><td><span className="lms-mono">{log.action}</span></td><td>{log.entityType} {log.entityId ? `#${log.entityId}` : ""}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

export function AdminPage() {
  return <SessionGuard allow="admin">{user => <AdminContent user={user} />}</SessionGuard>;
}
function AdminContent({ user }: { user: LmsUser }) {
  const overview = useAdminOverview(true);
  const courses = useAdminCourses(true);
  const invitations = useAdminInvitations(true);
  const adminUsers = useAdminUsers(true);
  const certificateReviews = useAdminCertificates(true);
  const createCourse = useCreateLmsCourse();
  const createUser = useCreateLmsUser();
  const createPasswordSetupLink = useCreateLmsPasswordSetupLink();
  const setStatus = useSetLmsCourseStatus();
  const createInvitation = useCreateLmsInvitation();
  const revokeInvitation = useRevokeLmsInvitation();
  const reviewCertificate = useReviewLmsCertificate();
  const logout = useLogoutAction();
  const [courseDialog, setCourseDialog] = useState(false);
  const [inviteDialog, setInviteDialog] = useState(false);
  const [newCourse, setNewCourse] = useState<LmsCourse | null>(null);
  const [oneTimeCode, setOneTimeCode] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState("");
  const [courseError, setCourseError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [setupLink, setSetupLink] = useState<{ setupPath: string; expiresAt: string; userName: string } | null>(null);
  const [accountName, setAccountName] = useState("");
  const [accountPhone, setAccountPhone] = useState("");
  const [accountRole, setAccountRole] = useState<"student" | "trainer">("student");
  const [inviteCourseId, setInviteCourseId] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteUses, setInviteUses] = useState("1");
  const [inviteExpiry, setInviteExpiry] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [certificateReviewNote, setCertificateReviewNote] = useState("");
  const [certificateReviewMessage, setCertificateReviewMessage] = useState("");
  const stats = overview.data;
  const listedCourses = courses.data ?? [];
  const activeCourses = listedCourses.filter(c => c.status === "published");

  const submitCourse = (event: FormEvent) => {
    event.preventDefault(); setCourseError("");
    createCourse.mutate({ title: title.trim(), slug: slug.trim(), description: description.trim() }, {
      onSuccess: course => { setNewCourse(course); setTitle(""); setSlug(""); setDescription(""); },
      onError: error => setCourseError(niceError(error, "Course could not be created.")),
    });
  };
  const submitInvite = (event: FormEvent) => {
    event.preventDefault(); setInviteError("");
    createInvitation.mutate({
      courseId: Number(inviteCourseId),
      maxUses: Number(inviteUses),
      ...(invitePhone.trim() ? { reservedForPhone: invitePhone.trim() } : {}),
      ...(inviteExpiry ? { expiresAt: new Date(inviteExpiry).toISOString() } : {}),
    }, { onSuccess: result => { setOneTimeCode(result.code); setInviteDialog(false); setInvitePhone(""); setInviteUses("1"); setInviteExpiry(""); }, onError: error => setInviteError(niceError(error, "Invitation could not be created.")) });
  };
  const changeStatus = (course: LmsCourse) => {
    const status = course.status === "published" ? "archived" : "published";
    setStatus.mutate({ courseId: course.id, status });
  };
  const revoke = (invitation: LmsInvitation) => {
    if (invitation.status === "active" && window.confirm(`Revoke invitation ending ${invitation.codeHint}? Students will no longer be able to redeem it.`)) revokeInvitation.mutate(invitation.id);
  };
  const decideCertificate = (certificateId: number, decision: "approved" | "rejected") => {
    const action = decision === "approved" ? "approve and issue this certificate" : "reject this certificate";
    if (!window.confirm(`Are you sure you want to ${action}?`)) return;
    setCertificateReviewMessage("");
    reviewCertificate.mutate(
      { certificateId, decision, reviewNote: certificateReviewNote },
      {
        onSuccess: () => {
          setCertificateReviewNote("");
          setCertificateReviewMessage(decision === "approved" ? "Certificate approved and issued." : "Certificate review was rejected.");
        },
        onError: error => setCertificateReviewMessage(niceError(error, "Certificate review could not be saved.")),
      },
    );
  };
  const submitAccount = (event: FormEvent) => {
    event.preventDefault();
    setAccountError("");
    setAccountMessage("");
    createUser.mutate(
      { displayName: accountName.trim(), phoneE164: accountPhone.trim(), role: accountRole },
      {
        onSuccess: () => {
          setAccountName("");
          setAccountPhone("");
          setAccountRole("student");
          setAccountMessage("Account saved. Create a one-time password setup link below.");
        },
        onError: error => setAccountError(niceError(error, "Account could not be saved.")),
      },
    );
  };
  const issuePasswordLink = (userId: number, userName: string | null) => {
    setAccountError("");
    createPasswordSetupLink.mutate(userId, {
      onSuccess: result => setSetupLink({ ...result, userName: userName || "LEAP user" }),
      onError: error => setAccountError(niceError(error, "Password setup link could not be created.")),
    });
  };
  return <PageFrame user={user} onLogout={logout}>
    <div className="lms-page-head"><div><div className="lms-eyebrow">Institute operations</div><h1>Learning, at a glance.</h1><p className="lms-subtitle">Manage accounts, course access, trainer assignments, learning sessions, and institute reports.</p></div><div className="lms-row"><button className="lms-button lms-button-secondary" onClick={() => { setCourseError(""); setCourseDialog(true); }}><Icon icon={Plus} size={16} /> New course</button><button className="lms-button" onClick={() => { setInviteError(""); setInviteDialog(true); }} disabled={!activeCourses.length}><Icon icon={KeyRound} size={16} /> New invitation</button></div></div>
    {overview.isError && <ErrorState message={niceError(overview.error, "Admin overview could not be loaded.")} retry={() => void overview.refetch()} />}
    {setStatus.isError && <div className="lms-alert lms-alert-error" role="alert" style={{ marginBottom: 14 }}>{niceError(setStatus.error, "Course status could not be changed.")}</div>}
    {stats && <div className="lms-stat-grid">
      {[["Students", stats.students], ["Trainers", stats.trainers], ["Courses", stats.courses], ["Active enrollments", stats.activeEnrollments]].map(([label, value]) => <div className="lms-stat" key={label}><span>{label}</span><strong>{value}</strong><span>Current institute total</span></div>)}
    </div>}
    <section className="lms-panel" style={{ marginBottom: 16 }}>
      <div className="lms-panel-head"><div><div className="lms-eyebrow">Account access</div><h2>Student and trainer accounts</h2></div><span className="lms-tag">{adminUsers.data?.length ?? "—"} accounts</span></div>
      <p className="lms-help">Create an account, then give the person a one-time setup link so they can choose their own password. Setup links expire after 24 hours; share them privately.</p>
      <form onSubmit={submitAccount} className="lms-grid lms-grid-2">
        <div className="lms-field"><label htmlFor="account-name">Name</label><input id="account-name" className="lms-input" value={accountName} onChange={event => setAccountName(event.target.value)} minLength={2} maxLength={180} required /></div>
        <div className="lms-field"><label htmlFor="account-phone">Phone number</label><input id="account-phone" className="lms-input" type="tel" autoComplete="off" placeholder="+91 98765 43210 or 10-digit Indian mobile" value={accountPhone} onChange={event => setAccountPhone(event.target.value)} required /></div>
        <div className="lms-field"><label htmlFor="account-role">Account type</label><select id="account-role" className="lms-select" value={accountRole} onChange={event => setAccountRole(event.target.value as "student" | "trainer")}><option value="student">Student</option><option value="trainer">Trainer</option></select></div>
        <div className="lms-row" style={{ alignItems: "end" }}><button className="lms-button" type="submit" disabled={createUser.isPending}>{createUser.isPending ? "Saving account…" : "Save account"}</button></div>
      </form>
      {accountMessage && <div className="lms-alert lms-alert-success" role="status" style={{ marginTop: 12 }}>{accountMessage}</div>}
      {accountError && <div className="lms-alert lms-alert-error" role="alert" style={{ marginTop: 12 }}>{accountError}</div>}
      {adminUsers.isLoading ? <LoadingRows count={3} /> : adminUsers.isError ? <ErrorState message={niceError(adminUsers.error, "Accounts could not be loaded.")} retry={() => void adminUsers.refetch()} /> : !adminUsers.data?.length ? <EmptyState icon={GraduationCap} title="No student or trainer accounts" detail="Add an account above to start onboarding." /> :
        <div className="lms-table-wrap" style={{ marginTop: 16 }}><table className="lms-table"><thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Password</th><th>Action</th></tr></thead><tbody>{adminUsers.data.map(account => <tr key={account.id}>
          <td><strong>{account.displayName || "Name required"}</strong>{!account.isActive && <div className="lms-help">Inactive</div>}</td>
          <td className="lms-mono">{account.phoneE164}</td>
          <td>{account.roles.length ? account.roles.join(", ") : "No role"}</td>
          <td>{account.hasPassword ? "Set" : "Not set"}</td>
          <td><button className="lms-button lms-button-secondary lms-button-sm" onClick={() => issuePasswordLink(account.id, account.displayName)} disabled={!account.isActive || createPasswordSetupLink.isPending}>{account.hasPassword ? "Reset password" : "Create setup link"}</button></td>
        </tr>)}</tbody></table></div>}
    </section>
    <AdminOperations courses={listedCourses} users={adminUsers.data} />
    <ProfileNotifications user={user} />
    <div className="lms-grid lms-grid-2">
      <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Catalogue</div><h2>Courses</h2></div><span className="lms-tag">{listedCourses.length} total</span></div>
        {courses.isLoading ? <LoadingRows count={3} /> : courses.isError ? <ErrorState message={niceError(courses.error, "Courses could not be loaded.")} retry={() => void courses.refetch()} /> : !listedCourses.length ? <EmptyState title="No courses in the catalogue" detail="Create a course to start building your LEAP catalogue." icon={BookOpen} /> :
          <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>Course</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>{listedCourses.map(course => <tr key={course.id}><td><strong>{course.title}</strong><div className="lms-help lms-mono">{course.slug}</div></td><td><span className={`lms-status lms-status-${course.status}`}>{course.status}</span></td><td>{course.createdAt ? formatDate(course.createdAt) : "—"}</td><td><div className="lms-row"><Link className="lms-button lms-button-secondary lms-button-sm" href={`/manage/courses/${course.id}`}>Edit outline</Link><button className="lms-button lms-button-secondary lms-button-sm" onClick={() => changeStatus(course)} disabled={setStatus.isPending || course.status === "archived"}>{course.status === "published" ? "Archive" : course.status === "draft" ? "Publish" : "Archived"}</button></div></td></tr>)}</tbody></table></div>}
      </section>
      <section className="lms-panel"><div className="lms-panel-head"><div><div className="lms-eyebrow">Access control</div><h2>Invitations</h2></div><span className="lms-tag">{invitations.data?.filter(i => i.status === "active").length ?? "—"} active</span></div>
        {inviteError && <div className="lms-alert lms-alert-error" role="alert" style={{ marginBottom: 14 }}>{inviteError}</div>}
        {invitations.isLoading ? <LoadingRows count={3} /> : invitations.isError ? <ErrorState message={niceError(invitations.error, "Invitations could not be loaded.")} retry={() => void invitations.refetch()} /> : !invitations.data?.length ? <EmptyState icon={KeyRound} title="No invitations yet" detail="Create a course invitation when you are ready to onboard a learner." /> :
          <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>Course / code</th><th>Uses</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>{invitations.data.map(invitation => <tr key={invitation.id}><td><strong>{invitation.courseTitle}</strong><div className="lms-help lms-mono">•••• {invitation.codeHint}</div></td><td>{invitation.usesCount} / {invitation.maxUses}</td><td>{invitation.expiresAt ? formatDate(invitation.expiresAt) : "No expiry"}</td><td><span className={`lms-status lms-status-${invitation.status}`}>{invitation.status}</span></td><td>{invitation.status === "active" && <button className="lms-button lms-button-danger lms-button-sm" onClick={() => revoke(invitation)} disabled={revokeInvitation.isPending}>Revoke</button>}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
    {overview.isLoading && <p className="lms-help" style={{ marginTop: 14 }}>Refreshing institute totals…</p>}
    <section className="lms-panel lms-admin-certificates">
      <div className="lms-panel-head"><div><div className="lms-eyebrow">Completion review</div><h2>Certificates</h2></div><span className="lms-tag">{certificateReviews.data?.filter(item => item.status === "pending_review").length ?? "—"} awaiting review</span></div>
      <div className="lms-field"><label htmlFor="certificate-review-note">Review note <span className="lms-muted">(optional)</span></label><input id="certificate-review-note" className="lms-input" maxLength={2000} value={certificateReviewNote} onChange={event => setCertificateReviewNote(event.target.value)} placeholder="Note to include if you reject a request" /></div>
      {certificateReviewMessage && <div className={`lms-alert ${reviewCertificate.isError ? "lms-alert-error" : "lms-alert-success"}`} role="status">{certificateReviewMessage}</div>}
      {certificateReviews.isLoading ? <LoadingRows count={2} /> : certificateReviews.isError ? <ErrorState message={niceError(certificateReviews.error, "Certificate requests could not be loaded.")} retry={() => void certificateReviews.refetch()} /> : !certificateReviews.data?.length ? <EmptyState icon={GraduationCap} title="No certificate requests yet" detail="Eligible student certificates will appear here for review." /> :
        <div className="lms-table-wrap"><table className="lms-table"><thead><tr><th>Student</th><th>Course</th><th>Status</th><th>Certificate</th><th>Actions</th></tr></thead><tbody>{certificateReviews.data.map(item => <tr key={item.id}>
          <td><strong>{item.studentName || "Name required"}</strong><div className="lms-help">{item.phoneE164}</div></td><td>{item.courseTitle}</td><td><span className={`lms-status lms-status-${item.status}`}>{item.status.replaceAll("_", " ")}</span></td><td>{item.certificateNumber || "—"}</td>
          <td>{item.status === "pending_review" ? <div className="lms-row"><button className="lms-button lms-button-sm" disabled={reviewCertificate.isPending} onClick={() => decideCertificate(item.id, "approved")}>Approve</button><button className="lms-button lms-button-danger lms-button-sm" disabled={reviewCertificate.isPending} onClick={() => decideCertificate(item.id, "rejected")}>Reject</button></div> : item.status === "approved" ? <a className="lms-button lms-button-secondary lms-button-sm" href={`/api/lms/certificates/${item.id}/pdf`}>Download PDF</a> : item.reviewNote || "—"}</td>
        </tr>)}</tbody></table></div>}
    </section>
    <p className="lms-footer-note">Account, access, communication, and course oversight actions are restricted to authorized institute administrators.</p>
    {courseDialog && <div className="lms-dialog-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setCourseDialog(false); }}><section className="lms-dialog" role="dialog" aria-modal="true" aria-labelledby="new-course-title"><div className="lms-dialog-head"><div><div className="lms-eyebrow">Catalogue</div><h2 id="new-course-title">Create a course</h2></div><button className="lms-icon-button" onClick={() => setCourseDialog(false)} aria-label="Close"><Icon icon={X} /></button></div>
      {newCourse ? <><div className="lms-alert lms-alert-success">Course created as a draft. Publish it from the course list when it's ready.</div><div style={{ marginTop: 18 }}><button className="lms-button" onClick={() => { setCourseDialog(false); setNewCourse(null); }}>Done</button></div></> : <form onSubmit={submitCourse}>
        <div className="lms-field"><label htmlFor="course-title">Course title</label><input className="lms-input" id="course-title" value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} /></div>
        <div className="lms-field"><label htmlFor="course-slug">Course slug</label><input className="lms-input lms-mono" id="course-slug" value={slug} onChange={e => setSlug(e.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /><span className="lms-help">Lowercase letters, numbers, and hyphens.</span></div>
        <div className="lms-field"><label htmlFor="course-desc">Description</label><textarea className="lms-textarea" id="course-desc" value={description} onChange={e => setDescription(e.target.value)} required maxLength={2000} /></div>
        {courseError && <div className="lms-alert lms-alert-error" role="alert">{courseError}</div>}
        <div className="lms-row" style={{ justifyContent: "flex-end", marginTop: 18 }}><button className="lms-button lms-button-secondary" type="button" onClick={() => setCourseDialog(false)}>Cancel</button><button className="lms-button" type="submit" disabled={createCourse.isPending}>{createCourse.isPending ? "Creating…" : "Create draft course"}</button></div>
      </form>}</section></div>}
    {inviteDialog && <div className="lms-dialog-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setInviteDialog(false); }}><section className="lms-dialog" role="dialog" aria-modal="true" aria-labelledby="new-invite-title"><div className="lms-dialog-head"><div><div className="lms-eyebrow">Student access</div><h2 id="new-invite-title">Create invitation</h2></div><button className="lms-icon-button" onClick={() => setInviteDialog(false)} aria-label="Close"><Icon icon={X} /></button></div>
      <div className="lms-alert lms-alert-warning" style={{ marginBottom: 18 }}><Icon icon={ShieldAlert} /><span>The full invitation code is shown only once after creation. Copy it securely and share it only with the intended learner.</span></div>
      <form onSubmit={submitInvite}>
        <div className="lms-field"><label htmlFor="invite-course">Published course</label><select id="invite-course" className="lms-select" value={inviteCourseId} onChange={e => setInviteCourseId(e.target.value)} required><option value="">Choose a course</option>{activeCourses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></div>
        <div className="lms-field"><label htmlFor="invite-phone">Reserve for phone <span className="lms-muted">(optional)</span></label><input id="invite-phone" className="lms-input" type="tel" value={invitePhone} onChange={e => setInvitePhone(e.target.value)} placeholder="+91…" /></div>
        <div className="lms-field"><label htmlFor="invite-uses">Maximum redemptions</label><input id="invite-uses" className="lms-input" type="number" min="1" max="1000" value={inviteUses} onChange={e => setInviteUses(e.target.value)} required /></div>
        <div className="lms-field"><label htmlFor="invite-expiry">Expiry <span className="lms-muted">(optional)</span></label><input id="invite-expiry" className="lms-input" type="datetime-local" value={inviteExpiry} onChange={e => setInviteExpiry(e.target.value)} /></div>
        {inviteError && <div className="lms-alert lms-alert-error" role="alert">{inviteError}</div>}
        <div className="lms-row" style={{ justifyContent: "flex-end", marginTop: 18 }}><button className="lms-button lms-button-secondary" type="button" onClick={() => setInviteDialog(false)}>Cancel</button><button className="lms-button" type="submit" disabled={createInvitation.isPending || !inviteCourseId}>{createInvitation.isPending ? "Generating…" : "Generate one-time code"}</button></div>
      </form></section></div>}
     {setupLink && <div className="lms-dialog-backdrop"><section className="lms-dialog" role="dialog" aria-modal="true" aria-labelledby="password-setup-link-title"><div className="lms-dialog-head"><div><div className="lms-eyebrow">Password access</div><h2 id="password-setup-link-title">Copy the one-time setup link</h2></div><button className="lms-icon-button" onClick={() => setSetupLink(null)} aria-label="Close and hide setup link"><Icon icon={X} /></button></div>
       <div className="lms-alert lms-alert-warning"><Icon icon={ShieldAlert} /><span>This link is for {setupLink.userName}, can be used once, and expires {formatDate(setupLink.expiresAt)}. Share it privately. The full link will not be shown again after closing.</span></div>
       <div className="lms-code-display" aria-label="One-time password setup link">{`${window.location.origin}${setupLink.setupPath}`}</div>
       <div className="lms-row" style={{ justifyContent: "flex-end" }}><button className="lms-button lms-button-secondary" onClick={async () => { try { await navigator.clipboard.writeText(`${window.location.origin}${setupLink.setupPath}`); } catch { setAccountError("Clipboard access was unavailable. Select and copy the setup link manually."); } }}>Copy link</button><button className="lms-button" onClick={() => setSetupLink(null)}>I've shared it securely</button></div>
     </section></div>}
    {oneTimeCode && <div className="lms-dialog-backdrop"><section className="lms-dialog" role="dialog" aria-modal="true" aria-labelledby="one-time-code-title"><div className="lms-dialog-head"><div><div className="lms-eyebrow">Created successfully</div><h2 id="one-time-code-title">Copy this invitation now</h2></div><button className="lms-icon-button" onClick={() => setOneTimeCode(null)} aria-label="Close and hide code"><Icon icon={X} /></button></div><div className="lms-alert lms-alert-warning"><Icon icon={ShieldAlert} /><span>This code will not be shown again. Store or share it securely before closing this window.</span></div><div className="lms-code-display" aria-label="Invitation code">{oneTimeCode}</div><div className="lms-row" style={{ justifyContent: "flex-end" }}><button className="lms-button lms-button-secondary" onClick={async () => { try { await navigator.clipboard.writeText(oneTimeCode); } catch { setInviteError("Clipboard access was unavailable. Select and copy the invitation code manually."); } }}>Copy code</button><button className="lms-button" onClick={() => setOneTimeCode(null)}>I've secured it</button></div></section></div>}
  </PageFrame>;
}

export const lmsRouteMap = {
  "/learn": LearnLoginPage,
  "/learn/dashboard": StudentDashboardPage,
  "/learn/courses/:courseId": CoursePage,
  "/trainer": TrainerPage,
  "/lms-admin": AdminPage,
} as const;

export const LmsPages = {
  LearnLoginPage,
  StudentDashboardPage,
  CoursePage,
  TrainerPage,
  AdminPage,
};
export { CourseManagerPage } from "./CourseManager";
export default LmsPages;
