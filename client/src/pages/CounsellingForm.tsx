import { useState, type FormEvent } from "react";
import { apiRequest } from "@/lib/queryClient";
import {
  counsellingAnswersSchema,
  insertInquirySchema,
  type CounsellingAnswers,
} from "@shared/schema";

type AnswerKey = keyof CounsellingAnswers;
type Choice = { value: string; label: string; note?: string };
type Question = {
  key: AnswerKey;
  eyebrow: string;
  title: string;
  description: string;
  choices?: Choice[];
};

const questions: Question[] = [
  {
    key: "ageRange",
    eyebrow: "A little about you",
    title: "Aap kis age group mein aate ho?",
    description: "Aroma LEAP ka focus 18–24 age group par hai. Agar aap is range ke bahar hain, counsellor suitability clarify kar sakta hai.",
    choices: [
      { value: "under18", label: "18 se kam" },
      { value: "18to20", label: "18–20 years" },
      { value: "21to24", label: "21–24 years" },
      { value: "25plus", label: "25 years ya usse zyada" },
    ],
  },
  {
    key: "currentSituation",
    eyebrow: "Aapka starting point",
    title: "Abhi aapki current situation kya hai?",
    description: "Jo aapke liye sabse sahi ho, woh choose karein.",
    choices: [
      { value: "completed12th", label: "12th complete kiya hai" },
      { value: "college", label: "College mein padh raha/rahi hoon" },
      { value: "graduated", label: "Graduation complete hai" },
      { value: "workingOther", label: "Kisi aur field mein kaam kar raha/rahi hoon" },
      { value: "other", label: "Kuch aur" },
    ],
  },
  {
    key: "coffeeExperience",
    eyebrow: "Coffee se pehchaan",
    title: "Coffee ya café work ka aapko kitna experience hai?",
    description: "Experience hona zaroori nahi — bas humein aapka starting point samajhna hai.",
    choices: [
      { value: "none", label: "Abhi tak koi experience nahi" },
      { value: "personal", label: "Personal interest ya home brewing" },
      { value: "internship", label: "Internship ya short training" },
      { value: "professional", label: "Professional café experience" },
    ],
  },
  {
    key: "careerGoal",
    eyebrow: "Aage ka plan",
    title: "Aroma LEAP se aap kya achieve karna chahte ho?",
    description: "Aapka goal badal sakta hai — abhi jo sabse relevant lagta hai woh batayein.",
    choices: [
      { value: "firstCafeJob", label: "Apni first café job paana" },
      { value: "careerChange", label: "Career change karke café industry mein aana" },
      { value: "buildSkills", label: "Barista skills build karna" },
      { value: "openCafe", label: "Future mein apna café kholna" },
      { value: "explore", label: "Abhi options explore kar raha/rahi hoon" },
    ],
  },
  {
    key: "scheduleReadiness",
    eyebrow: "Time commitment",
    title: "Program schedule ko lekar aap kahan tak ready ho?",
    description: "Counsellor aapke routine ke hisaab se details discuss kar sakta hai.",
    choices: [
      { value: "ready", label: "Main schedule ke liye ready hoon" },
      { value: "needDetails", label: "Pehle schedule ki details chahiye" },
      { value: "unsure", label: "Abhi sure nahi hoon" },
    ],
  },
  {
    key: "counsellingTopics",
    eyebrow: "Counselling mein",
    title: "Aap kin topics par baat karna chahte ho?",
    description: "Ek ya zyada choose karein, taaki counsellor sahi preparation ke saath aaye.",
    choices: [
      { value: "programSchedule", label: "Program schedule aur format" },
      { value: "internshipTerms", label: "Internship aur uski terms" },
      { value: "skillsCertification", label: "Skills aur certification" },
      { value: "careerPreparation", label: "Career preparation aur job opportunities" },
      { value: "feesScholarshipPayment", label: "Fees, scholarship ya payment options" },
      { value: "parentGuardian", label: "Parent/guardian ke questions" },
    ],
  },
  {
    key: "guardianInvolvement",
    eyebrow: "Support system",
    title: "Kya aap chahenge ki parent ya guardian counselling mein join karein?",
    description: "Yeh optional hai — aap apni preference baad mein bhi change kar sakte hain.",
    choices: [
      { value: "yes", label: "Haan, unhe join karna chahiye" },
      { value: "maybe", label: "Maybe, pehle unse discuss karunga/karungi" },
      { value: "no", label: "Nahi, main khud baat karna chahunga/chahungi" },
    ],
  },
];

