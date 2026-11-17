import { useEffect, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowRight, CalendarClock, Check, ChevronDown, Clock3, Coffee, LogOut, Mail, MessageCircle, MessageCircleOff, Phone, Search, ShieldCheck, SlidersHorizontal, Users, VideoOff, X } from "lucide-react";
import { useLocation } from "wouter";
import { useLmsLogout, useLmsSession } from "@/hooks/use-lms";
import type { CrmAssignmentUpdate, CrmCapabilities, CrmDetail, CrmLead, CrmMetaCaptureStatus, CrmSourceAnalytics, CrmStage, CrmUpdate } from "@shared/crm";
import { CRM_STAGES } from "@shared/crm";
import { ADMISSIONS_MANUAL_CRM_STAGES } from "@shared/crm";
import { CrmHttpError, fetchCrmConversationPage, useCrmAssignment, useCrmDetail, useCrmLeads, useCrmMetaCaptureStatus, useCrmRetry, useCrmUpdate } from "@/crm/api";
import { CRM_STAGE_LABELS, counsellingFieldLabels, formatCounsellingAnswer, formatDate, toLocalInput } from "@/crm/format";
import { crmUiPermissions } from "@/crm/permissions";
import MetaSetupStatus from "@/crm/MetaSetupStatus";
import MetaCaptureStatusPanel from "@/crm/MetaCaptureStatusPanel";
import AvniProductionDiagnostics from "@/crm/AvniProductionDiagnostics";

type Filters = { q: string; stage: string; program: string; source: string; dateFrom: string; dateTo: string; followUp: string; assignee: string; sort: string; page: number; pageSize: number };
type AvniHealth = {
  schema: Record<string,boolean> & {ready:boolean};
  webhook: {urlPresent:boolean;urlValid:boolean;secretPresent:boolean;dispatchRequested:boolean;dispatcherActive:boolean};
  outbox: Record<string,number> | null;
};
const defaultFilters: Filters = { q: "", stage: "", program: "", source: "", dateFrom: "", dateTo: "", followUp: "", assignee: "", sort: "recent", page: 1, pageSize: 12 };
const stages = Object.keys(CRM_STAGES) as CrmStage[];
const stageHelp = "Rates describe funnel records; they do not establish that one step caused another.";

