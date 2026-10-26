import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ClipboardCheck, LoaderCircle, Plus, X } from "lucide-react";
import { requestJson } from "@/hooks/use-lms";

type AssessmentStatus = "draft" | "published" | "archived";
type AssessmentSummary = { id: number; title: string; status: AssessmentStatus };
type QuestionDraft = {
  prompt: string;
  explanation: string;
  options: { label: string; isCorrect: boolean }[];
};
type AssessmentDetails = {
  id: number;
  title: string;
  status: AssessmentStatus;
  instructions: string;
  showExplanationsAfterAttempt: boolean;
  questions: QuestionDraft[];
};

function blankQuestion(): QuestionDraft {
  return {
    prompt: "",
    explanation: "",
    options: [
      { label: "", isCorrect: true },
      { label: "", isCorrect: false },
    ],
  };
}

export function AssessmentEditor({
  chapterId,
  assessment,
  courseId,
  canPublish,
}: {
  chapterId: number;
  assessment: AssessmentSummary | null;
  courseId: number;
  canPublish: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [showExplanations, setShowExplanations] = useState(false);
  const [questions, setQuestions] = useState<QuestionDraft[]>([blankQuestion()]);
  const [message, setMessage] = useState("");
  const details = useQuery<AssessmentDetails>({
    queryKey: ["/api/lms/manage/assessments", assessment?.id],
    queryFn: () => requestJson("GET", `/api/lms/manage/assessments/${assessment!.id}`),
    enabled: open && Boolean(assessment?.id),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/lms/manage/courses", courseId, "outline"] });
    if (assessment?.id) queryClient.invalidateQueries({ queryKey: ["/api/lms/manage/assessments", assessment.id] });
  };
  const create = useMutation({
    mutationFn: (body: unknown) =>
      requestJson("POST", `/api/lms/manage/chapters/${chapterId}/assessments`, body),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (body: unknown) =>
      requestJson("PUT", `/api/lms/manage/assessments/${assessment?.id}`, body),
    onSuccess: refresh,
  });
  const setStatus = useMutation({
    mutationFn: (status: AssessmentStatus) =>
      requestJson("POST", `/api/lms/manage/assessments/${assessment?.id}/status`, { status }),
    onSuccess: refresh,
  });

  useEffect(() => {
    if (!details.data) return;
    setTitle(details.data.title);
    setInstructions(details.data.instructions);
    setShowExplanations(details.data.showExplanationsAfterAttempt);
    setQuestions(details.data.questions.length ? details.data.questions : [blankQuestion()]);
  }, [details.data]);

  const updateQuestion = (index: number, change: (current: QuestionDraft) => QuestionDraft) => {
    setQuestions(current => current.map((question, i) => i === index ? change(question) : question));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    const body = {
      title: title.trim(),
      instructions: instructions.trim(),
      showExplanationsAfterAttempt: showExplanations,
      questions: questions.map(question => ({
        prompt: question.prompt.trim(),
        explanation: question.explanation.trim() || null,
        options: question.options.map(option => ({ label: option.label.trim(), isCorrect: option.isCorrect })),
      })),
    };
    const mutation = assessment ? update : create;
    mutation.mutate(body, {
      onSuccess: () => {
        setMessage("Assessment version saved.");
        setOpen(false);
      },
      onError: error => setMessage(error instanceof Error ? error.message : "Assessment could not be saved."),
    });
  };

  const saving = create.isPending || update.isPending;

  return <div className="lms-assessment-editor">
    <div className="lms-assessment-editor-head">
      <span><ClipboardCheck size={15} /> {assessment ? `${assessment.title} · ${assessment.status}` : "No assessment yet"}</span>
      <div className="lms-row">
        <button type="button" className="lms-text-button" onClick={() => { setMessage(""); setOpen(value => !value); }}>
          {open ? "Close editor" : assessment ? "Edit assessment" : "Create assessment"}
          {open ? <X size={13} /> : <ChevronDown size={13} />}
        </button>
        {assessment && canPublish && <button type="button" className="lms-button lms-button-secondary lms-button-sm" disabled={setStatus.isPending || assessment.status === "archived"} onClick={() => {
          const next = assessment.status === "published" ? "draft" : "published";
          if (window.confirm(`${next === "published" ? "Publish" : "Move back to draft"} this assessment?`)) setStatus.mutate(next);
        }}>{assessment.status === "published" ? "Unpublish" : "Publish"}</button>}
      </div>
    </div>
    {message && <div className={`lms-alert ${create.isError || update.isError || setStatus.isError ? "lms-alert-error" : "lms-alert-success"}`} role="status">{message}</div>}
    {open && <>
      {details.isLoading && <div className="lms-help"><LoaderCircle className="lms-spin" size={14} /> Loading assessment…</div>}
      {details.isError && <div className="lms-alert lms-alert-error" role="alert">{details.error instanceof Error ? details.error.message : "Assessment could not be loaded."}<button className="lms-text-button" onClick={() => void details.refetch()}>Retry</button></div>}
      {(!assessment || details.data) && <form className="lms-builder-form lms-assessment-builder" onSubmit={submit}>
        <div className="lms-field"><label>Assessment title</label><input className="lms-input" value={title} onChange={event => setTitle(event.target.value)} minLength={2} maxLength={180} required /></div>
        <div className="lms-field"><label>Instructions</label><textarea className="lms-input" value={instructions} onChange={event => setInstructions(event.target.value)} rows={2} maxLength={5000} /></div>
        <div className="lms-assessment-summary"><span>Passing score: 100%</span><span>Unlimited attempts</span></div>
        <label className="lms-checkbox-row"><input type="checkbox" checked={showExplanations} onChange={event => setShowExplanations(event.target.checked)} /> Show explanations after each attempt</label>
        {questions.map((question, questionIndex) => <fieldset className="lms-question" key={questionIndex}>
          <legend><span className="lms-question-number">{questionIndex + 1}</span>Question</legend>
          <div className="lms-field"><label>Question prompt</label><textarea className="lms-input" value={question.prompt} onChange={event => updateQuestion(questionIndex, current => ({ ...current, prompt: event.target.value }))} rows={2} minLength={2} maxLength={2000} required /></div>
          <div className="lms-option-list">
            {question.options.map((option, optionIndex) => <div className="lms-builder-option" key={optionIndex}>
              <label className="lms-radio-label"><input type="radio" name={`correct-${chapterId}-${questionIndex}`} checked={option.isCorrect} onChange={() => updateQuestion(questionIndex, current => ({ ...current, options: current.options.map((item, i) => ({ ...item, isCorrect: i === optionIndex })) }))} /><span>Correct</span></label>
              <input aria-label={`Answer option ${optionIndex + 1}`} className="lms-input" value={option.label} onChange={event => updateQuestion(questionIndex, current => ({ ...current, options: current.options.map((item, i) => i === optionIndex ? { ...item, label: event.target.value } : item) }))} maxLength={500} required />
              {question.options.length > 2 && <button type="button" className="lms-icon-button" aria-label="Remove answer option" onClick={() => updateQuestion(questionIndex, current => {
                const nextOptions = current.options.filter((_, i) => i !== optionIndex);
                if (!nextOptions.some(item => item.isCorrect)) nextOptions[0] = { ...nextOptions[0], isCorrect: true };
                return { ...current, options: nextOptions };
              })}><X size={14} /></button>}
            </div>)}
          </div>
          {question.options.length < 10 && <button type="button" className="lms-text-button" onClick={() => updateQuestion(questionIndex, current => ({ ...current, options: [...current.options, { label: "", isCorrect: false }] }))}><Plus size={13} /> Add answer option</button>}
          <div className="lms-field"><label>Explanation <span className="lms-muted">(optional)</span></label><textarea className="lms-input" value={question.explanation} onChange={event => updateQuestion(questionIndex, current => ({ ...current, explanation: event.target.value }))} rows={2} maxLength={3000} /></div>
          {questions.length > 1 && <button type="button" className="lms-text-button lms-text-danger" onClick={() => setQuestions(current => current.filter((_, i) => i !== questionIndex))}>Remove question</button>}
        </fieldset>)}
        {questions.length < 100 && <button type="button" className="lms-button lms-button-secondary lms-button-sm" onClick={() => setQuestions(current => [...current, blankQuestion()])}><Plus size={14} /> Add question</button>}
        {(create.isError || update.isError) && <div className="lms-alert lms-alert-error" role="alert">{message}</div>}
        <button type="submit" className="lms-button" disabled={saving}>{saving ? "Saving…" : <><Check size={14} /> Save assessment version</>}</button>
      </form>}
    </>}
  </div>;
}