function ChoiceCard({
  name,
  value,
  checked,
  label,
  onChange,
  multiple = false,
  index,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  onChange: () => void;
  multiple?: boolean;
  index: number;
}) {
  return (
    <label
      data-testid={`option-${name}-${value}`}
      className={`group flex min-h-[58px] cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition duration-200 ${
        checked
          ? "border-amber-400/70 bg-amber-300/[0.11] text-amber-50"
          : "border-[#614522]/60 bg-[#21170f] text-[#e8d9c6] hover:border-amber-500/50 hover:bg-[#2a1d12]"
      }`}
    >
      <input
        className="h-[18px] w-[18px] shrink-0 accent-amber-400"
        type={multiple ? "checkbox" : "radio"}
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        data-testid={`input-${name}-${index}`}
      />
      <span className="text-[15px] leading-snug">{label}</span>
      <span
        aria-hidden="true"
        className={`ml-auto flex h-5 w-5 items-center justify-center rounded-full border text-[11px] transition ${
          checked ? "border-amber-300 bg-amber-300 text-[#21140b]" : "border-[#80603c]/70 text-transparent"
        }`}
      >
        ✓
      </span>
    </label>
  );
}

export default function CounsellingForm() {
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial<CounsellingAnswers>>({
    counsellingTopics: [],
    additionalQuestion: "",
  });
  const [contact, setContact] = useState({ name: "", email: "", phone: "" });
  const [contactError, setContactError] = useState("");
  const [questionError, setQuestionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [complete, setComplete] = useState(false);

  const totalSteps = questions.length + 2;
  const question = questions[step];
  const isTopics = question?.key === "counsellingTopics";
  const isAdditional = step === questions.length;
  const isContact = step === questions.length + 1;

  function answerChoice(key: AnswerKey, value: string) {
    setQuestionError("");
    if (key === "counsellingTopics") {
      const current = (answers.counsellingTopics as string[] | undefined) ?? [];
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      setAnswers((previous) => ({ ...previous, counsellingTopics: next as CounsellingAnswers["counsellingTopics"] }));
      return;
    }
    setAnswers((previous) => ({ ...previous, [key]: value }));
  }

  function validateCurrentStep() {
    if (question) {
      const value = answers[question.key];
      if (question.key === "counsellingTopics") {
        if (!Array.isArray(value) || value.length === 0) {
          setQuestionError("Aage badhne ke liye kam se kam ek topic choose karein.");
          return false;
        }
      } else if (!value) {
        setQuestionError("Aage badhne ke liye ek option choose karein.");
        return false;
      }
    }
    if (isContact) {
      const parsed = insertInquirySchema.safeParse({
        ...contact,
        programInterest: "Aroma LEAP",
        message: "Aroma LEAP counselling questionnaire completed.",
        counsellingAnswers: counsellingAnswersSchema.safeParse(answers).success ? answers : undefined,
      });
      if (!contact.name.trim() || !contact.email.trim() || !contact.phone.trim()) {
        setContactError("Please fill in your name, email and phone number.");
        return false;
      }
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        setContactError(first?.message ?? "Please check your contact details.");
        return false;
      }
    }
    return true;
  }

  function nextStep() {
    setQuestionError("");
    setContactError("");
    if (!validateCurrentStep()) return;
    setStep((current) => Math.min(current + 1, totalSteps - 1));
  }

  function previousStep() {
    setQuestionError("");
    setContactError("");
    setStep((current) => Math.max(0, current - 1));
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    setContactError("");
    if (!validateCurrentStep()) return;
    const parsedAnswers = counsellingAnswersSchema.safeParse(answers);
    if (!parsedAnswers.success) {
      setSubmitError("Kuch answers missing hain. Ek step peeche jaakar check karein.");
      return;
    }
    const parsedInquiry = insertInquirySchema.safeParse({
      ...contact,
      name: contact.name.trim(),
      email: contact.email.trim(),
      phone: contact.phone.trim(),
      programInterest: "Aroma LEAP",
      message: "Aroma LEAP counselling questionnaire completed.",
      counsellingAnswers: parsedAnswers.data,
    });
    if (!parsedInquiry.success) {
      setContactError(parsedInquiry.error.issues[0]?.message ?? "Please check your details.");
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/inquiries", parsedInquiry.data);
      setComplete(true);
    } catch {
      setSubmitError("Form submit nahi ho paaya. Apna internet check karke phir try karein.");
    } finally {
      setSubmitting(false);
    }
  }

  const whatsappMessage = encodeURIComponent(
    "Hi Aroma team, maine Aroma LEAP counselling questionnaire complete kiya hai. Main counselling ke liye follow up karna chahta/chahti hoon.",
  );

  return (
    <main
      className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-[#100b07] px-4 py-8 text-[#f4e9d8] sm:px-8 sm:py-12"
      data-testid="page-counselling-form"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 top-[-7rem] h-[28rem] w-[28rem] rounded-full bg-amber-700/[0.09] blur-[100px]" />
        <div className="absolute -right-40 bottom-[-10rem] h-[34rem] w-[34rem] rounded-full bg-orange-950/30 blur-[110px]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
      </div>
      <section className="relative w-full max-w-[760px] overflow-hidden rounded-[26px] border border-[#624725]/50 bg-[#19110b]/95 shadow-[0_30px_100px_rgba(0,0,0,0.42)]">
        {!started && !complete && (
          <div className="px-6 py-8 sm:px-10 sm:py-10">
            <h1 className="font-serif text-[2rem] font-semibold leading-[1.12] tracking-[-0.025em] text-[#fff3df] sm:text-[2.8rem] text-center">
              Aroma LEAP™ mein interest dikhane ke liye thank you!
            </h1>
            <div className="mt-6 max-w-[620px] space-y-4 text-[15px] leading-7 text-[#d2c2ad] sm:text-base">
              <p className="text-center">
                Agar aap Barista banna chahte ho, café industry mein career banana chahte ho, ya apni first job ke liye practical skills seekhna chahte ho, toh yeh counselling session aapke liye hai.
              </p>
              <p className="text-center">
                Is short form mein humein apne baare mein thoda batao, taaki hamara counsellor aapki current situation samajh sake, aapke questions ke answers de sake aur guide kar sake ki Aroma LEAP aapke liye right fit hai ya nahi.
              </p>
            </div>
            <div className="mt-7 flex flex-col gap-4 border-t border-[#59432d]/50 pt-6 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-[#c9b69d]">
                Yeh questionnaire fill karne mein sirf 4–6 minutes lagenge.
              </p>
              <button
                type="button"
                data-testid="navigation-start"
                onClick={() => setStarted(true)}
                className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-amber-400 px-6 text-sm font-bold text-[#21140a] transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:ring-offset-2 focus:ring-offset-[#19110b]"
              >
                Get started <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        )}

        {started && !complete && (
          <form
            onSubmit={isContact ? submitForm : (event) => event.preventDefault()}
            className="px-6 py-8 sm:px-10 sm:py-10"
          >
            {question && (
              <div data-testid="question-step" className="animate-in fade-in duration-300">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-400">{question.eyebrow}</p>
                <h1 className="mt-3 max-w-[620px] font-serif text-[1.8rem] font-semibold leading-tight text-[#fff3df] sm:text-[2.25rem]">
                  {question.title}
                </h1>
                <p className="mt-3 max-w-[580px] text-sm leading-6 text-[#bfae98] sm:text-[15px]">{question.description}</p>
                <fieldset className="mt-7 space-y-2.5">
                  <legend className="sr-only">{question.title}</legend>
                  {question.choices?.map((choice, index) => {
                    const key = question.key;
                    const selected = key === "counsellingTopics"
                      ? ((answers.counsellingTopics as string[] | undefined) ?? []).includes(choice.value)
                      : answers[key] === choice.value;
                    return (
                      <ChoiceCard
                        key={choice.value}
                        name={key}
                        value={choice.value}
                        label={choice.label}
                        checked={selected}
                        index={index}
                        multiple={isTopics}
                        onChange={() => answerChoice(key, choice.value)}
                      />
                    );
                  })}
                </fieldset>
                {isTopics && (
                  <p className="mt-3 text-xs text-[#9c8971]">Aapke liye relevant sabhi topics select karein.</p>
                )}
                {questionError && <p role="alert" className="mt-4 text-sm text-[#ffb5a8]">{questionError}</p>}
              </div>
            )}

            {isAdditional && (
              <div data-testid="question-step" className="animate-in fade-in duration-300">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-400">Aapke sawaal</p>
                <h1 className="mt-3 font-serif text-[1.8rem] font-semibold leading-tight text-[#fff3df] sm:text-[2.25rem]">
                  Counsellor ke liye koi sawaal ya note?
                </h1>
                <p className="mt-3 text-sm leading-6 text-[#bfae98] sm:text-[15px]">
                  Optional hai. Jo bhi poochna chahte hain, yahan likh dein.
                </p>
                <label htmlFor="additional-question" className="sr-only">Additional question</label>
                <textarea
                  id="additional-question"
                  data-testid="field-additional-question"
                  rows={5}
                  maxLength={500}
                  value={answers.additionalQuestion ?? ""}
                  onChange={(event) => setAnswers((previous) => ({ ...previous, additionalQuestion: event.target.value }))}
                  placeholder="Apna sawaal yahan likhein..."
                  className="mt-7 w-full resize-y rounded-xl border border-[#614522]/60 bg-[#21170f] px-4 py-3 text-[15px] leading-6 text-[#f2e6d6] placeholder:text-[#806d57] focus:border-amber-400/80 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
                />
                <p className="mt-2 text-right font-mono text-xs text-[#9c8971]">{(answers.additionalQuestion ?? "").length}/500</p>
              </div>
            )}

            {isContact && (
              <div data-testid="question-step" className="animate-in fade-in duration-300">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-400">Last step</p>
                <h1 className="mt-3 font-serif text-[1.8rem] font-semibold leading-tight text-[#fff3df] sm:text-[2.25rem]">
                  Counselling ke liye aapse kaise contact karein?
                </h1>
                <p className="mt-3 max-w-[560px] text-sm leading-6 text-[#bfae98] sm:text-[15px]">
                  Apni contact details share karein. Aroma counsellor aapke answers ke context mein aapse baat karega.
                </p>
                <div className="mt-7 space-y-4">
                  <div>
                    <label htmlFor="contact-name" className="mb-2 block text-sm font-medium text-[#ead9c2]">Full name</label>
                    <input
                      id="contact-name"
                      data-testid="contact-name"
                      autoComplete="name"
                      required
                      minLength={2}
                      value={contact.name}
                      onChange={(event) => setContact((current) => ({ ...current, name: event.target.value }))}
                      className="min-h-12 w-full rounded-xl border border-[#614522]/60 bg-[#21170f] px-4 text-[15px] text-[#f2e6d6] placeholder:text-[#806d57] focus:border-amber-400/80 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
                      placeholder="Aapka naam"
                    />
                  </div>
                  <div>
                    <label htmlFor="contact-email" className="mb-2 block text-sm font-medium text-[#ead9c2]">Email address</label>
                    <input
                      id="contact-email"
                      data-testid="contact-email"
                      type="email"
                      autoComplete="email"
                      required
                      value={contact.email}
                      onChange={(event) => setContact((current) => ({ ...current, email: event.target.value }))}
                      className="min-h-12 w-full rounded-xl border border-[#614522]/60 bg-[#21170f] px-4 text-[15px] text-[#f2e6d6] placeholder:text-[#806d57] focus:border-amber-400/80 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
                      placeholder="you@example.com"
                    />
                  </div>
                  <div>
                    <label htmlFor="contact-phone" className="mb-2 block text-sm font-medium text-[#ead9c2]">Phone number</label>
                    <input
                      id="contact-phone"
                      data-testid="contact-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      required
                      minLength={10}
                      value={contact.phone}
                      onChange={(event) => setContact((current) => ({ ...current, phone: event.target.value }))}
                      className="min-h-12 w-full rounded-xl border border-[#614522]/60 bg-[#21170f] px-4 text-[15px] text-[#f2e6d6] placeholder:text-[#806d57] focus:border-amber-400/80 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
                      placeholder="+91"
                    />
                  </div>
                </div>
                <p className="mt-4 text-xs leading-5 text-[#9c8971]">Counselling follow-up ke liye contact details dein. Sensitive financial ya personal information ki zaroorat nahi hai.</p>
                {contactError && <p role="alert" className="mt-4 text-sm text-[#ffb5a8]">{contactError}</p>}
                {submitError && <p role="alert" className="mt-3 rounded-lg border border-[#9a4a39]/50 bg-[#54251c]/30 px-3 py-2 text-sm text-[#ffc1b5]">{submitError}</p>}
              </div>
            )}

            <div className="mt-8 flex items-center justify-between gap-3 border-t border-[#59432d]/50 pt-5">
              <button
                type="button"
                data-testid="navigation-back"
                onClick={previousStep}
                disabled={step === 0 || submitting}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-[#c5b39b] transition hover:bg-[#302114] hover:text-[#fff3df] disabled:invisible"
              >
                <span aria-hidden="true">←</span> Back
              </button>
              {!isContact ? (
                <button
                  type="button"
                  data-testid="navigation-next"
                  onClick={nextStep}
                  className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-amber-400 px-6 text-sm font-bold text-[#21140a] transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:ring-offset-2 focus:ring-offset-[#19110b]"
                >
                  {isAdditional ? "Contact details" : "Continue"} <span aria-hidden="true">→</span>
                </button>
              ) : (
                <button
                  type="submit"
                  data-testid="navigation-submit"
                  disabled={submitting}
                  className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-amber-400 px-6 text-sm font-bold text-[#21140a] transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-200 focus:ring-offset-2 focus:ring-offset-[#19110b] disabled:cursor-wait disabled:opacity-60"
                >
                  {submitting ? "Submitting..." : "Counselling request bhejein"}
                  {!submitting && <span aria-hidden="true">→</span>}
                </button>
              )}
            </div>
          </form>
        )}

        {complete && (
          <div data-testid="success-state" className="px-6 py-12 text-center sm:px-12 sm:py-16">
            <div aria-hidden="true" className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-amber-300/40 bg-amber-300/10 text-2xl text-amber-300">✓</div>
            <p className="mt-6 text-xs font-bold uppercase tracking-[0.2em] text-amber-400">Aapka next step</p>
            <h1 className="mx-auto mt-3 max-w-xl font-serif text-[2rem] font-semibold leading-tight text-[#fff3df] sm:text-[2.6rem]">
              Thank you. Counselling request mil gayi.
            </h1>
            <p className="mx-auto mt-4 max-w-lg text-[15px] leading-7 text-[#c9b69d]">
              Aapki request save ho gayi hai. Counselling appointment arrange karne ke liye WhatsApp chatbot ko message bhejein.
            </p>
            <a
              data-testid="success-whatsapp"
              href={`https://wa.me/919274868669?text=${whatsappMessage}`}
              target="_blank"
              rel="noreferrer"
              className="mt-8 inline-flex min-h-12 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-400/[0.08] px-5 text-sm font-semibold text-amber-200 transition hover:border-amber-300/70 hover:bg-amber-300/[0.14] focus:outline-none focus:ring-2 focus:ring-amber-200"
            >
              WhatsApp par appointment book karein
            </a>
            <p className="mt-4 text-xs text-[#907c64]">WhatsApp follow-up optional hai.</p>
          </div>
        )}
      </section>
    </main>
  );
}