function clearPrivateCache(client: ReturnType<typeof useQueryClient>) {
  client.removeQueries({ predicate: (query) => {
    const key = query.queryKey[0];
    return key === "admin-crm" || key === "aichm-calendar" || key === "/api/admin/inquiries" || (typeof key === "string" && key.startsWith("/api/admin/inquiries?"));
  } });
}
function errorText(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function identityText(status: CrmLead["identityStatus"]) {
  return status === "linked" ? "Linked identity" : status === "unique_phone" ? "Unique phone" : status === "ambiguous" ? "Ambiguous match" : "Unmatched record";
}
function stageOrigin(lead: CrmLead) {
  if (lead.stageSource === "verified_video") return "Verified video";
  if (lead.stageSource === "verified_form") return "Verified form";
  if (lead.stageSource === "admin" && (lead.stageEvidence?.selfReported === true || lead.stageEvidence?.kind === "prospect_confirmation")) return "Self-reported";
  if (lead.stageSource === "admin") return "Staff updated";
  return "New record";
}

export default function Admin() {
  const session = useLmsSession();
  const logout = useLmsLogout();
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const permissions = crmUiPermissions(session.data?.roles);
  const isAdmin = permissions.canManageAssignments;
  const isAdmissions = permissions.canUseCrm && !isAdmin;
  const hasCrmAccess = permissions.canUseCrm;
  const retryDialogRef = useRef<HTMLElement | null>(null);
  const detailReturnFocus = useRef<HTMLButtonElement | null>(null);
  const detailDialogOpen = useRef(false);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [accessCheckBlocked, setAccessCheckBlocked] = useState(false);
  const [retryTarget, setRetryTarget] = useState<number | null>(null);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [retryPersonConfirmed, setRetryPersonConfirmed] = useState(false);
  const [retryError, setRetryError] = useState("");
  const crmScope = isAdmin ? "admin" : `admissions:${session.data?.id ?? "unknown"}`;
  const previousCrmScope = useRef<string | null>(null);
  const leadsQuery = useCrmLeads(filters, hasCrmAccess && !accessCheckBlocked, crmScope);
  const detailQuery = useCrmDetail(selectedId, hasCrmAccess && !accessCheckBlocked, crmScope);
  const metaCaptureStatusQuery = useCrmMetaCaptureStatus(
    selectedId,
    isAdmin && !accessCheckBlocked,
    crmScope,
  );
  const avniHealthQuery=useQuery<AvniHealth>({
    queryKey:["admin-crm","avni-health"],
    enabled:isAdmin&&!accessCheckBlocked,
    retry:false,
    staleTime:15_000,
    queryFn:async()=>{
      const response=await fetch("/api/admin/crm/avni-health",{credentials:"same-origin",cache:"no-store"});
      if(!response.ok) throw new Error("Integration readiness could not be loaded.");
      return response.json();
    },
  });
  const sourceAnalyticsQuery = useQuery<CrmSourceAnalytics>({
    queryKey: ["admin-crm", "source-analytics"],
    enabled: isAdmin && !accessCheckBlocked,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch("/api/admin/crm/source-analytics", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Source analytics could not be loaded.");
      return response.json();
    },
  });
  const update = useCrmUpdate();
  const assignment = useCrmAssignment();
  const retry = useCrmRetry();
  const leads = leadsQuery.data?.items ?? [];
  const lead = detailQuery.data?.lead;
  const crmForbidden = [leadsQuery.error, detailQuery.error].some(
    (error) => error instanceof CrmHttpError && (error.status === 401 || error.status === 403),
  );

  useEffect(() => {
    if (!session.data) return;
    if (previousCrmScope.current === null) {
      previousCrmScope.current = crmScope;
      return;
    }
    if (previousCrmScope.current === crmScope) return;
    clearPrivateCache(client);
    setSelectedId(null);
    setMobileDetail(false);
    setAccessCheckBlocked(false);
    if (!isAdmin) setFilters((current) => ({ ...current, assignee: "" }));
    previousCrmScope.current = crmScope;
  }, [crmScope, isAdmin, client, session.data]);
  useEffect(() => {
    if (!selectedId && leads.length) setSelectedId(leads[0].id);
    else if (selectedId && leads.length && !leads.some((item) => item.id === selectedId) && !detailQuery.isLoading) setSelectedId(leads[0].id);
  }, [leads, selectedId, detailQuery.isLoading]);
  useEffect(() => {
    if (!hasCrmAccess || !crmForbidden || accessCheckBlocked) return;
    setAccessCheckBlocked(true);
    clearPrivateCache(client);
    setSelectedId(null);
    setMobileDetail(false);
    void session.refetch();
  }, [hasCrmAccess, crmForbidden, accessCheckBlocked, client, session.refetch]);
  useEffect(() => {
    if (retryTarget === null) return;
    const dialog = retryDialogRef.current;
    dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !retry.isPending) {
        event.preventDefault();
        setRetryTarget(null);
      }
      if (event.key === "Tab" && dialog) {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [retryTarget, retry.isPending]);
  useEffect(() => {
    if (!mobileDetail) {
      if (detailDialogOpen.current) detailReturnFocus.current?.focus();
      detailDialogOpen.current = false;
      return;
    }
    detailDialogOpen.current = true;
    if (retryTarget !== null) return;
    const panel = document.querySelector<HTMLElement>('[data-testid="crm-detail"]');
    const close = panel?.querySelector<HTMLElement>(".crm-mobile-close");
    (close ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileDetail(false);
      }
      if (event.key === "Tab" && panel) {
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileDetail, selectedId, detailQuery.isLoading, retryTarget]);

  const setFilter = (key: keyof Filters, value: string) => setFilters((current) => ({ ...current, [key]: value, page: 1 }));
  const reset = () => setFilters(defaultFilters);
  const signOut = () => logout.mutate(undefined, { onSuccess: () => { clearPrivateCache(client); setLocation("/admin/login"); } });
  const selectLead = (id: string, trigger: HTMLButtonElement) => {
    detailReturnFocus.current = trigger;
    setSelectedId(id);
    setMobileDetail(window.matchMedia("(max-width: 800px)").matches);
  };
  if (session.isLoading) return <main className="crm-app"><div className="crm-empty" aria-live="polite"><div className="crm-skeleton" /><strong>Checking admissions access</strong><p>Keeping prospect information private.</p></div></main>;
  if (session.isError || !session.data || !hasCrmAccess) return (
    <main className="crm-app" data-testid="page-admin-login"><section className="crm-empty" style={{ minHeight: "100dvh", justifyContent: "center" }}>
      <span className="crm-brand-mark">A.</span><p className="crm-eyebrow" style={{ marginTop: 18 }}>Aroma Institute</p><strong>Admissions access</strong>
      <p role={session.data && !hasCrmAccess ? "alert" : undefined}>{session.isError ? "We could not verify your session." : session.data ? "Access denied. This account does not have CRM access." : "Sign in with your Aroma Institute account to continue."}</p>
      <a className="crm-button crm-button-primary" href="/admin/login" style={{ marginTop: 14, textDecoration: "none" }}>Continue to sign in</a>
    </section></main>
  );
  if (accessCheckBlocked || crmForbidden) return (
    <main className="crm-app" data-testid="page-admin-access-refresh">
      <section className="crm-empty" style={{ minHeight: "100dvh", justifyContent: "center" }} role="alert">
        <ShieldCheck size={27} />
        <strong>Admissions access needs to be checked again.</strong>
        <p>Applicant details have been hidden and removed from this page. Your administrator session is being refreshed. Sign in again to continue.</p>
        <a className="crm-button crm-button-primary" href="/admin/login" style={{ marginTop: 12, textDecoration: "none" }}>Continue to sign in</a>
      </section>
    </main>
  );

  const overview = leadsQuery.data?.overview;
  const caps = leadsQuery.data?.capabilities;
  const canWrite = Boolean(caps?.crmPersistence);
  const totalPages = Math.max(1, leadsQuery.data?.totalPages ?? 1);
  return (
    <main className="crm-app" data-testid="page-admin-dashboard">
      <header className="crm-topbar"><div className="crm-wrap crm-topbar-inner">
        <div className="crm-brand"><span className="crm-brand-mark" aria-hidden="true">A.</span><div className="crm-brand-copy"><strong>AICHM Admissions</strong><span>Prospect desk · Aroma Institute</span></div></div>
        <div className="crm-top-actions">{isAdmin && <a className="crm-button crm-button-quiet" href="/admin/calendar"><CalendarClock size={15} /> Calendar</a>}<span className="crm-connection-tag">{caps?.chatHistory ? <MessageCircle size={13} /> : <MessageCircleOff size={13} />}{caps?.chatHistory ? " WhatsApp history configured" : " Supabase reader setup needed"}</span>
          <button className="crm-button crm-button-quiet" type="button" onClick={signOut} disabled={logout.isPending} data-testid="admin-button-logout"><LogOut size={16} />{logout.isPending ? "Signing out" : "Sign out"}</button>
        </div>
      </div></header>
      <div className="crm-wrap crm-main">
        <section className="crm-heading-row"><div><p className="crm-eyebrow">{isAdmin ? "Admissions workspace" : "Assigned admissions workspace"}</p><h1 className="crm-heading">People, not just enquiries.</h1><p className="crm-subheading">{isAdmin ? "Keep the next conversation clear, grounded, and easy to pick up. Counts cover all records, independent of filters." : "Work only with leads assigned to your account. Counts and search results are limited to those assignments."}</p></div>{isAdmin && <a className="crm-connection-tag" href="/admin/calendar"><CalendarClock size={13} /> Open internal calendar</a>}</section>
        {logout.isError && <div className="crm-error" role="alert">Sign out did not complete. Your administrator session may still be active; try again before leaving this device.</div>}
        {isAdmin && <section className="crm-counts" aria-labelledby="avni-health-title" data-testid="avni-integration-health">
          <div className="crm-count" style={{gridColumn:"1 / -1"}}>
            <span className="crm-count-label">AVNI integration</span>
            <strong id="avni-health-title" className="crm-count-value" style={{fontSize:"1.25rem"}}>
              {avniHealthQuery.isLoading?"Checking readiness":avniHealthQuery.isError?"Status unavailable":avniHealthQuery.data?.schema.ready&&avniHealthQuery.data?.webhook.dispatcherActive?"Ready to dispatch":"Needs setup"}
            </strong>
            {avniHealthQuery.data&&<span className="crm-count-note">
              Schema {avniHealthQuery.data.schema.ready?"ready":"needs migration"} · n8n URL {avniHealthQuery.data.webhook.urlValid?"valid":"missing or invalid"} · shared secret {avniHealthQuery.data.webhook.secretPresent?"present":"missing"} · dispatcher {avniHealthQuery.data.webhook.dispatcherActive?"enabled":"disabled"}
              {avniHealthQuery.data.outbox&&` · Queue: ${avniHealthQuery.data.outbox.pending??0} pending, ${avniHealthQuery.data.outbox.failed??0} failed, ${avniHealthQuery.data.outbox.acknowledged??0} acknowledged`}
            </span>}
            {avniHealthQuery.isError&&<span className="crm-count-note">Refresh the dashboard or check the production integration settings. No secret values are displayed here.</span>}
          </div>
        </section>}
        {isAdmin && <AvniProductionDiagnostics />}
        {isAdmin && <MetaSetupStatus />}
        {leadsQuery.isError && <div className="crm-error" role="alert"><strong>Admissions records did not load.</strong> {errorText(leadsQuery.error, "Check your connection and administrator access.")}<button className="crm-text-button" type="button" onClick={() => void leadsQuery.refetch()}>Try again</button></div>}
        {overview && <section className="crm-counts" aria-label={isAdmin ? "Global admissions overview" : "Assigned leads overview"}>
          <div className="crm-count"><span className="crm-count-label">Identified people</span><strong className="crm-count-value">{overview.identifiedPeople.toLocaleString()}</strong><span className="crm-count-note">{overview.unresolvedRecords.toLocaleString()} ambiguous or unmatchable records excluded</span></div>
          <div className="crm-count"><span className="crm-count-label">Total enquiries</span><strong className="crm-count-value">{overview.totalEnquiries.toLocaleString()}</strong><span className="crm-count-note">All recorded submissions</span></div>
          <div className="crm-count"><span className="crm-count-label">Video watched</span><strong className="crm-count-value">{overview.videoWatched.toLocaleString()}</strong><span className="crm-count-note">Observed playback milestones; not a stage label</span></div>
          <div className="crm-count"><span className="crm-count-label">Verified forms</span><strong className="crm-count-value">{overview.verifiedForms.toLocaleString()}</strong><span className="crm-count-note">{overview.registeredWithoutForm.toLocaleString()} registered; form not yet recorded</span></div>
          <div className="crm-count"><span className="crm-count-label">Enrolled stage</span><strong className="crm-count-value">{overview.stageCounts.enrolled.toLocaleString()}</strong><span className="crm-count-note crm-rate">{overview.enrolledPercent === null ? "Rate unavailable" : `${overview.enrolledPercent.toFixed(1)}% descriptive rate`}</span></div>
        </section>}
        {isAdmin && <section className="crm-source-analytics" aria-labelledby="crm-source-analytics-title" data-testid="crm-source-analytics">
          <div className="crm-source-analytics-header">
            <div>
              <p className="crm-eyebrow">All-time · administrator view</p>
              <h2 id="crm-source-analytics-title">Admissions source analytics</h2>
            </div>
            {sourceAnalyticsQuery.data && <time className="crm-source-analytics-updated" dateTime={sourceAnalyticsQuery.data.lastUpdatedAt}>
              Updated {new Date(sourceAnalyticsQuery.data.lastUpdatedAt).toLocaleString()}
            </time>}
          </div>
          {sourceAnalyticsQuery.isLoading
            ? <p className="crm-results-caption">Loading aggregate source counts…</p>
            : sourceAnalyticsQuery.isError
              ? <p className="crm-error" role="status">Source analytics are temporarily unavailable.</p>
              : sourceAnalyticsQuery.data && <>
                <div className="crm-source-analytics-summary">
                  <div><span>Enquiries / submissions</span><strong>{sourceAnalyticsQuery.data.totalEnquiries.toLocaleString()}</strong></div>
                  <div><span>Identified people</span><strong>{sourceAnalyticsQuery.data.identifiedPeople.toLocaleString()}</strong></div>
                  <div><span>Unresolved records</span><strong>{sourceAnalyticsQuery.data.unresolvedRecords.toLocaleString()}</strong></div>
                  <div><span>Duplicate submissions</span><strong>{sourceAnalyticsQuery.data.duplicateTracking === "tracked" && sourceAnalyticsQuery.data.duplicateSubmissions !== null
                    ? sourceAnalyticsQuery.data.duplicateSubmissions.toLocaleString()
                    : "Not tracked"}</strong></div>
                </div>
                <p className="crm-source-analytics-note">{sourceAnalyticsQuery.data.duplicateExplanation}</p>
                <div className="crm-source-analytics-table-wrap">
                  <table className="crm-source-analytics-table">
                    <caption>Each saved enquiry is assigned to exactly one primary source bucket. Source people counts are distinct within each bucket and may overlap between buckets.</caption>
                    <thead><tr><th scope="col">Primary source</th><th scope="col">Enquiries</th><th scope="col">Identified people</th></tr></thead>
                    <tbody>{sourceAnalyticsQuery.data.sources.map(source => <tr key={source.source}>
                      <th scope="row">{({
                        meta_lead_ads: "Meta Lead Ads",
                        whatsapp: "WhatsApp",
                        website: "Website",
                        manual: "Manual",
                        other: "Other",
                        unknown: "Unknown",
                      } as const)[source.source]}</th>
                      <td>{source.enquiries.toLocaleString()}</td>
                      <td>{source.identifiedPeople.toLocaleString()}</td>
                    </tr>)}</tbody>
                    <tfoot><tr><th scope="row">Total enquiries</th><td>{sourceAnalyticsQuery.data.totalEnquiries.toLocaleString()}</td><td aria-label="Distinct people across all sources">{sourceAnalyticsQuery.data.identifiedPeople.toLocaleString()}</td></tr></tfoot>
                  </table>
                </div>
                <p className="crm-source-analytics-note">{sourceAnalyticsQuery.data.attributionMethod}</p>
              </>}
        </section>}
        {overview && <p className="crm-results-caption" style={{ margin: "-12px 0 18px" }}>{isAdmin ? stageHelp : "Counts cover only leads assigned to your account."}{overview.registeredToFormPercent !== null && <> Registered-to-form: {overview.registeredToFormPercent.toFixed(1)}% descriptive rate.</>}</p>}
        {(leadsQuery.data?.warnings ?? []).map((warning, index) => <div className="crm-warning" role="status" key={`${index}-${warning}`}><AlertTriangle size={16} /><span>{warning}</span></div>)}
        {caps && (!caps.identityTracking || !caps.videoTracking || !caps.crmPersistence || !caps.calendarBookingVerification || !caps.canonicalAssignments) && <div className="crm-warning" role="status"><ShieldCheck size={16} /><span>{[
          !caps.identityTracking && "Identity linking is unavailable; similar submissions may remain unresolved.",
          !caps.videoTracking && "VSL milestones are not connected; video-watch transitions require the prospect's exact confirmation.",
          !caps.crmPersistence && "CRM persistence is unavailable. Profile writes are disabled.",
          !caps.canonicalAssignments && "Canonical assignment schema is unavailable; admissions access is disabled until it is installed.",
          !caps.calendarBookingVerification && "Counselling booking cannot be verified. Do not mark a booking based on an unverified calendar.",
        ].filter(Boolean).join(" ")}</span></div>}
        <div className="crm-workspace">
          <section className="crm-list-panel" aria-label="Admissions leads">
            <div className="crm-filterbar">
              <div className="crm-search-wrap"><Search size={17} aria-hidden="true" /><input className="crm-input crm-search" type="search" placeholder="Name, phone, email…" value={filters.q} onChange={(event) => setFilter("q", event.target.value)} aria-label="Search leads" data-testid="crm-search" /></div>
              <details className="crm-filter-drawer">
                <summary><SlidersHorizontal size={14} /> Filters <ChevronDown size={13} /></summary>
                <div className="crm-filter-drawer-body">
                  <div className="crm-filter-grid">
                    <select className="crm-select" aria-label="Filter by stage" value={filters.stage} onChange={(event) => setFilter("stage", event.target.value)} data-testid="crm-filter-stage"><option value="">Every stage</option>{stages.map((item) => <option key={item} value={item}>{CRM_STAGE_LABELS[item]}</option>)}</select>
                    <select className="crm-select" aria-label="Filter by program" value={filters.program} onChange={(event) => setFilter("program", event.target.value)}><option value="">Every program</option>{(leadsQuery.data?.options.programs ?? []).map((item) => <option value={item} key={item}>{item}</option>)}</select>
                    <select className="crm-select" aria-label="Filter by source" value={filters.source} onChange={(event) => setFilter("source", event.target.value)}><option value="">Every source</option>{(leadsQuery.data?.options.sources ?? []).map((item) => <option value={item} key={item}>{item}</option>)}</select>
                    <select className="crm-select" aria-label="Follow-up status" value={filters.followUp} onChange={(event) => setFilter("followUp", event.target.value)} data-testid="crm-followup"><option value="">Any follow-up</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="upcoming">Upcoming</option><option value="none">No follow-up</option></select>
                     {isAdmin && <select className="crm-select" aria-label="Filter by assignee" value={filters.assignee} onChange={(event) => setFilter("assignee", event.target.value)} data-testid="crm-assignee-filter"><option value="">Every assignee</option><option value="unassigned">Unassigned</option>{(leadsQuery.data?.options.assignees ?? []).map((item) => <option value={String(item.id)} key={item.id}>{item.name}</option>)}</select>}
                    <select className="crm-select" aria-label="Sort leads" value={filters.sort} onChange={(event) => setFilter("sort", event.target.value)}><option value="recent">Recently active</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option><option value="followup">Follow-up soonest</option></select>
                  </div>
                  <details style={{ marginTop: 8 }}><summary className="crm-text-button" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}><SlidersHorizontal size={14} /> Date range <ChevronDown size={13} /></summary>
                    <div className="crm-filter-grid" style={{ marginTop: 7 }}><label className="crm-field"><span className="crm-field-label">From</span><input className="crm-input" type="date" value={filters.dateFrom} onChange={(event) => setFilter("dateFrom", event.target.value)} /></label><label className="crm-field"><span className="crm-field-label">To</span><input className="crm-input" type="date" value={filters.dateTo} onChange={(event) => setFilter("dateTo", event.target.value)} /></label></div>
                  </details>
                </div>
              </details>
              <div className="crm-filter-actions"><span className="crm-results-caption">{leadsQuery.data ? `${leadsQuery.data.total.toLocaleString()} matches` : "Loading matches"}</span><button className="crm-text-button" type="button" onClick={reset}>Clear filters</button></div>
            </div>
            <div className="crm-lead-list" aria-live="polite">
              {leadsQuery.isLoading ? <><div className="crm-skeleton" /><div className="crm-skeleton" /><div className="crm-skeleton" /></> : leadsQuery.data && !leads.length ? <div className="crm-empty"><Users size={23} /><strong>No people match these filters</strong><p>{isAdmin ? "Try another stage, assignee, or search. New enquiries appear here when recorded." : "Only leads assigned to your account are shown here."}</p><button type="button" className="crm-button" onClick={reset}>{isAdmin ? "Show all records" : "Show assigned leads"}</button></div> : leads.map((item) => (
                <button className="crm-lead-card" type="button" key={item.id} onClick={(event) => selectLead(item.id, event.currentTarget)} aria-current={item.id === selectedId} data-testid="crm-lead-card">
                  <span className="crm-lead-card-head"><span><span className="crm-lead-name">{item.name || "Name not recorded"}</span><span className="crm-lead-meta">{item.phone || item.email || "No contact details"}{item.phone && item.email ? ` · ${item.email}` : ""}</span></span>{item.followUpAt && <span className="crm-follow-flag"><Clock3 size={13} />{formatDate(item.followUpAt)}</span>}</span>
                  <span className="crm-lead-foot"><span className="crm-stage-pill" data-stage={item.stage}>{CRM_STAGE_LABELS[item.stage]}</span><span className="crm-stage-source">{stageOrigin(item)}</span><span className="crm-card-program">{item.programs[0] || "Program not recorded"} · {isAdmin ? item.assigneeName || "Unassigned" : "Assigned to you"}</span></span>
                </button>
              ))}
            </div>
            <div className="crm-list-footer"><span className="crm-results-caption">{leadsQuery.data ? `Page ${leadsQuery.data.page} of ${totalPages}` : ""}</span><div className="crm-page-controls">
              <button className="crm-page-button" type="button" aria-label="Previous page" disabled={filters.page <= 1 || leadsQuery.isFetching} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}><ArrowLeft size={16} /></button><span className="crm-page-number">{leadsQuery.data ? `${leadsQuery.data.page} / ${totalPages}` : "—"}</span>
              <button className="crm-page-button" type="button" aria-label="Next page" data-testid="crm-next-page" disabled={filters.page >= totalPages || leadsQuery.isFetching} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}><ArrowRight size={16} /></button>
            </div></div>
          </section>
          <section
            className={`crm-detail-panel ${mobileDetail ? "crm-detail-open" : ""}`}
            role={mobileDetail && retryTarget === null ? "dialog" : undefined}
            aria-modal={mobileDetail && retryTarget === null ? true : undefined}
            aria-labelledby={mobileDetail && retryTarget === null && lead ? "crm-detail-title" : undefined}
            aria-hidden={retryTarget !== null ? true : undefined}
            tabIndex={mobileDetail ? -1 : undefined}
            aria-label={mobileDetail ? (lead?.name ? `${lead.name} details` : "Loading prospect details") : "Selected person"}
            data-testid="crm-detail"
          >
            {detailQuery.isLoading ? <div className="crm-empty"><button className="crm-button crm-mobile-close" type="button" onClick={() => setMobileDetail(false)}><X size={16} /> Close prospect detail</button><div className="crm-skeleton" /><strong>Opening prospect record</strong></div> : detailQuery.isError ? <div className="crm-empty"><button className="crm-button crm-mobile-close" type="button" onClick={() => setMobileDetail(false)}><X size={16} /> Close prospect detail</button><AlertTriangle size={22} /><strong>Could not open this record</strong><p>{errorText(detailQuery.error, "Try loading it again.")}</p><button className="crm-button" type="button" onClick={() => void detailQuery.refetch()}>Try again</button></div> : lead && detailQuery.data ? <LeadDetail
              lead={lead} detail={detailQuery.data} assignees={leadsQuery.data?.options.assignees ?? []} capabilities={detailQuery.data.capabilities} canWrite={canWrite && detailQuery.data.capabilities.crmPersistence}
              metaCaptureStatus={metaCaptureStatusQuery.data ?? []} metaCaptureStatusLoading={metaCaptureStatusQuery.isLoading} metaCaptureStatusError={metaCaptureStatusQuery.isError}
              scopeKey={crmScope}
              isAdmin={isAdmin} isAdmissions={isAdmissions}
              pending={update.isPending} updateError={update.isError ? errorText(update.error, "The profile could not be saved.") : ""}
              onSave={(patch) => update.mutate({ id: lead.id, update: patch })}
              assignmentPending={assignment.isPending} assignmentError={assignment.isError ? errorText(assignment.error, "The assignment could not be saved.") : ""}
              onAssign={(update) => {
                if (lead.leadId) assignment.mutate({ leadId: lead.leadId, update });
              }}
              onRetry={(id) => { setRetryTarget(id); setRetryConfirmed(false); setRetryPersonConfirmed(false); setRetryError(""); }}
              retryPending={retry.isPending} retryError={retryError || (retry.isError ? errorText(retry.error, "Retry could not be started.") : "")}
              retryId={retry.variables} onClose={() => setMobileDetail(false)}
            /> : <div className="crm-empty"><Coffee size={24} /><strong>Select a person</strong><p>Choose a lead to see contact history, verified journey, and next actions.</p></div>}
          </section>
        </div>
      </div>
      {isAdmin && retryTarget !== null && <div className="crm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !retry.isPending) setRetryTarget(null); }}>
        <section ref={retryDialogRef} className="crm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="retry-title" aria-describedby="retry-copy">
          <h2 id="retry-title">Verify before resending</h2><p id="retry-copy">This resends the saved counselling inquiry using its existing submission ID; it will not create another inquiry. Check AVNI/Supabase first. Continue only if the correct prospect’s submission has not already arrived.</p>
          <label className="crm-checkline"><input type="checkbox" checked={retryPersonConfirmed} onChange={(event) => setRetryPersonConfirmed(event.target.checked)} /><span>I confirmed this is the correct prospect and inquiry.</span></label>
          <label className="crm-checkline"><input type="checkbox" checked={retryConfirmed} onChange={(event) => setRetryConfirmed(event.target.checked)} /><span>I checked downstream and verified this submission has not been received by AVNI/Supabase.</span></label>
          {retryError && <div className="crm-error" role="alert">{retryError}</div>}
          <div className="crm-dialog-actions"><button className="crm-button" type="button" disabled={retry.isPending} onClick={() => setRetryTarget(null)}>Cancel</button><button className="crm-button crm-button-primary" type="button" disabled={!retryConfirmed || !retryPersonConfirmed || retry.isPending} data-testid="admin-confirm-retry" onClick={() => {
            if (retryTarget !== null && retryConfirmed && retryPersonConfirmed) retry.mutate(retryTarget, { onSuccess: () => { setRetryError("Retry submitted. Status refreshes from the server."); setRetryTarget(null); } });
          }}>{retry.isPending ? "Resending" : "Resend saved inquiry"}</button></div>
        </section>
      </div>}
    </main>
  );
}

