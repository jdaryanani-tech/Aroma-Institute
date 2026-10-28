import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, LoaderCircle, Plus, ShieldAlert } from "lucide-react";
import { requestJson, useLmsLogout, useLmsSession } from "@/hooks/use-lms";
import type { LmsCourse } from "@/hooks/use-lms";
import { AssessmentEditor } from "./AssessmentEditor";

type Status = "draft" | "published" | "archived";
type ManagedResource = { id: number; fileName: string; contentType: string; byteSize: number };
type ManagedLesson = {
  id: number;
  title: string;
  description: string;
  youtubeUrl: string | null;
  durationMinutes: number | null;
  requiredForAssessment: boolean;
  position: number;
  status: Status;
  resources: ManagedResource[];
};
type ManagedChapter = {
  id: number;
  title: string;
  description: string;
  position: number;
  status: Status;
  lessons: ManagedLesson[];
  assessment: { id: number; title: string; status: Status } | null;
};
type ManagedModule = {
  id: number;
  title: string;
  description: string;
  position: number;
  status: Status;
  chapters: ManagedChapter[];
};
type ManagedCourse = { course: LmsCourse; modules: ManagedModule[] };

function statusClass(status: Status) {
  return `lms-status lms-status-${status}`;
}

export function CourseManagerPage() {
  const session = useLmsSession();
  const logout = useLmsLogout();
  const params = useParams<{ courseId: string }>();
  const courseId = Number(params.courseId);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [formMessage, setFormMessage] = useState("");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const allowed = Boolean(session.data?.roles.some((role) => role === "admin" || role === "trainer"));

  useEffect(() => {
    if (!session.isLoading && !session.data) setLocation("/learn");
  }, [session.isLoading, session.data, setLocation]);

  const outline = useQuery<ManagedCourse>({
    queryKey: ["/api/lms/manage/courses", courseId, "outline"],
    queryFn: () => requestJson("GET", `/api/lms/manage/courses/${courseId}/outline`),
    enabled: allowed && Number.isSafeInteger(courseId) && courseId > 0,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/lms/manage/courses", courseId, "outline"] });
  const createModule = useMutation({
    mutationFn: (body: { title: string; description: string; position: number }) =>
      requestJson("POST", `/api/lms/manage/courses/${courseId}/modules`, body),
    onSuccess: invalidate,
  });
  const createChapter = useMutation({
    mutationFn: (input: { moduleId: number; title: string; description: string; position: number }) =>
      requestJson("POST", `/api/lms/manage/modules/${input.moduleId}/chapters`, {
        title: input.title,
        description: input.description,
        position: input.position,
      }),
    onSuccess: invalidate,
  });
  const createLesson = useMutation({
    mutationFn: (input: { chapterId: number; title: string; description: string; youtubeUrl: string | null; durationMinutes: number | null; position: number; requiredForAssessment: boolean }) =>
      requestJson("POST", `/api/lms/manage/chapters/${input.chapterId}/lessons`, {
        title: input.title,
        description: input.description,
        youtubeUrl: input.youtubeUrl,
        durationMinutes: input.durationMinutes,
        position: input.position,
        requiredForAssessment: input.requiredForAssessment,
      }),
    onSuccess: invalidate,
  });
  const setContentStatus = useMutation({
    mutationFn: (input: { kind: "modules" | "chapters" | "lessons"; id: number; status: Status }) =>
      requestJson("POST", `/api/lms/manage/${input.kind}/${input.id}/status`, { status: input.status }),
    onSuccess: invalidate,
  });
  const uploadResource = useMutation({
    mutationFn: async (input: { lessonId: number; file: File }) => {
      const contentType =
        input.file.type ||
        (input.file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");
      const response = await fetch(`/api/lms/manage/lessons/${input.lessonId}/resources`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": contentType,
          "X-File-Name": encodeURIComponent(input.file.name),
        },
        body: input.file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof result.message === "string" ? result.message : "File upload failed.");
      }
      return result;
    },
    onSuccess: invalidate,
  });

  if (session.isLoading || (session.data && allowed && outline.isLoading)) {
    return <div className="lms"><main className="lms-shell lms-main"><LoaderCircle className="lms-spin" /> Loading course workspace…</main></div>;
  }
  if (!session.data) {
    return <div className="lms"><main className="lms-shell lms-main">Taking you to sign in…</main></div>;
  }
  if (!allowed) {
    return <div className="lms"><main className="lms-shell lms-main"><div className="lms-alert lms-alert-error"><ShieldAlert /> This workspace is available to assigned trainers and administrators only.</div></main></div>;
  }
  const data = outline.data;
  const isAdmin = session.data.roles.includes("admin");

  function submitModule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setFormMessage("");
    createModule.mutate({
      title: String(values.get("title") || "").trim(),
      description: String(values.get("description") || "").trim(),
      position: data?.modules.length ?? 0,
    }, { onSuccess: () => { form.reset(); setFormMessage("Module added as a draft."); }, onError: error => setFormMessage(error instanceof Error ? error.message : "Module could not be added.") });
  }

  function submitChapter(event: FormEvent<HTMLFormElement>, module: ManagedModule) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setFormMessage("");
    createChapter.mutate({
      moduleId: module.id,
      title: String(values.get("title") || "").trim(),
      description: String(values.get("description") || "").trim(),
      position: module.chapters.length,
    }, { onSuccess: () => { form.reset(); setFormMessage("Chapter added as a draft."); }, onError: error => setFormMessage(error instanceof Error ? error.message : "Chapter could not be added.") });
  }

  function submitLesson(event: FormEvent<HTMLFormElement>, chapter: ManagedChapter) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const duration = String(values.get("duration") || "");
    setFormMessage("");
    createLesson.mutate({
      chapterId: chapter.id,
      title: String(values.get("title") || "").trim(),
      description: String(values.get("description") || "").trim(),
      youtubeUrl: String(values.get("youtubeUrl") || "").trim() || null,
      durationMinutes: duration ? Number(duration) : null,
      position: chapter.lessons.length,
      requiredForAssessment: values.get("requiredForAssessment") === "on",
    }, { onSuccess: () => { form.reset(); setFormMessage("Lesson added as a draft."); }, onError: error => setFormMessage(error instanceof Error ? error.message : "Lesson could not be added.") });
  }

  function submitResource(event: FormEvent<HTMLFormElement>, lessonId: number) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (new FormData(form).get("resource") as File | null) ?? null;
    if (!file || file.size === 0) {
      setFormMessage("Choose a PDF or plain text file first.");
      return;
    }
    setFormMessage("");
    uploadResource.mutate(
      { lessonId, file },
      {
        onSuccess: () => {
          form.reset();
          setFormMessage("Learning file uploaded.");
        },
        onError: error =>
          setFormMessage(error instanceof Error ? error.message : "File upload failed."),
      },
    );
  }

  const toggleStatus = (kind: "modules" | "chapters" | "lessons", id: number, status: Status) => {
    const nextStatus = status === "published" ? "draft" : "published";
    if (window.confirm(`${nextStatus === "published" ? "Publish" : "Move back to draft"} this ${kind.slice(0, -1)}?`)) {
      setContentStatus.mutate({ kind, id, status: nextStatus });
    }
  };

  return <div className="lms">
    <header className="lms-header"><div className="lms-shell lms-header-inner"><Link href="/learn" className="lms-brand"><span className="lms-mark">A</span><span><span className="lms-brand-name">Aroma LEAP</span><span className="lms-brand-sub">Course workspace</span></span></Link><button className="lms-button lms-button-secondary lms-button-sm" onClick={() => logout.mutate(undefined, { onSuccess: () => setLocation("/learn") })}>Sign out</button></div></header>
    <main className="lms-shell lms-main">
      <Link href={isAdmin ? "/lms-admin" : "/trainer"} className="lms-course-link"><ArrowLeft size={14} /> Back to workspace</Link>
      {outline.isError ? <div className="lms-alert lms-alert-error" role="alert">{outline.error instanceof Error ? outline.error.message : "Course outline could not be loaded."}<button className="lms-text-button" onClick={() => void outline.refetch()}>Retry</button></div> : data && <>
        <div className="lms-page-head lms-builder-head"><div><div className="lms-eyebrow">{isAdmin ? "Administrator" : "Trainer"} / Course outline</div><h1>{data.course.title}</h1><p className="lms-subtitle">{data.course.description}</p></div><span className={statusClass(data.course.status)}>{data.course.status}</span></div>
        <div className="lms-alert lms-alert-warning"><BookOpen size={16} /><span>New modules, chapters, and lessons are saved as drafts. Only administrators can publish content.</span></div>
        {formMessage && <div className="lms-alert lms-alert-success" role="status" style={{ marginTop: 14 }}><Check size={16} /> {formMessage}</div>}
        {setContentStatus.isError && <div className="lms-alert lms-alert-error" role="alert" style={{ marginTop: 14 }}>{setContentStatus.error instanceof Error ? setContentStatus.error.message : "Content status could not be changed."}</div>}
        <section className="lms-panel lms-builder-create">
          <div className="lms-panel-head"><div><div className="lms-eyebrow">Course structure</div><h2>Add a module</h2></div><Plus size={18} /></div>
          <form className="lms-builder-form" onSubmit={submitModule}>
            <div className="lms-field"><label htmlFor="new-module-title">Module title</label><input id="new-module-title" name="title" className="lms-input" minLength={2} maxLength={180} required /></div>
            <div className="lms-field"><label htmlFor="new-module-description">Description</label><textarea id="new-module-description" name="description" className="lms-input" rows={2} maxLength={5000} /></div>
            <button className="lms-button" type="submit" disabled={createModule.isPending}>{createModule.isPending ? "Adding…" : "Add module"}</button>
          </form>
        </section>
        {!data.modules.length ? <div className="lms-panel"><div className="lms-empty"><div className="lms-empty-mark"><BookOpen size={18} /></div><h3>No modules yet</h3><p className="lms-muted">Start by adding the first module to this course.</p></div></div> :
          <div className="lms-builder-list">{data.modules.map((module, moduleIndex) => <section className="lms-panel lms-builder-module" key={module.id}>
            <div className="lms-builder-title"><button className="lms-icon-button" aria-label={expanded[module.id] === false ? "Expand module" : "Collapse module"} onClick={() => setExpanded(current => ({ ...current, [module.id]: current[module.id] === false }))}>{expanded[module.id] === false ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</button><div><div className="lms-eyebrow">Module {moduleIndex + 1}</div><h2>{module.title}</h2></div><span className={statusClass(module.status)}>{module.status}</span>{isAdmin && <button className="lms-button lms-button-secondary lms-button-sm" disabled={setContentStatus.isPending} onClick={() => toggleStatus("modules", module.id, module.status)}>{module.status === "published" ? "Unpublish" : "Publish"}</button>}</div>
            {expanded[module.id] !== false && <>
              {module.description && <p className="lms-muted">{module.description}</p>}
              {module.chapters.map((chapter, chapterIndex) => <div className="lms-builder-chapter" key={chapter.id}>
                <div className="lms-builder-title"><div><div className="lms-eyebrow">Chapter {moduleIndex + 1}.{chapterIndex + 1}</div><h3>{chapter.title}</h3></div><span className={statusClass(chapter.status)}>{chapter.status}</span>{isAdmin && <button className="lms-button lms-button-secondary lms-button-sm" disabled={setContentStatus.isPending} onClick={() => toggleStatus("chapters", chapter.id, chapter.status)}>{chapter.status === "published" ? "Unpublish" : "Publish"}</button>}</div>
                {chapter.description && <p className="lms-muted">{chapter.description}</p>}
                <div className="lms-builder-lessons">{chapter.lessons.map((lesson, lessonIndex) => <div className="lms-builder-lesson" key={lesson.id}><div><strong>{lessonIndex + 1}. {lesson.title}</strong><p className="lms-help">{lesson.durationMinutes ? `${lesson.durationMinutes} min · ` : ""}{lesson.requiredForAssessment ? "Required for assessment" : "Optional lesson"}</p>{lesson.youtubeUrl && <a href={lesson.youtubeUrl} target="_blank" rel="noreferrer" className="lms-course-link">View YouTube link</a>}{lesson.resources.map(resource => <div key={resource.id}><a href={`/api/lms/resources/${resource.id}`} className="lms-course-link">{resource.fileName}</a><span className="lms-help"> · {(resource.byteSize / 1024).toFixed(0)} KB</span></div>)}<form className="lms-builder-inline-form" onSubmit={event => submitResource(event, lesson.id)}><label className="lms-help">Add learning file (PDF or TXT, up to 10 MB)<input name="resource" type="file" accept=".pdf,.txt,application/pdf,text/plain" className="lms-input" required /></label><button className="lms-button lms-button-secondary lms-button-sm" type="submit" disabled={uploadResource.isPending}>{uploadResource.isPending ? "Uploading…" : "Upload file"}</button></form></div><span className={statusClass(lesson.status)}>{lesson.status}</span>{isAdmin && <button className="lms-button lms-button-secondary lms-button-sm" disabled={setContentStatus.isPending} onClick={() => toggleStatus("lessons", lesson.id, lesson.status)}>{lesson.status === "published" ? "Unpublish" : "Publish"}</button>}</div>)}</div>
                <AssessmentEditor chapterId={chapter.id} courseId={courseId} assessment={chapter.assessment} canPublish={isAdmin} />
                <form className="lms-builder-form lms-builder-inline-form" onSubmit={event => submitLesson(event, chapter)}>
                  <strong>Add lesson</strong>
                  <div className="lms-builder-two-col"><div className="lms-field"><label>Lesson title</label><input name="title" className="lms-input" minLength={2} maxLength={180} required /></div><div className="lms-field"><label>YouTube URL</label><input name="youtubeUrl" type="url" className="lms-input" placeholder="https://youtu.be/…" /></div></div>
                  <div className="lms-builder-two-col"><div className="lms-field"><label>Description / notes</label><textarea name="description" className="lms-input" rows={2} maxLength={5000} /></div><div className="lms-field"><label>Duration in minutes</label><input name="duration" type="number" min={1} max={1000} className="lms-input" /></div></div>
                  <label className="lms-checkbox-row"><input type="checkbox" name="requiredForAssessment" defaultChecked /> Required before the chapter assessment</label>
                  <button className="lms-button lms-button-secondary lms-button-sm" type="submit" disabled={createLesson.isPending}>{createLesson.isPending ? "Adding…" : "Add lesson"}</button>
                </form>
              </div>)}
              <form className="lms-builder-form lms-builder-inline-form" onSubmit={event => submitChapter(event, module)}>
                <strong>Add chapter</strong>
                <div className="lms-builder-two-col"><div className="lms-field"><label>Chapter title</label><input name="title" className="lms-input" minLength={2} maxLength={180} required /></div><div className="lms-field"><label>Description</label><input name="description" className="lms-input" maxLength={5000} /></div></div>
                <button className="lms-button lms-button-secondary lms-button-sm" type="submit" disabled={createChapter.isPending}>{createChapter.isPending ? "Adding…" : "Add chapter"}</button>
              </form>
            </>}
          </section>)}</div>}
      </>}
    </main>
  </div>;
}
