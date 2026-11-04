import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CounsellingDeliveryAttemptRecord, type Inquiry } from "@shared/schema";
import { LogOut, Download, Users, Mail, Phone, BookOpen, MessageSquare } from "lucide-react";
import { useLocation } from "wouter";
import { useLmsLogout, useLmsSession } from "@/hooks/use-lms";
import { apiRequest } from "@/lib/queryClient";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { counsellingQuestions } from "./counsellingQuestions";

const counsellingFieldLabels: Record<string, string> = {
  ...Object.fromEntries(
    counsellingQuestions.map((question) => [
      question.key,
      `${question.number}. ${question.prompt}`,
    ]),
  ),
  currentSituation: "Current situation",
  coffeeExperience: "Coffee or café experience",
  careerGoal: "Career goal",
  scheduleReadiness: "Program and schedule readiness",
  counsellingTopics: "Topics to discuss",
  guardianInvolvement: "Parent or guardian involvement",
  additionalQuestion: "Note for the counsellor",
};

const counsellingValueLabels: Record<string, string> = {
  under18: "Under 18",
  "18to20": "18–20",
  "21to24": "21–24",
  "25plus": "25 or older",
  completed12th: "Completed 12th standard",
  college: "Studying in college",
  graduated: "Graduated",
  workingOther: "Working in another field",
  other: "Other",
  none: "No prior experience",
  personal: "Personal or hobby experience",
  internship: "Café internship experience",
  professional: "Professional café experience",
  firstCafeJob: "First café job",
  careerChange: "Career change",
  buildSkills: "Build barista skills",
  openCafe: "Explore opening a café",
  explore: "Explore the career",
  ready: "Ready to discuss the program",
  needDetails: "Would like schedule details",
  unsure: "Not sure yet",
  programSchedule: "Program schedule",
  internshipTerms: "Internship and stipend terms",
  skillsCertification: "Skills and certification",
  careerPreparation: "Career preparation and placement assistance",
  feesScholarshipPayment: "Fees, scholarship, and payment options",
  parentGuardian: "Parent or guardian participation",
  yes: "Yes",
  maybe: "Maybe",
  no: "No",
};

type AdminInquiry = Inquiry & {
  deliveryAttemptHistory: CounsellingDeliveryAttemptRecord[];
};

function formatCounsellingAnswer(key: string, value: unknown): string {
  const question = counsellingQuestions.find((item) => item.key === key);
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const token = String(entry);
      return question?.choices?.find((choice) => choice.value === token)?.label
        ?? counsellingValueLabels[token]
        ?? token;
    }).join(", ");
  }
  if (typeof value === "boolean") return value ? "Haan" : "Nahi";
  if (typeof value !== "string" || !value) return "—";
  return question?.choices?.find((choice) => choice.value === value)?.label
    ?? counsellingValueLabels[value]
    ?? value;
}

async function fetchInquiries(): Promise<AdminInquiry[]> {
  const res = await fetch("/api/admin/inquiries", { credentials: "include" });
  if (!res.ok) throw new Error(res.status === 403 ? "Administrator access required." : "Unable to load inquiries.");
  return res.json();
}

function deliveryStatusLabel(
  status: Inquiry["counsellingDeliveryStatus"],
  hasCounsellingAnswers: boolean,
) {
  if (status === "not_applicable" && hasCounsellingAnswers) {
    return "Not tracked (older inquiry)";
  }
  switch (status) {
    case "not_applicable": return "Not a counselling inquiry";
    case "untracked": return "Not tracked (older inquiry)";
    case "pending": return "Pending";
    case "sending":
    case "retrying": return "Sending";
    case "acknowledged": return "Acknowledged";
    case "sent": return "Earlier 2xx (ack not verified)";
    case "failed": return "Failed";
  }
}