function LeadDetail(props: {
  lead: CrmLead; detail: CrmDetail; assignees: { id: number; name: string }[]; capabilities: CrmCapabilities;
  metaCaptureStatus: CrmMetaCaptureStatus[]; metaCaptureStatusLoading: boolean; metaCaptureStatusError: boolean;
  isAdmin: boolean; isAdmissions: boolean; scopeKey: string; canWrite: boolean; pending: boolean; updateError: string;
  assignmentPending: boolean; assignmentError: string; onAssign: (update: CrmAssignmentUpdate) => void;
  onSave: (patch: CrmUpdate) => void; onRetry: (id: number) => void; retryPending: boolean; retryError: string; retryId: number | undefined; onClose: () => void;
}) {
  const { lead, detail } = props;
  const [stage, setStage] = useState<CrmStage>(lead.stage);
  const [assignee, setAssignee] = useState(lead.assigneeUserId === null ? "" : String(lead.assigneeUserId));
  const [assignmentReason, setAssignmentReason] = useState("");
  const assignmentRequestId = useRef<string | null>(null);
  const [followUp, setFollowUp] = useState(toLocalInput(lead.followUpAt));
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceKind, setEvidenceKind] = useState<"tracked_video" | "prospect_confirmation">(props.capabilities.videoTracking ? "tracked_video" : "prospect_confirmation");
  const [reference, setReference] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [savingVersion, setSavingVersion] = useState<number | null>(null);
  const [olderConversationHistoryRequested, setOlderConversationHistoryRequested] = useState(false);
  const conversationHistoryQuery = useInfiniteQuery({
    queryKey: ["admin-crm", props.scopeKey, "conversation-pages", lead.id, detail.conversationHistory.nextCursor],
    initialPageParam: detail.conversationHistory.nextCursor ?? "",
    queryFn: ({ pageParam }) => fetchCrmConversationPage(lead.id, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: olderConversationHistoryRequested && Boolean(detail.conversationHistory.nextCursor),
    retry: false,
  });
  useEffect(() => {
    setStage(lead.stage); setAssignee(lead.assigneeUserId === null ? "" : String(lead.assigneeUserId)); setAssignmentReason(""); setFollowUp(toLocalInput(lead.followUpAt));
    setNote(""); setReason(""); setEvidenceKind(props.capabilities.videoTracking ? "tracked_video" : "prospect_confirmation"); setReference(""); setOccurredAt(""); setConfirmed(false); setSaveMessage(""); setSavingVersion(null);
    setOlderConversationHistoryRequested(false);
  }, [lead.id, lead.version, props.capabilities.videoTracking]);
  useEffect(() => {
    setAssignee(lead.assigneeUserId === null ? "" : String(lead.assigneeUserId));
    setAssignmentReason("");
    assignmentRequestId.current = null;
  }, [lead.id, lead.assignmentVersion, lead.assigneeUserId]);
  useEffect(() => {
    if (savingVersion !== null && lead.version !== savingVersion) { setSaveMessage("Saved and recorded in the activity log."); setNote(""); setReason(""); setSavingVersion(null); }
  }, [lead.version, savingVersion]);
  const stageChanged = stage !== lead.stage;
  const followChanged = followUp !== toLocalInput(lead.followUpAt);
  const dirty = stageChanged || followChanged || Boolean(note.trim());
  const selectableStages = props.isAdmin ? stages : ADMISSIONS_MANUAL_CRM_STAGES as readonly CrmStage[];
  const selectableStageSet = new Set<CrmStage>(selectableStages);
  const blocked = !props.canWrite || (stage === "counselling_booked" && stageChanged && !lead.hasVerifiedCalendarBooking) || (stage === "form_submitted" && stageChanged && !lead.hasVerifiedForm);
  let evidenceError = "";
  if (stageChanged && reason.trim().length < 3) evidenceError = "Add a reason of at least 3 characters for this stage change.";
  if (stageChanged && stage === "vsl_shared" && (!confirmed || reference.trim().length < 3 || !occurredAt)) evidenceError = "Confirm the link was actually sent, add an external message reference of at least 3 characters, and record when it happened.";
  if (stageChanged && stage === "counselling_booked" && !lead.hasVerifiedCalendarBooking) evidenceError = "A persisted AICHM Calendar booking is required. A date preference or webhook receipt is not a booking.";
  if (stageChanged && stage === "vsl_watched" && evidenceKind === "tracked_video" && !reference.trim()) evidenceError = "Add the tracked video record reference. The server verifies the viewing milestone.";
  if (stageChanged && stage === "vsl_watched" && evidenceKind === "prospect_confirmation" && (reference.trim().length < 10 || !occurredAt)) evidenceError = "Record the prospect’s clear self-reported quote (at least 10 characters) and when they said it.";
  if (stageChanged && (stage === "counselling_attended" || stage === "enrolled") && (!confirmed || reference.trim().length < 10 || !occurredAt)) evidenceError = "Confirm the staff record and provide a reference of at least 10 characters and occurrence time.";
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || blocked || evidenceError) return;
    const patch: CrmUpdate = { expectedVersion: lead.version };
    if (stageChanged) patch.stage = stage;
    if (followChanged) patch.followUpAt = followUp ? new Date(followUp).toISOString() : null;
    if (note.trim()) patch.note = note.trim();
    if (stageChanged) {
      patch.reason = reason.trim();
      if (stage === "vsl_shared") patch.evidence = { kind: "link_sent", reference: reference.trim(), occurredAt: new Date(occurredAt).toISOString(), confirmed: true };
      else if (stage === "vsl_watched") patch.evidence = evidenceKind === "tracked_video"
        ? { kind: "tracked_video", reference: reference.trim() }
        : { kind: "prospect_confirmation", reference: reference.trim(), occurredAt: new Date(occurredAt).toISOString(), confirmed: true };
      else if (stage === "counselling_booked" && lead.verifiedBookingReference) patch.evidence = {
        kind: "calendar_booking", reference: lead.verifiedBookingReference,
        occurredAt: new Date().toISOString(), confirmed: true,
      };
      else if (stage === "counselling_attended" || stage === "enrolled") patch.evidence = { kind: "staff_record", reference: reference.trim(), occurredAt: new Date(occurredAt).toISOString(), confirmed: true };
    }
    props.onSave(patch); setSavingVersion(lead.version); setSaveMessage("Saving changes…");
  };
  const assignmentChanged = assignee !== (lead.assigneeUserId === null ? "" : String(lead.assigneeUserId));
  const submitAssignment = (event: FormEvent) => {
    event.preventDefault();
    if (!props.isAdmin || !lead.leadId || !assignmentChanged || assignmentReason.trim().length < 3) return;
    props.onAssign({
      expectedVersion: lead.assignmentVersion,
      assigneeUserId: assignee ? Number(assignee) : null,
      reason: assignmentReason.trim(),
      requestId: assignmentRequestId.current ??= crypto.randomUUID(),
    });
  };
  const deliveryLabel = (status: string) => ({ acknowledged: "Acknowledged", sent: "Sent (acknowledgement not verified)", failed: "Failed", pending: "Pending", untracked: "Not tracked", not_applicable: "Not applicable", sending: "Sending", retrying: "Retrying" }[status] || status);
  const conversationItems = [...detail.conversationHistory.items, ...(conversationHistoryQuery.data?.pages.flatMap((page) => page.items) ?? [])]
    .filter((item, index, rows) => rows.findIndex((candidate) =>
      candidate.conversationId === item.conversationId && candidate.side === item.side) === index)
    .sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
      || left.conversationId.localeCompare(right.conversationId) || left.side.localeCompare(right.side));
  return <>
      <div className="crm-detail-top"><div className="crm-detail-toprow"><div><p className="crm-eyebrow">Prospect record · {lead.inquiryCount} {lead.inquiryCount === 1 ? "enquiry" : "enquiries"}</p><h2 className="crm-detail-name" id="crm-detail-title" tabIndex={-1}>{lead.name || "Name not recorded"}</h2><div className="crm-detail-contact">{lead.phone && <a href={`tel:${lead.phone}`}><Phone size={13} /> {lead.phone}</a>}{lead.email && <a href={`mailto:${lead.email}`}><Mail size={13} /> {lead.email}</a>}<span>{props.isAdmin ? lead.assigneeName || "Unassigned" : "Assigned to you"}</span></div></div>
      <div style={{ display: "flex", gap: 7, alignItems: "flex-start", flexWrap: "wrap", justifyContent: "flex-end" }}><span className="crm-identity" data-identity={lead.identityStatus}>{identityText(lead.identityStatus)}</span><span className="crm-stage-source crm-stage-source-detail">{stageOrigin(lead)}</span><button className="crm-icon-button crm-mobile-close" type="button" aria-label="Close prospect detail" onClick={props.onClose}><X size={18} /></button></div>
    </div></div>
    <div className="crm-detail-content">
      {detail.warnings.map((warning) => <div className="crm-warning" role="status" key={warning}><AlertTriangle size={15} /><span>{warning}</span></div>)}
      {!props.canWrite && <div className="crm-error" role="alert">Server CRM persistence is unavailable. Editing is disabled to avoid an unrecorded change.</div>}
      <JourneyPanel journey={detail.journey} />
      {props.isAdmin && <MetaCaptureStatusPanel items={props.metaCaptureStatus} isLoading={props.metaCaptureStatusLoading} isError={props.metaCaptureStatusError} />}
      <MetaAttributionPanel marketing={detail.marketing} />
      {props.isAdmin && <section className="crm-info crm-field-wide" aria-label="Canonical lead assignment">
        <strong>Canonical lead assignment</strong>
        <p style={{ margin: "6px 0 10px" }}>Assignment applies to this canonical lead, not to individual inquiries.</p>
        {!lead.leadId && <div className="crm-warning" role="status">This record has no canonical admissions lead yet and cannot be assigned.</div>}
        {lead.assigneeNeedsReassignment && <div className="crm-warning" role="status">The current assignee is inactive or no longer has the admissions role. Reassign or unassign this lead.</div>}
        {lead.leadId && <form onSubmit={submitAssignment} className="crm-detail-grid">
          <label className="crm-field">
            <span className="crm-field-label">Admissions assignee</span>
            <select className="crm-select" value={assignee} onChange={(event) => setAssignee(event.target.value)} data-testid="crm-assignee">
              <option value="">Unassigned</option>
              {lead.assigneeUserId !== null && !props.assignees.some((person) => person.id === lead.assigneeUserId) &&
                <option value={String(lead.assigneeUserId)} disabled>{lead.assigneeName || `Inactive user #${lead.assigneeUserId}`} · inactive</option>}
              {props.assignees.map((person) => <option key={person.id} value={String(person.id)}>{person.name}</option>)}
            </select>
          </label>
          <label className="crm-field">
            <span className="crm-field-label">Assignment reason</span>
            <input className="crm-input" minLength={3} maxLength={1000} required value={assignmentReason}
              onChange={(event) => setAssignmentReason(event.target.value)} placeholder="Why this lead is being assigned or changed" />
          </label>
          {props.assignmentError && <div className="crm-error crm-field-wide" role="alert">{props.assignmentError}</div>}
          <div className="crm-field-wide"><button className="crm-button crm-button-primary" type="submit"
            disabled={!props.capabilities.canonicalAssignments || !assignmentChanged || assignmentReason.trim().length < 3 || props.assignmentPending}
            data-testid="crm-assignment-save">{props.assignmentPending ? "Saving assignment…" : assignee ? "Save assignment" : "Unassign lead"}</button></div>
        </form>}
        {detail.assignmentHistory.length > 0 && <div style={{ marginTop: 12 }}>
          <strong>Assignment history</strong>
          <ul className="crm-timeline">{detail.assignmentHistory.map((event) => <li key={event.id}>
            <span><strong>{event.previousAssigneeName || (event.previousAssigneeUserId ? `User #${event.previousAssigneeUserId}` : "Unassigned")} → {event.newAssigneeName || (event.newAssigneeUserId ? `User #${event.newAssigneeUserId}` : "Unassigned")}</strong> · {event.actorName || `Admin #${event.actorUserId}`}</span>
            <span>{formatDate(event.changedAt, true)} · {event.reason}</span>
          </li>)}</ul>
        </div>}
        {detail.legacyInquiryAssignments.length > 0 && <div style={{ marginTop: 12 }}>
          <strong>Legacy inquiry-level owner values · review only</strong>
          <p style={{ margin: "6px 0" }}>These are retained historical per-inquiry values; they were not copied into canonical assignments.</p>
          <ul>{detail.legacyInquiryAssignments.map((legacy) => <li key={legacy.inquiryId}>
            Inquiry #{legacy.inquiryId}: {legacy.ownerName || `User #${legacy.ownerId}`}
          </li>)}</ul>
        </div>}
      </section>}
      <form onSubmit={save}><div className="crm-detail-grid">
        <label className="crm-field"><span className="crm-field-label">Current stage</span><select className="crm-select" value={stage} onChange={(event) => { setStage(event.target.value as CrmStage); setSaveMessage(""); }} data-testid="crm-stage">
          {!selectableStageSet.has(lead.stage) && <option value={lead.stage} disabled>{CRM_STAGE_LABELS[lead.stage]} · system/evidence controlled</option>}
          {selectableStages.map((item) => <option key={item} value={item} disabled={item === "counselling_booked" && !lead.hasVerifiedCalendarBooking}>{CRM_STAGE_LABELS[item]}{item === "counselling_booked" && !lead.hasVerifiedCalendarBooking ? " · unavailable" : ""}</option>)}
        </select></label>
        <label className="crm-field"><span className="crm-field-label">Follow-up</span><input className="crm-input" type="datetime-local" value={followUp} onChange={(event) => setFollowUp(event.target.value)} /></label>
        <div className="crm-field"><span className="crm-field-label">Next context</span><div className="crm-info" style={{ margin: 0 }}>Last activity {formatDate(lead.lastActivityAt, true)} · {lead.programs[0] || "Program not recorded"}</div></div>
        {stageChanged && stage === "vsl_shared" && <>
          <label className="crm-field crm-field-wide"><span className="crm-field-label">External message reference</span><input className="crm-input" minLength={3} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Message or activity reference (at least 3 characters)" /></label>
          <label className="crm-field"><span className="crm-field-label">Sent at</span><input className="crm-input" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
          <label className="crm-checkline crm-field-wide"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm the VSL link was actually sent to this prospect.</span></label>
        </>}
        {stageChanged && stage === "vsl_watched" && <>
          <label className="crm-field"><span className="crm-field-label">Evidence source</span><select className="crm-select" value={evidenceKind} onChange={(event) => setEvidenceKind(event.target.value as typeof evidenceKind)}><option value="tracked_video" disabled={!props.capabilities.videoTracking}>Tracked video record{props.capabilities.videoTracking ? "" : " · unavailable"}</option><option value="prospect_confirmation">Prospect confirmation</option></select></label>
          <label className="crm-field"><span className="crm-field-label">{evidenceKind === "tracked_video" ? "Video record reference" : "Clear quote from prospect"}</span><input className="crm-input" minLength={evidenceKind === "prospect_confirmation" ? 10 : undefined} value={reference} onChange={(event) => setReference(event.target.value)} placeholder={evidenceKind === "tracked_video" ? "Tracked milestone reference" : "Exact self-reported quote (at least 10 characters)"} /></label>
          {evidenceKind === "prospect_confirmation" ? <label className="crm-field"><span className="crm-field-label">Confirmed at</span><input className="crm-input" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label> : <p className="crm-info crm-field-wide">The server verifies the tracked record reached the required viewing milestone. A reference alone does not establish completion.</p>}
        </>}
        {stageChanged && stage === "form_submitted" && <div className={lead.hasVerifiedForm ? "crm-info crm-field-wide" : "crm-error crm-field-wide"}>{lead.hasVerifiedForm ? `Verified timestamped form record is present${lead.questionnaireCompletedAt ? ` (${formatDate(lead.questionnaireCompletedAt, true)})` : ""}.` : "Cannot mark form submitted: this person has no stored, timestamped verified form record."}</div>}
        {stageChanged && stage === "counselling_booked" && <div className={lead.hasVerifiedCalendarBooking ? "crm-info crm-field-wide" : "crm-error crm-field-wide"}>{lead.hasVerifiedCalendarBooking ? `Verified AICHM Calendar booking ${lead.verifiedBookingReference} is available as evidence.` : "Booking status is unavailable until a persisted AICHM Calendar booking exists."}</div>}
        {stageChanged && (stage === "counselling_attended" || stage === "enrolled") && <>
          <label className="crm-field crm-field-wide"><span className="crm-field-label">Staff record reference</span><input className="crm-input" minLength={10} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Confirmed attendance or enrollment record (at least 10 characters)" /></label>
          <label className="crm-field"><span className="crm-field-label">Occurred at</span><input className="crm-input" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
          <label className="crm-checkline"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirmed this in a staff record.</span></label>
        </>}
        {stageChanged && <label className="crm-field crm-field-wide"><span className="crm-field-label">Why is this stage changing?</span><input className="crm-input" minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Short, factual reason (at least 3 characters)" /></label>}
        <label className="crm-field crm-field-wide"><span className="crm-field-label">Private staff note · audited</span><textarea className="crm-textarea" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add context for the next admissions conversation…" data-testid="crm-note" /></label>
      </div>
        {evidenceError && stageChanged && <div className="crm-info" role="status">{evidenceError}</div>}
        {props.updateError && <div className="crm-error" role="alert">{props.updateError}</div>}
        <div className="crm-save-row"><span className="crm-save-status" role="status">{saveMessage || (dirty ? "Changes are not saved yet." : `Record version ${lead.version} · nothing pending`)}</span><button className="crm-button crm-button-primary" type="submit" disabled={!dirty || props.pending || blocked || Boolean(evidenceError)} data-testid="crm-save">{props.pending ? "Saving" : <><Check size={15} /> Save changes</>}</button></div>
      </form>
      <h3 className="crm-section-heading"><MessageCircle size={15} /> WhatsApp conversation history</h3>
      {detail.conversationHistory.state === "not_configured"
        ? <p className="crm-results-caption">Read-only Supabase access is not configured. Transcript data is not stored in Replit.</p>
        : detail.conversationHistory.state === "unlinked"
          ? <p className="crm-results-caption">This lead has no reviewed Supabase conversation link.</p>
          : detail.conversationHistory.state === "unavailable"
            ? <p className="crm-results-caption" role="status">Supabase conversation history is temporarily unavailable.</p>
            : <>
              {conversationItems.length ? <ol className="crm-timeline">{conversationItems.map((item) => <li className="crm-timeline-item" key={`${item.conversationId}:${item.side}`}>
                <div className="crm-timeline-title">{item.direction === "inbound" ? "WhatsApp message received" : item.direction === "outbound" ? "WhatsApp reply" : "Conversation entry"}</div>
                <div className="crm-timeline-meta">{formatDate(item.occurredAt, true)} · {item.messageType}{item.deliveryState ? ` · ${item.deliveryState}` : ""}{item.providerMessageId ? ` · ${item.providerMessageId}` : ""}</div>
                <div className="crm-timeline-body">{item.body}</div>
              </li>)}</ol> : <p className="crm-results-caption">No linked conversation messages are available.</p>}
              {detail.conversationHistory.nextCursor && (!olderConversationHistoryRequested || conversationHistoryQuery.hasNextPage || conversationHistoryQuery.isError) && <button className="crm-button" type="button"
                disabled={conversationHistoryQuery.isFetching}
                onClick={() => {
                  if (!olderConversationHistoryRequested) setOlderConversationHistoryRequested(true);
                  else if (conversationHistoryQuery.isError) void conversationHistoryQuery.refetch();
                  else if (conversationHistoryQuery.hasNextPage) void conversationHistoryQuery.fetchNextPage();
                }}>
                {conversationHistoryQuery.isFetching ? "Loading messages" : conversationHistoryQuery.isError ? "Retry loading messages" : "Load older messages"}
              </button>}
              {conversationHistoryQuery.isError && <p className="crm-error" role="alert">Older messages could not be loaded.</p>}
            </>}
      <h3 className="crm-section-heading"><Clock3 size={15} /> Activity timeline</h3>
      {detail.activities.length ? <ol className="crm-timeline">{detail.activities.map((item) => <li className="crm-timeline-item" key={item.id}><div className="crm-timeline-title">{item.title}</div><div className="crm-timeline-meta">{formatDate(item.at, true)} · {item.actorName || (item.source === "verified_system" ? "Verified system" : "Enquiry record")}</div>{item.body && <div className="crm-timeline-body">{item.body}</div>}</li>)}</ol> : <p className="crm-results-caption">No activity has been recorded for this person yet.</p>}
      <h3 className="crm-section-heading"><Users size={15} /> Enquiry history</h3>
      {detail.inquiries.map((inquiry) => <article className="crm-inquiry" key={inquiry.id}>
        <div className="crm-inquiry-header"><div><h4>{inquiry.programInterest || "Program interest not recorded"}</h4><p>Enquiry {inquiry.id} · submitted {formatDate(inquiry.counsellingSubmittedAt, true)}</p></div>{inquiry.counsellingAnswers && <span className="crm-connection-tag">{deliveryLabel(inquiry.counsellingDeliveryStatus)}</span>}</div>
        {inquiry.message && <p>{inquiry.message}</p>}
        {inquiry.counsellingAnswers && <>
          <p><strong>Form delivery:</strong> {deliveryLabel(inquiry.counsellingDeliveryStatus)} · {inquiry.counsellingDeliveryAttempts} attempt{inquiry.counsellingDeliveryAttempts === 1 ? "" : "s"}</p>
          {inquiry.counsellingDeliveryLastResult && <p>Latest recorded result: {inquiry.counsellingDeliveryLastResult}</p>}
          {props.isAdmin && inquiry.counsellingDeliveryStatus === "failed" && <button type="button" className="crm-button" style={{ marginTop: 9 }} disabled={props.retryPending} onClick={() => props.onRetry(inquiry.id)}>{props.retryPending && props.retryId === inquiry.id ? "Retrying" : "Review & retry delivery"}</button>}
          {inquiry.counsellingDeliveryStatus === "untracked" && <p>Delivery was not tracked for this older inquiry. Do not resend an untracked submission.</p>}
          {props.isAdmin && props.retryError && props.retryId === inquiry.id && <p role="alert" className="crm-error">{props.retryError}</p>}
          <details style={{ marginTop: 10 }}><summary className="crm-text-button" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>View counselling answers <ChevronDown size={13} /></summary><dl className="crm-answers">{Object.entries(inquiry.counsellingAnswers).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => <div key={key}><dt>{counsellingFieldLabels[key] ?? key}</dt><dd>{formatCounsellingAnswer(key, value)}</dd></div>)}</dl></details>
        </>}
      </article>)}
      <div className="crm-info" style={{ display: "flex", gap: 8, alignItems: "center" }}><VideoOff size={15} /> Video milestones require server-verified playback. {detail.capabilities.chatHistory ? "WhatsApp history is viewed read-only from Supabase." : "WhatsApp history requires a least-privilege Supabase reader setup."} {detail.capabilities.calendarBookingVerification ? "Counselling bookings are verified from the AICHM Calendar." : "Counselling bookings are unavailable until the Calendar schema is installed."}</div>
    </div>
  </>;
}

