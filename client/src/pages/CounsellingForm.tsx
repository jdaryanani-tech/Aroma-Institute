import { useState, type FormEvent } from "react";
import { format, parseISO } from "date-fns";
import { CalendarDays } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  counsellingAnswersSchema,
  getIndiaDateString,
  insertCounsellingInquirySchema,
  type CounsellingAnswers,
} from "@shared/schema";
import { counsellingQuestions, type QuestionnaireQuestion } from "./counsellingQuestions";
import { getMarketingAttribution, trackMetaEvent } from "@/meta/tracking";

const initialAnswers: Record<string, unknown> = {
  fullName: "",
  ageRange: "",
  currentActivity: "",
  city: "",
  careerReasons: [],
  mainBarrier: "",
  situationImpact: "",
  sixToTwelveMonthGoal: "",
  coffeeKnowledge: "",
  stepsTaken: [],
  biggestConcern: "",
  desiredStart: "",
  handsOnReadiness: "",
  timeAvailability: "",
  decisionMaker: "",
  familyDiscussion: "",
  investmentSituation: "",
  topQuestions: "",
  counsellorNote: "",
  visitMode: "",
  preferredDate: "",
  preferredTime: "",
  visitCompanion: "",
  visitFocus: "",
  mobileWhatsapp: "",
  email: "",
  counsellingLanguage: "",
  parentJoining: "",
  consentToContact: false,
};

function localDateString() {
  return getIndiaDateString();
}

function ChoiceOption({
  name,
  value,
  label,
  type,
  checked,
  onChange,
}: {
  name: string;
  value: string;
  label: string;
  type: "radio" | "checkbox";
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className={`group flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
      checked
        ? "border-amber-300/90 bg-amber-300/10 text-[#fff3df]"
        : "border-[#59432d]/70 bg-[#100b07]/55 text-[#e7d8c5] hover:border-amber-300/50 hover:bg-[#21170f]"
    }`}>
      <input
        aria-label={label}
        className="size-4 shrink-0 accent-amber-400"
        checked={checked}
        name={name}
        onChange={onChange}
        type={type}
        value={value}
        data-testid={`choice-${name}-${value}`}
      />
      <span className="text-sm leading-6 sm:text-[15px]">{label}</span>
    </label>
  );
}

function questionErrorMessage(question: QuestionnaireQuestion, value: unknown) {
  if (question.kind === "consent") return "Aage badhne ke liye contact consent dena zaroori hai.";
  if (question.kind === "multiple") return "Aage badhne ke liye kam se kam ek option select karein.";
  if (question.kind === "email") return "Valid email address daalein, ya ise blank chhod dein.";
  if (question.kind === "date") {
    return value ? "Aaj ya uske baad ki valid date select karein." : "Visit ke liye ek date select karein.";
  }
  if (question.kind === "phone") return "Valid mobile ya WhatsApp number daalein.";
  if (question.kind === "text" && question.key === "fullName") return "Apna poora naam likhein.";
  if (question.kind === "text" && question.key === "city") return "Apni city ka naam likhein.";
  return "Aage badhne ke liye ek option choose karein.";
}