function formatDeliveryTimestamp(value: Inquiry["counsellingDeliveryLastAttemptAt"]) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function exportCSV(data: Inquiry[]) {
  const headers = ["ID", "Name", "Email", "Phone", "Program Interest", "Message", "Counselling Answers"];
  const rows = data.map((r) => [
    r.id,
    r.name,
    r.email,
    r.phone,
    r.programInterest,
    r.message ?? "",
    r.counsellingAnswers ? JSON.stringify(r.counsellingAnswers) : "",
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aroma-leads-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Admin() {
  const session = useLmsSession();
  const logout = useLmsLogout();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [retryTargetId, setRetryTargetId] = useState<number | null>(null);
  const [verifiedNotDelivered, setVerifiedNotDelivered] = useState(false);
  const isAdmin = Boolean(session.data?.roles.includes("admin"));
  const { data, isLoading, isError } = useQuery<AdminInquiry[]>({
    queryKey: ["/api/admin/inquiries"],
    queryFn: fetchInquiries,
    enabled: isAdmin,
    retry: false,
  });
  const retryDelivery = useMutation({
    mutationFn: async ({ inquiryId }: { inquiryId: number }) => {
      const response = await apiRequest(
        "POST",
        `/api/admin/inquiries/${inquiryId}/retry-counselling-delivery`,
        { verifiedNotDelivered: true },
      );
      return response.json();
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/inquiries"] });
    },
  });

  const handleLogout = () => {
    logout.mutate(undefined, { onSuccess: () => setLocation("/learn") });
  };

  const handleRetryDialogChange = (open: boolean) => {
    if (!open) {
      setRetryTargetId(null);
      setVerifiedNotDelivered(false);
    }
  };

  if (session.isLoading) {
    return (
      <div className="min-h-screen bg-[#0e0a07] flex items-center justify-center px-4" data-testid="page-admin-login">
        <p className="text-white/60">Checking administrator access…</p>
      </div>
    );
  }
  if (session.isError || !session.data || !isAdmin) {
    return (
      <div className="min-h-screen bg-[#0e0a07] flex items-center justify-center px-4" data-testid="page-admin-login">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-white font-serif text-2xl font-bold">Leads Dashboard</h1>
          <p className="text-white/55 text-sm mt-2" role={session.data && !isAdmin ? "alert" : undefined}>
            {session.isError
              ? "We could not verify your session."
              : session.data
                ? "Access denied. This account does not have Leads Dashboard administrator access."
                : "Sign in with your Aroma Institute account to continue."}
          </p>
          <a href="/admin/login" className="inline-flex mt-6 h-11 items-center justify-center rounded-lg bg-amber-400 px-5 font-bold text-[#0e0a07]">
            Continue to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white" data-testid="page-admin-dashboard">
      {/* Top bar */}
      <div className="border-b border-white/10 bg-[#0e0a07]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-serif font-bold text-lg text-white leading-none">Leads Dashboard</h1>
            <p className="text-white/40 text-xs mt-0.5">Aroma Institute of Cafe & Hospitality Management</p>
          </div>
          <div className="flex items-center gap-3">
            {data && data.length > 0 && (
              <button
                onClick={() => exportCSV(data)}
                className="flex items-center gap-2 bg-white/8 hover:bg-white/12 border border-white/15 text-white/80 text-sm px-4 py-2 rounded-lg transition-colors"
                data-testid="admin-button-export"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </button>
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-white/50 hover:text-white/80 text-sm px-3 py-2 rounded-lg transition-colors"
              data-testid="admin-button-logout"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {isError && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">
            Unable to load the leads dashboard. Check your administrator session and try again.
          </div>
        )}
        {/* Stats */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
            {[
              { icon: Users, label: "Total Leads", value: data.length },
              {
                icon: BookOpen,
                label: "Programs",
                value: new Set(data.map((d) => d.programInterest)).size,
              },
              {
                icon: MessageSquare,
                label: "With Message",
                value: data.filter((d) => d.message).length,
              },
              {
                icon: Mail,
                label: "Latest Lead",
                value: data[0]?.name?.split(" ")[0] ?? "—",
              },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-4" data-testid={`stat-${label.toLowerCase().replace(/ /g, "-")}`}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="h-4 w-4 text-amber-400" />
                  <span className="text-white/50 text-xs uppercase tracking-wide">{label}</span>
                </div>
                <p className="text-white font-bold text-xl">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="text-center py-20 text-white/40">Loading leads...</div>
        ) : data && data.length === 0 ? (
          <div className="text-center py-20 text-white/40">No leads yet.</div>
        ) : data ? (
          <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-leads-table">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">#</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Name</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Email</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Phone</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Program</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Message</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Webhook delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((lead, i) => (
                    <tr
                      key={lead.id}
                      className={`border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors`}
                      data-testid={`lead-row-${lead.id}`}
                    >
                      <td className="px-5 py-4 text-white/30 text-xs">{lead.id}</td>
                      <td className="px-5 py-4 font-medium text-white">{lead.name}</td>
                      <td className="px-5 py-4">
                        {lead.email ? (
                          <a href={`mailto:${lead.email}`} className="text-amber-400/80 hover:text-amber-400 transition-colors flex items-center gap-1.5">
                            <Mail className="h-3 w-3 shrink-0" />
                            {lead.email}
                          </a>
                        ) : (
                          <span className="text-white/30">—</span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <a href={`tel:${lead.phone}`} className="text-white/70 hover:text-white transition-colors flex items-center gap-1.5">
                          <Phone className="h-3 w-3 shrink-0" />
                          {lead.phone}
                        </a>
                      </td>
                      <td className="px-5 py-4">
                        <span className="inline-block bg-amber-400/10 border border-amber-400/20 text-amber-400 text-xs px-2.5 py-1 rounded-full whitespace-nowrap">
                          {lead.programInterest}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-white/50 max-w-sm whitespace-normal">
                        <p>{lead.message || <span className="text-white/20 italic">—</span>}</p>
                        {lead.counsellingAnswers && (
                          <details className="mt-2">
                            <summary
                              className="cursor-pointer text-xs font-semibold text-amber-400 hover:text-amber-300"
                              data-testid={`lead-questionnaire-${lead.id}`}
                            >
                              View counselling answers
                            </summary>
                            <dl className="mt-3 space-y-2 text-xs">
                              {Object.entries(lead.counsellingAnswers)
                                .filter(([, value]) => value !== undefined && value !== "")
                                .map(([key, value]) => (
                                  <div key={key}>
                                    <dt className="font-semibold text-white/70">
                                      {counsellingFieldLabels[key] ?? key}
                                    </dt>
                                    <dd className="mt-0.5 break-words text-white/50">
                                      {formatCounsellingAnswer(key, value)}
                                    </dd>
                                  </div>
                                ))}
                            </dl>
                          </details>
                        )}
                      </td>
                      <td className="px-5 py-4 min-w-56">
                        {lead.counsellingAnswers ? (
                          <div className="space-y-1.5">
                            <p className={`font-semibold ${
                              lead.counsellingDeliveryStatus === "failed"
                                ? "text-red-300"
                                : lead.counsellingDeliveryStatus === "acknowledged"
                                  ? "text-emerald-300"
                                  : lead.counsellingDeliveryStatus === "pending"
                                    ? "text-amber-200"
                                    : "text-white/70"
                            }`}>
                              {deliveryStatusLabel(
                                lead.counsellingDeliveryStatus,
                                Boolean(lead.counsellingAnswers),
                              )}
                            </p>
                            {lead.counsellingDeliveryAttempts > 0 && (
                              <p className="text-xs text-white/45">
                                Attempts: {lead.counsellingDeliveryAttempts}
                              </p>
                            )}
                            {formatDeliveryTimestamp(lead.counsellingDeliveryLastAttemptAt) && (
                              <p className="text-xs text-white/45">
                                Last attempt: {formatDeliveryTimestamp(lead.counsellingDeliveryLastAttemptAt)}
                              </p>
                            )}
                            {lead.counsellingDeliveryLastResult && (
                              <p className="text-xs text-white/55">
                                Latest result: {lead.counsellingDeliveryLastResult}
                              </p>
                            )}
                            {lead.deliveryAttemptHistory.length > 0 && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs font-semibold text-white/55 hover:text-white/80">
                                  Delivery attempt history ({lead.deliveryAttemptHistory.length})
                                </summary>
                                <ol className="mt-2 space-y-2 text-xs text-white/55">
                                  {lead.deliveryAttemptHistory.map((attempt) => (
                                    <li key={attempt.id} className="rounded-md border border-white/10 p-2">
                                      <p className="font-semibold text-white/75">
                                        Attempt {attempt.attemptNumber}: {deliveryStatusLabel(
                                          attempt.deliveryState,
                                          true,
                                        )}
                                      </p>
                                      <p>Started: {formatDeliveryTimestamp(attempt.attemptedAt) ?? "—"}</p>
                                      <p>Response: {formatDeliveryTimestamp(attempt.responseAt) ?? "No HTTP response"}</p>
                                      {attempt.httpStatus !== null && <p>HTTP status: {attempt.httpStatus}</p>}
                                      {attempt.errorSummary && <p>Error: {attempt.errorSummary}</p>}
                                    </li>
                                  ))}
                                </ol>
                              </details>
                            )}
                            {formatDeliveryTimestamp(lead.counsellingDeliveryLastVerifiedAt) && (
                              <p className="text-xs text-white/45">
                                Admin verification: {formatDeliveryTimestamp(lead.counsellingDeliveryLastVerifiedAt)}
                              </p>
                            )}
                            {(lead.counsellingDeliveryStatus === "untracked"
                              || lead.counsellingDeliveryStatus === "not_applicable") && (
                              <p className="text-xs text-white/40">
                                Delivery outcome was not recorded. Do not resend; ask the lead to submit the form again.
                              </p>
                            )}
                            {lead.counsellingDeliveryStatus === "failed" && (
                              <button
                                type="button"
                                className="mt-1 rounded-md border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={retryDelivery.isPending && retryDelivery.variables?.inquiryId === lead.id}
                                onClick={() => {
                                  setRetryTargetId(lead.id);
                                  setVerifiedNotDelivered(false);
                                }}
                                data-testid={`admin-retry-counselling-${lead.id}`}
                              >
                                {retryDelivery.isPending && retryDelivery.variables?.inquiryId === lead.id
                                  ? "Retrying…"
                                  : "Review & retry"}
                              </button>
                            )}
                            {retryDelivery.isError && retryDelivery.variables?.inquiryId === lead.id && (
                              <p className="text-xs text-red-300" role="alert">
                                {retryDelivery.error instanceof Error
                                  ? retryDelivery.error.message
                                  : "Retry could not be started."}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-white/30">Not applicable</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
      <AlertDialog
        open={retryTargetId !== null}
        onOpenChange={handleRetryDialogChange}
      >
        <AlertDialogContent className="border-[#624725]/60 bg-[#19110b] text-[#fff3df]">
          <AlertDialogHeader>
            <AlertDialogTitle>Verify before resending</AlertDialogTitle>
            <AlertDialogDescription className="text-[#d2c2ad]">
              This sends the saved inquiry again using its existing submission ID. It will not create another inquiry. Check AVNI/Supabase first; only continue if this submission is not already there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-3 text-sm leading-6 text-[#e7d8c5]">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-amber-400"
              checked={verifiedNotDelivered}
              onChange={(event) => setVerifiedNotDelivered(event.target.checked)}
              data-testid="admin-confirm-not-delivered"
            />
            I verified this is the correct lead and confirmed it has not already been received by AVNI/Supabase.
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retryDelivery.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!verifiedNotDelivered || retryDelivery.isPending || retryTargetId === null}
              onClick={() => {
                if (verifiedNotDelivered && retryTargetId !== null) {
                  retryDelivery.mutate({ inquiryId: retryTargetId });
                }
              }}
              data-testid="admin-confirm-retry"
            >
              {retryDelivery.isPending ? "Sending…" : "Resend saved inquiry"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