function MetaAttributionPanel({ marketing }: { marketing: CrmDetail["marketing"] }) {
  return <section className="crm-journey" aria-label="Marketing attribution and consent">
    <h3>Marketing attribution & measurement</h3>
    {!marketing.available ? <p className="crm-journey-note">Attribution tables are not installed yet. Existing lead capture continues; no Meta measurement data is exposed.</p> : <>
      <div className="crm-journey-grid">
        <p><span>Measurement consent</span><strong>{marketing.consentStatus ? `${marketing.consentStatus} · ${formatDate(marketing.consentAt, true)}` : "No linked consent record"}</strong></p>
        <p><span>Source touchpoints</span><strong>{marketing.touchpoints.length}</strong></p>
        <p><span>Meta CAPI events</span><strong>{marketing.capiDeliveries.length}</strong></p>
      </div>
      {marketing.touchpoints.map((touch, index) => <p className="crm-journey-note" key={`${touch.occurredAt}-${index}`}>
        {formatDate(touch.occurredAt, true)} · {touch.sourceChannel}
        {touch.campaign ? ` · ${touch.campaign}` : ""}
        {touch.metaLeadId ? ` · Meta lead ${touch.metaLeadId}` : ""}
      </p>)}
      {marketing.metaLeadLinks.map((link) => <p className="crm-journey-note" key={`meta-link:${link.metaLeadId}`}>
        Meta Instant Form link: {link.state}{link.errorCode ? ` · ${link.errorCode}` : ""} · received {formatDate(link.receivedAt, true)}
      </p>)}
      {marketing.capiDeliveries.map((delivery) => <p className="crm-journey-note" key={delivery.eventId}>
        CAPI {delivery.eventName}: {delivery.state} · {delivery.attemptCount} attempts
        {delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ""}
        {delivery.lastError ? ` · ${delivery.lastError}` : ""}
      </p>)}
    </>}
  </section>;
}