export default function CounsellingForm() {
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>(initialAnswers);
  const [questionError, setQuestionError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);

  const question = counsellingQuestions[step];
  const currentValue = answers[question.key];
  const isLastQuestion = step === counsellingQuestions.length - 1;

  function updateAnswer(key: keyof CounsellingAnswers, value: unknown) {
    setAnswers((previous) => ({ ...previous, [key]: value }));
    setQuestionError("");
    setSubmitError("");
  }

  function toggleChoice(value: string) {
    if (question.kind === "multiple") {
      const selected = Array.isArray(currentValue) ? currentValue as string[] : [];
      const next = selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value];
      updateAnswer(question.key, next);
      return;
    }
    updateAnswer(question.key, value);
  }

  function validateCurrentQuestion() {
    const fieldSchema = counsellingAnswersSchema.shape[question.key];
    const validation = fieldSchema.safeParse(currentValue);
    if (validation.success) {
      setQuestionError("");
      return true;
    }
    setQuestionError(questionErrorMessage(question, currentValue));
    return false;
  }

  async function saveCounsellingRequest() {
    setSubmitError("");
    const answerResult = counsellingAnswersSchema.safeParse(answers);
    if (!answerResult.success) {
      setSubmitError("Kuch required answers missing hain. Form mein wapas jaakar check karein.");
      return;
    }

    const parsedAnswers = answerResult.data;
    const payload = {
      name: parsedAnswers.fullName,
      phone: parsedAnswers.mobileWhatsapp,
      email: parsedAnswers.email,
      programInterest: "Aroma LEAP",
      message: "Aroma LEAP counselling and visit request. Preferred appointment is pending availability check.",
      counsellingAnswers: parsedAnswers,
    };
    const payloadResult = insertCounsellingInquirySchema.safeParse(payload);
    if (!payloadResult.success) {
      setSubmitError("Form submit nahi ho paya. Apne contact details check karke dobara try karein.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiRequest("POST", "/api/counselling-inquiries", {
        ...payloadResult.data,
        attribution: getMarketingAttribution(),
      });
      const result = await response.json();
      trackMetaEvent("CounsellingSubmitted", result.metaEventId, { funnel_step: "counselling_submitted" });
      setComplete(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Request submit nahi ho payi. Dobara try karein.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleStepSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateCurrentQuestion()) return;
    if (isLastQuestion) {
      void saveCounsellingRequest();
      return;
    }
    setStep((current) => current + 1);
    setQuestionError("");
  }

  function renderQuestionInput() {
    if (question.kind === "single" || question.kind === "multiple") {
      const selectedValues = Array.isArray(currentValue) ? currentValue as string[] : [];
      return (
        <fieldset className="mt-7 grid gap-3">
          <legend className="sr-only">{question.prompt}</legend>
          {question.choices?.map((choice) => (
            <ChoiceOption
              key={choice.value}
              checked={question.kind === "multiple"
                ? selectedValues.includes(choice.value)
                : currentValue === choice.value}
              label={choice.label}
              name={question.key}
              onChange={() => toggleChoice(choice.value)}
              type={question.kind === "multiple" ? "checkbox" : "radio"}
              value={choice.value}
            />
          ))}
        </fieldset>
      );
    }

    if (question.kind === "textarea") {
      return (
        <textarea
          className="mt-7 min-h-36 w-full resize-y rounded-xl border border-[#59432d]/70 bg-[#100b07]/70 px-4 py-3 text-base text-[#fff3df] outline-none transition placeholder:text-[#9f8c75] focus:border-amber-300/80 focus:ring-2 focus:ring-amber-300/20"
          data-testid={`field-${question.key}`}
          onChange={(event) => updateAnswer(question.key, event.target.value)}
          placeholder={question.placeholder}
          value={typeof currentValue === "string" ? currentValue : ""}
        />
      );
    }

    if (question.kind === "date") {
      const selectedDate = typeof currentValue === "string" && currentValue
        ? parseISO(currentValue)
        : undefined;
      const firstAvailableDate = parseISO(`${localDateString()}T00:00:00`);

      return (
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button
              aria-expanded={calendarOpen}
              aria-haspopup="dialog"
              aria-label={selectedDate ? `Visit date: ${format(selectedDate, "EEEE, MMMM d, yyyy")}` : "Choose a visit date"}
              className="mt-7 min-h-14 w-full justify-between rounded-xl border border-[#59432d]/70 bg-[#100b07]/70 px-4 text-left font-normal text-[#fff3df] hover:bg-[#21170f] hover:text-[#fff3df] focus-visible:ring-2 focus-visible:ring-amber-300/40"
              data-testid={`field-${question.key}`}
              type="button"
              variant="outline"
            >
              <span className={selectedDate ? "text-[#fff3df]" : "text-[#9f8c75]"}>
                {selectedDate ? format(selectedDate, "EEEE, MMMM d, yyyy") : "Choose a visit date"}
              </span>
              <CalendarDays className="size-5 shrink-0 text-amber-300" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            className="w-auto rounded-2xl border-[#624725]/80 bg-[#19110b] p-2 text-[#fff3df] shadow-[0_18px_55px_rgba(0,0,0,0.55)]"
            data-testid="visit-date-calendar"
            sideOffset={8}
          >
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={(date) => {
                updateAnswer(question.key, date ? format(date, "yyyy-MM-dd") : "");
                setCalendarOpen(false);
              }}
              disabled={{ before: firstAvailableDate }}
              initialFocus
              className="rounded-xl"
              classNames={{
                caption_label: "text-sm font-semibold text-[#fff3df]",
                nav_button: "h-8 w-8 rounded-lg border border-[#624725]/70 bg-[#21170f] p-0 text-[#e7d8c5] opacity-100 hover:bg-[#342316] hover:text-[#fff3df]",
                head_cell: "w-9 rounded-md text-[0.8rem] font-normal text-[#ad9b84]",
                day: "h-9 w-9 rounded-md p-0 font-normal text-[#e7d8c5] hover:bg-amber-300/15 hover:text-[#fff3df] focus:bg-amber-300/20",
                day_selected: "bg-amber-400 text-[#21140a] opacity-100 hover:bg-amber-300 hover:text-[#21140a] focus:bg-amber-300 focus:text-[#21140a]",
                day_today: "border border-amber-300/60 text-amber-200",
                day_disabled: "text-[#6c5a47] opacity-35",
                day_outside: "text-[#6c5a47] opacity-35",
              }}
            />
          </PopoverContent>
        </Popover>
      );
    }

    if (question.kind === "consent") {
      return (
        <label className="mt-7 flex cursor-pointer items-start gap-3 rounded-xl border border-[#59432d]/70 bg-[#100b07]/55 p-4 text-sm leading-6 text-[#e7d8c5]">
          <input
            checked={currentValue === true}
            className="mt-1 size-4 shrink-0 accent-amber-400"
            data-testid={`field-${question.key}`}
            onChange={(event) => updateAnswer(question.key, event.target.checked)}
            type="checkbox"
          />
          <span>{question.description}</span>
        </label>
      );
    }

    const inputType = question.kind === "email"
      ? "email"
      : question.kind === "phone"
        ? "tel"
        : "text";
    return (
      <input
        className="mt-7 min-h-14 w-full rounded-xl border border-[#59432d]/70 bg-[#100b07]/70 px-4 text-base text-[#fff3df] outline-none transition placeholder:text-[#9f8c75] focus:border-amber-300/80 focus:ring-2 focus:ring-amber-300/20"
        data-testid={`field-${question.key}`}
        maxLength={question.kind === "phone" ? 24 : undefined}
        onChange={(event) => updateAnswer(question.key, event.target.value)}
        placeholder={question.placeholder}
        type={inputType}
        value={typeof currentValue === "string" ? currentValue : ""}
      />
    );
  }

  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-[#100b07] px-4 py-8 text-[#f4e9d8] sm:px-8 sm:py-12">
      <div className="pointer-events-none absolute -left-32 top-10 size-80 rounded-full bg-amber-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-28 bottom-8 size-80 rounded-full bg-emerald-700/10 blur-3xl" />

      <section className="relative w-full max-w-[760px] overflow-hidden rounded-[26px] border border-[#624725]/50 bg-[#19110b]/95 shadow-[0_30px_100px_rgba(0,0,0,0.42)]">
        {complete ? (
          <div className="px-6 py-10 text-center sm:px-10 sm:py-12" data-testid="counselling-success">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-emerald-300/40 bg-emerald-400/10 text-2xl text-emerald-200" aria-hidden="true">
              ✓
            </div>
            <h1 className="mt-6 font-serif text-[2rem] font-semibold leading-[1.12] tracking-[-0.025em] text-[#fff3df] sm:text-[2.8rem]">
              Thank you! Aapka form submit ho gaya hai.
            </h1>
            <div className="mx-auto mt-6 max-w-[620px] space-y-4 text-[15px] leading-7 text-[#d2c2ad] sm:text-base">
              <p>Hamari team aapki preferred visit date aur time ki availability check karke aapko confirmation degi.</p>
              <p>Hum aapse jald hi connect karenge. See you soon at Aroma Institute! ☕</p>
            </div>
          </div>
        ) : !started ? (
          <div className="px-6 py-8 sm:px-10 sm:py-10">
            <h1 className="text-center font-serif text-[2rem] font-semibold leading-[1.12] tracking-[-0.025em] text-[#fff3df] sm:text-[2.8rem]">
              Aapke Barista Career Ki Shuruaat Yahan Se!
            </h1>
            <div className="mt-6 space-y-4 text-center text-[15px] leading-7 text-[#d2c2ad] sm:text-base">
              <p>Hi! Aroma LEAP mein interest dikhane ke liye thank you!</p>
              <p>Agar aap Barista banna chahte ho, café industry mein career banana chahte ho, ya apni first job ke liye practical skills seekhna chahte ho, toh yeh counselling session aapke liye hai.</p>
              <p>Is form mein apne baare mein batao, taaki hamara counsellor aapki situation samajh sake, aapke questions answer kar sake aur guide kar sake ki Aroma LEAP aapke liye right fit hai ya nahi.</p>
              <p>Yeh questionnaire fill karne mein sirf 4–6 minutes lagenge.</p>
            </div>
            <div className="mt-7 flex justify-center border-t border-[#59432d]/50 pt-6">
              <button
                className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-amber-400 px-6 text-sm font-bold text-[#21140a] transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:ring-offset-2 focus:ring-offset-[#19110b]"
                data-testid="start-counselling"
                onClick={() => setStarted(true)}
                type="button"
              >
                Get started <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        ) : (
          <form
            className="px-6 py-8 sm:px-10 sm:py-10"
            data-testid="counselling-form"
            onSubmit={handleStepSubmit}
          >
            <div data-testid="question-step" data-question-number={question.number}>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-300">
                {question.section}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[#ad9b84]">
                  Question {question.number} of 29
                </span>
                {!question.required && (
                  <span className="rounded-full border border-[#59432d]/70 px-2.5 py-1 text-[11px] font-medium text-[#b9a68f]">
                    Optional
                  </span>
                )}
              </div>
              <h1 className="mt-3 font-serif text-[1.65rem] font-semibold leading-[1.2] tracking-[-0.02em] text-[#fff3df] sm:text-[2.15rem]">
                {question.prompt}
              </h1>
              {question.description && question.kind !== "consent" && (
                <p className="mt-4 max-w-[620px] text-sm leading-6 text-[#cbb9a2]">
                  {question.description}
                </p>
              )}
              {renderQuestionInput()}
              {questionError && (
                <p className="mt-3 text-sm font-medium text-rose-300" role="alert" data-testid="question-error">
                  {questionError}
                </p>
              )}
              {submitError && (
                <p className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200" role="alert" data-testid="submit-error">
                  {submitError}
                </p>
              )}
            </div>

            <div className="mt-8 flex flex-col-reverse gap-3 border-t border-[#59432d]/50 pt-6 sm:flex-row sm:items-center sm:justify-between">
              {step > 0 ? (
                <button
                  className="inline-flex min-h-12 items-center justify-center rounded-xl border border-[#70583c] px-5 text-sm font-semibold text-[#e7d8c5] transition hover:bg-[#2a1d12] focus:outline-none focus:ring-2 focus:ring-amber-200"
                  data-testid="previous-question"
                  onClick={() => {
                    setStep((current) => Math.max(0, current - 1));
                    setQuestionError("");
                    setSubmitError("");
                  }}
                  type="button"
                >
                  ← Back
                </button>
              ) : (
                <span />
              )}
              <button
                className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-amber-400 px-6 text-sm font-bold text-[#21140a] transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:ring-offset-2 focus:ring-offset-[#19110b] disabled:cursor-not-allowed disabled:opacity-60"
                data-testid={isLastQuestion ? "submit-counselling" : "next-question"}
                disabled={submitting}
                type="submit"
              >
                {submitting ? "Submitting..." : isLastQuestion ? "Submit request" : "Continue"}
                {!submitting && <span aria-hidden="true">{isLastQuestion ? "✓" : "→"}</span>}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
