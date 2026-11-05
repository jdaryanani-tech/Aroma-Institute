import { counsellingQuestions } from "@/pages/counsellingQuestions";

export const CRM_STAGE_LABELS: Record<string, string> = {
  new_enquiry: "New enquiry",
  contacted: "Contacted",
  qualified: "Qualified",
  vsl_shared: "VSL shared",
  vsl_watched: "VSL watched",
  form_submitted: "Form submitted",
  counselling_pending: "Counselling pending",
  counselling_booked: "Counselling booked",
  counselling_attended: "Counselling attended",
  enrolled: "Enrolled",
  nurture: "Nurture",
  lost: "Lost",
};

const counsellingValueLabels: Record<string, string> = {
  under18: "Under 18", "18to20": "18–20", "21to24": "21–24", "25plus": "25 or older",
  completed12th: "Completed 12th standard", college: "Studying in college", graduated: "Graduated",
  workingOther: "Working in another field", other: "Other", none: "No prior experience",
  personal: "Personal or hobby experience", internship: "Café internship experience",
  professional: "Professional café experience", firstCafeJob: "First café job",
  careerChange: "Career change", buildSkills: "Build barista skills", openCafe: "Explore opening a café",
  explore: "Explore the career", ready: "Ready to discuss the program", needDetails: "Would like schedule details",
  unsure: "Not sure yet", programSchedule: "Program schedule", internshipTerms: "Internship and stipend terms",
  skillsCertification: "Skills and certification", careerPreparation: "Career preparation and placement assistance",
  feesScholarshipPayment: "Fees, scholarship, and payment options", parentGuardian: "Parent or guardian participation",
  yes: "Yes", maybe: "Maybe", no: "No",
};

export const counsellingFieldLabels: Record<string, string> = {
  ...Object.fromEntries(counsellingQuestions.map((question) => [question.key, `${question.number}. ${question.prompt}`])),
  currentSituation: "Current situation",
  coffeeExperience: "Coffee or café experience",
  careerGoal: "Career goal",
  scheduleReadiness: "Program and schedule readiness",
  counsellingTopics: "Topics to discuss",
  guardianInvolvement: "Parent or guardian involvement",
  additionalQuestion: "Note for the counsellor",
};

export function formatCounsellingAnswer(key: string, value: unknown): string {
  const question = counsellingQuestions.find((item) => item.key === key);
  const formatOne = (entry: unknown) => {
    const token = String(entry);
    return question?.choices?.find((choice) => choice.value === token)?.label ?? counsellingValueLabels[token] ?? token;
  };
  if (Array.isArray(value)) return value.map(formatOne).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "string" || !value) return "—";
  return formatOne(value);
}

export function formatDate(value: string | null | undefined, includeTime = false): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

export function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