function JourneyPanel({ journey }: { journey: CrmDetail["journey"] }) {
  if (!journey) return <div className="crm-info"><strong>Verified journey unavailable.</strong> No linked video or questionnaire record is available; this does not establish that the steps occurred.</div>;
  const lastEvent = [...journey.events].sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()).at(-1);
  const milestoneLabels: Record<string, string> = {
    started: "Playback started", "25": "25% milestone observed", "50": "50% milestone observed",
    "75": "75% milestone observed", "90": "90% milestone observed", completed: "Video completed",
  };
  const completed = journey.events.some((event) => event.event === "completed");
  return <section className="crm-journey" aria-label="Verified journey">
    <h3>Verified journey</h3>
    <div className="crm-journey-grid">
      <p><span>VSL registration</span><strong>{formatDate(journey.registeredAt, true)}</strong></p>
      <p><span>Observed video progress</span><strong>{lastEvent ? milestoneLabels[lastEvent.event] ?? lastEvent.event : "No playback milestone observed"}</strong></p>
      <p><span>Video completion</span><strong>{completed ? "Completion recorded" : "Completion not recorded"}</strong></p>
      <p><span>Questionnaire</span><strong>{journey.questionnaireStatus === "completed" ? `Completed · ${formatDate(journey.questionnaireCompletedAt, true)}` : "No linked questionnaire recorded"}</strong></p>
      <p className="crm-journey-wide"><span>Linked enquiry IDs</span><strong>{journey.linkedInquiryIds.length ? journey.linkedInquiryIds.join(", ") : "None linked"}</strong></p>
    </div>
    {journey.legacyMatchStatus.toLowerCase().includes("ambiguous") && <p className="crm-journey-note">Legacy match is ambiguous. Earlier records were not automatically linked or merged.</p>}
  </section>;
}
