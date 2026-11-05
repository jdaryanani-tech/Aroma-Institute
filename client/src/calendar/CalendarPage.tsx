import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { AlertCircle, Bell, BellOff, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, MapPin, Plus, Search, Settings2, SlidersHorizontal, Smartphone, Users, X } from "lucide-react";
import type { CalendarCategory, CalendarEvent, CalendarEventInput, CalendarFilters, CalendarView } from "@shared/calendar";
import {
  useCalendarEvents,
  useCalendarInbox,
  useCalendarPreferences,
  useCalendarResources,
  useCreateCalendarEvent,
  useMarkAllCalendarNotificationsRead,
  useMarkCalendarNotificationRead,
  usePushPublicKey,
  useSubscribePush,
  useUnsubscribePush,
  useUpdateCalendarEvent,
  useUpdateCalendarPreferences,
} from "./api";
import { useLmsSession } from "@/hooks/use-lms";
import "./calendar.css";

type Props = { surface: "admin" | "learn" };
type EventDraft = {
  title: string; description: string; category: CalendarCategory; eventType: string;
  startsAt: string; endsAt: string; allDay: boolean; location: string; onlineUrl: string;
  status: CalendarEvent["status"]; resourceId: string; trainerId: string; courseId: string;
  batchId: string; capacity: string; inquiryId: string; recurrenceFrequency: string; recurrenceInterval: string;
  recurrenceUntil: string; overrideReason: string;
};
const TZ = "Asia/Kolkata";
const categoryLabels: Record<CalendarCategory, string> = {
  admissions: "Admissions", academic: "Academic", workshops: "Workshops",
  staff: "Staff", operations: "Operations", student: "Student",
};
const views: { id: CalendarView; label: string }[] = [
  { id: "day", label: "Day" }, { id: "week", label: "Week" }, { id: "month", label: "Month" },
  { id: "agenda", label: "Agenda" }, { id: "my", label: "My events" }, { id: "resource", label: "Resources" },
];
function dateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function startInKolkata(key: string) { return new Date(`${key}T00:00:00+05:30`); }
function moveKey(key: string, days: number) { const date = startInKolkata(key); date.setDate(date.getDate() + days); return dateKey(date); }
function monthKey(key: string, offset: number) {
  const date = startInKolkata(key); date.setDate(1); date.setMonth(date.getMonth() + offset); return dateKey(date);
}
function dateLabel(date: Date, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-IN", { ...options, timeZone: TZ }).format(date);
}
function rangeFor(view: CalendarView, anchor: string) {
  if (view === "day") return { start: anchor, end: moveKey(anchor, 1) };
  if (view === "month") {
    const month = anchor.slice(0, 7);
    const first = `${month}-01`;
    const next = monthKey(first, 1);
    const firstDay = startInKolkata(first).getDay();
    const last = moveKey(next, -1);
    const trailing = 6 - startInKolkata(last).getDay();
    return { start: moveKey(first, -firstDay), end: moveKey(last, trailing + 1) };
  }
  const day = startInKolkata(anchor).getDay();
  const mondayOffset = (day + 6) % 7;
  const start = moveKey(anchor, -mondayOffset);
  return { start, end: moveKey(start, view === "week" || view === "resource" || view === "my" ? 7 : 14) };
}
function dateTimeValue(value?: string | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
function toIso(value: string) { return value ? new Date(`${value}:00+05:30`).toISOString() : ""; }
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function eventDraft(event?: CalendarEvent | null): EventDraft {
  return {
    title: event?.title ?? "", description: event?.description ?? "", category: event?.category ?? "academic",
    eventType: event?.eventType ?? "session", startsAt: dateTimeValue(event?.startsAt),
    endsAt: dateTimeValue(event?.endsAt), allDay: event?.allDay ?? false, location: event?.location ?? "",
    onlineUrl: event?.onlineUrl ?? "", status: event?.status ?? "confirmed",
    resourceId: event?.resourceId ? String(event.resourceId) : "", trainerId: event?.trainerId ? String(event.trainerId) : "",
    courseId: event?.courseId ? String(event.courseId) : "", batchId: event?.batchId ? String(event.batchId) : "",
    inquiryId: event?.inquiryId ? String(event.inquiryId) : "",
    capacity: event?.capacity ? String(event.capacity) : "", recurrenceFrequency: event?.recurrence?.frequency ?? "",
    recurrenceInterval: String(event?.recurrence?.interval ?? 1), recurrenceUntil: event?.recurrence?.until?.slice(0, 10) ?? "",
    overrideReason: "",
  };
}
function toInput(draft: EventDraft): CalendarEventInput {
  const startValue = draft.allDay ? `${draft.startsAt.slice(0, 10)}T00:00` : draft.startsAt;
  const endValue = draft.allDay
    ? `${moveKey(draft.startsAt.slice(0, 10), 1)}T00:00`
    : draft.endsAt;
  return {
    title: draft.title.trim(), description: draft.description.trim() || null, category: draft.category,
    eventType: draft.eventType.trim() || "session", startsAt: toIso(startValue),
    endsAt: endValue ? toIso(endValue) : null, timezone: TZ, allDay: draft.allDay,
    location: draft.location.trim() || null, onlineUrl: draft.onlineUrl.trim() || null, status: draft.status,
    resourceId: draft.resourceId ? Number(draft.resourceId) : null, trainerId: draft.trainerId ? Number(draft.trainerId) : null,
    courseId: draft.courseId ? Number(draft.courseId) : null, batchId: draft.batchId ? Number(draft.batchId) : null,
    inquiryId: draft.inquiryId ? Number(draft.inquiryId) : null,
    capacity: draft.capacity ? Number(draft.capacity) : null,
    recurrence: draft.recurrenceFrequency ? {
      frequency: draft.recurrenceFrequency as "daily" | "weekly" | "monthly",
      interval: Math.max(1, Number(draft.recurrenceInterval) || 1),
      until: draft.recurrenceUntil ? `${draft.recurrenceUntil}T23:59:59+05:30` : null,
    } : null,
    ...(draft.overrideReason.trim() ? { overrideReason: draft.overrideReason.trim() } : {}),
  };
}
function dateRangeText(anchor: string, view: CalendarView) {
  const start = startInKolkata(anchor);
  if (view === "day") return dateLabel(start, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (view === "month") return dateLabel(start, { month: "long", year: "numeric" });
  const range = rangeFor(view, anchor);
  const rangeStart = startInKolkata(range.start);
  const end = startInKolkata(range.end);
  return `${dateLabel(rangeStart, { day: "numeric", month: "short" })} – ${dateLabel(new Date(end.getTime() - 1), { day: "numeric", month: "short", year: "numeric" })}`;
}
function fromVapidKey(key: string) {
  const padding = "=".repeat((4 - key.length % 4) % 4);
  const base64 = (key + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export default function CalendarPage({ surface }: Props) {
  const session = useLmsSession();
  const roles = session.data?.roles ?? [];
  const canOpenSurface = surface === "admin"
    ? roles.some(role => ["admin", "admissions", "academic_coordinator", "operations"].includes(role))
    : roles.some(role => ["student", "trainer", "academic_coordinator"].includes(role));
  const canManage = roles.includes("admin") ||
    (surface === "admin" && roles.some(role => ["admissions", "academic_coordinator", "operations"].includes(role))) ||
    (surface === "learn" && (roles.includes("trainer") || roles.includes("academic_coordinator")));
  const [anchor, setAnchor] = useState(() => dateKey(new Date()));
  const [view, setView] = useState<CalendarView>("week");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [location, setLocation] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [activeEvent, setActiveEvent] = useState<CalendarEvent | null>(null);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<EventDraft>(() => eventDraft());
  const [formError, setFormError] = useState("");
  const [inboxOpen, setInboxOpen] = useState(() => typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("notificationId"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pushMessage, setPushMessage] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { start, end } = useMemo(() => rangeFor(view, anchor), [view, anchor]);
  const filters: CalendarFilters = {
    start: `${start}T00:00:00+05:30`, end: `${end}T00:00:00+05:30`, view,
    ...(category ? { category: category as CalendarCategory } : {}),
    ...(status ? { status: status as CalendarEvent["status"] } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(location.trim() ? { location: location.trim() } : {}),
    ...(resourceId ? { resourceId: Number(resourceId) } : {}),
    ...(staffId ? { staffId: Number(staffId) } : {}),
    ...(courseId ? { courseId: Number(courseId) } : {}),
    ...(batchId ? { batchId: Number(batchId) } : {}),
  };
  const eventsQuery = useCalendarEvents(filters, !session.isLoading && canOpenSurface);
  const resourcesQuery = useCalendarResources(!session.isLoading && canOpenSurface);
  const inboxQuery = useCalendarInbox(!session.isLoading && canOpenSurface);
  const preferencesQuery = useCalendarPreferences(!session.isLoading && canOpenSurface);
  const pushKeyQuery = usePushPublicKey(settingsOpen && !session.isLoading && canOpenSurface);
  const createEvent = useCreateCalendarEvent();
  const updateEvent = useUpdateCalendarEvent();
  const markRead = useMarkCalendarNotificationRead();
  const markAllRead = useMarkAllCalendarNotificationsRead();
  const updatePreferences = useUpdateCalendarPreferences();
  const subscribePush = useSubscribePush();
  const unsubscribePush = useUnsubscribePush();
  const events = eventsQuery.data ?? [];
  const resources = resourcesQuery.data ?? [];
  const loading = session.isLoading || eventsQuery.isLoading;
  const canShowWrite = canManage && Boolean(session.data);

  useEffect(() => {
    if (!formOpen && !inboxOpen && !settingsOpen && !activeEvent) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFormOpen(false); setInboxOpen(false); setSettingsOpen(false); setActiveEvent(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [formOpen, inboxOpen, settingsOpen, activeEvent]);

  const openCreate = (date = anchor) => {
    setActiveEvent(null);
    setEditingEvent(null);
    setDraft(eventDraft());
    setDraft((current) => ({ ...current, startsAt: `${date}T09:00`, endsAt: `${date}T10:00` }));
    setFormError("");
    setFormOpen(true);
  };
  const openEdit = (event: CalendarEvent) => {
    setActiveEvent(null); setEditingEvent(event); setDraft(eventDraft(event)); setFormError(""); setFormOpen(true);
  };
  const openCounsellingBooking = (event: CalendarEvent) => {
    setActiveEvent(null); setEditingEvent(null);
    const start = dateTimeValue(event.startsAt);
    const end = event.endsAt ? dateTimeValue(event.endsAt) : "";
    setDraft({ ...eventDraft(), category: "admissions", eventType: "counselling", inquiryId: String(event.inquiryId ?? ""), startsAt: start, endsAt: end, status: "confirmed" });
    setFormError(""); setFormOpen(true);
  };
  const submitEvent = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    if (!draft.title.trim() || !draft.startsAt) { setFormError("Add a title and start time to continue."); return; }
    if (draft.endsAt && new Date(toIso(draft.endsAt)) <= new Date(toIso(draft.startsAt))) { setFormError("The end time must be after the start time."); return; }
    const input = toInput(draft);
    if (editingEvent) {
      updateEvent.mutate({ id: editingEvent.id, expectedVersion: editingEvent.version, update: input }, {
        onSuccess: () => { setFormOpen(false); setEditingEvent(null); },
        onError: (error) => setFormError(errorMessage(error, "This event could not be updated.")),
      });
    } else {
      createEvent.mutate(input, {
        onSuccess: () => setFormOpen(false),
        onError: (error) => setFormError(errorMessage(error, "This event could not be created.")),
      });
    }
  };
  const stepDate = (direction: number) => {
    if (view === "month") setAnchor(monthKey(anchor, direction).slice(0, 10));
    else if (view === "week" || view === "resource" || view === "my") setAnchor(moveKey(anchor, direction * 7));
    else setAnchor(moveKey(anchor, direction));
  };
  const displayEvents = useMemo(() => events.slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [events]);
  const dayKeys = useMemo(() => {
    if (view === "day") return [anchor];
    if (view === "month") {
      const range = rangeFor("month", anchor);
      const days: string[] = [];
      for (let date = range.start; date < range.end; date = moveKey(date, 1)) days.push(date);
      return days;
    }
    const range = rangeFor(view, anchor);
    const count = view === "agenda" ? 14 : 7;
    return Array.from({ length: count }, (_, index) => moveKey(range.start, index));
  }, [view, anchor]);
  const eventsForDay = (key: string) => displayEvents.filter((item) => dateKey(new Date(item.startsAt)) === key);
  const eventCounts = displayEvents.length;
  const unreadCount = inboxQuery.data?.unreadCount ?? 0;
  const categoryClass = (item: CalendarEvent) => `ai-cal-event ai-cal-${item.category}`;
  const selectedResource = (id: number | null) => resources.find((item) => item.id === id)?.name;
  const savePref = (patch: { inAppEnabled?: boolean; quietHoursStart?: string | null; quietHoursEnd?: string | null; timezone?: string; reminderOffsetsMinutes?: number[] }) => updatePreferences.mutate(patch);

  async function enablePush() {
    setPushMessage("");
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setPushMessage("Push is not available in this browser."); return; }
    if (Notification.permission === "denied") { setPushMessage("Notifications are blocked in browser settings. Allow them there, then try again."); return; }
    if (!pushKeyQuery.data?.publicKey) { setPushMessage("Push notifications are not configured for this workspace yet."); return; }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setPushMessage("Permission was not granted. You can enable it later in browser settings."); return; }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromVapidKey(pushKeyQuery.data.publicKey) });
      subscribePush.mutate({ subscription: subscription.toJSON(), deviceLabel: /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "iPhone / iPad" : "This browser", appScope: surface }, {
        onSuccess: () => setPushMessage("Push notifications are enabled on this device."),
        onError: (error) => setPushMessage(errorMessage(error, "Push setup could not be completed.")),
      });
    } catch (error) { setPushMessage(errorMessage(error, "Push setup could not be completed.")); }
  }
  async function disablePush() {
    setPushMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) { setPushMessage("There is no push subscription on this device."); return; }
      unsubscribePush.mutate(subscription.endpoint, { onSuccess: async () => { await subscription.unsubscribe(); setPushMessage("Push notifications are disabled on this device."); }, onError: (error) => setPushMessage(errorMessage(error, "Push could not be disabled.")) });
    } catch (error) { setPushMessage(errorMessage(error, "Push could not be disabled.")); }
  }

  if (session.isError || (!session.isLoading && !session.data)) {
    return <main className="crm-app ai-calendar"><section className="crm-empty ai-cal-access" role="alert"><CalendarDays size={28} /><p className="crm-eyebrow">Aroma Institute · scheduling desk</p><strong>Sign in to see your calendar</strong><p>Your schedule is private to your account and role.</p><a className="crm-button crm-button-primary" href={surface==="admin"?"/admin/login":"/learn"}>Sign in</a></section></main>;
  }
  if (!session.isLoading && !canOpenSurface) {
    return <main className="crm-app ai-calendar"><section className="crm-empty ai-cal-access" role="alert"><CalendarDays size={28} /><p className="crm-eyebrow">Aroma Institute · scheduling desk</p><strong>This calendar is not assigned to your role</strong><p>Ask your institute coordinator if you need access.</p></section></main>;
  }

  return (
    <main className="crm-app ai-calendar" data-surface={surface}>
      <header className="crm-topbar ai-cal-topbar">
        <div className="crm-wrap crm-topbar-inner">
          <div className="crm-brand"><span className="crm-brand-mark" aria-hidden="true">A.</span><div className="crm-brand-copy"><strong>Aroma Institute</strong><span>Scheduling desk · {surface === "admin" ? "Operations" : "Learning"}</span></div></div>
          <div className="crm-top-actions">
            <span className="ai-cal-timezone">IST · Asia/Kolkata</span>
            <button className="crm-icon-button ai-cal-notify" type="button" onClick={() => setInboxOpen(true)} aria-label={`Open inbox${unreadCount ? `, ${unreadCount} unread` : ""}`} title="Inbox"><Bell size={17} />{unreadCount > 0 && <span>{unreadCount > 9 ? "9+" : unreadCount}</span>}</button>
            <button className="crm-icon-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Notification preferences" title="Notification preferences"><Settings2 size={17} /></button>
            {canShowWrite && <button className="crm-button crm-button-primary ai-cal-create-top" type="button" onClick={() => openCreate()}><Plus size={16} /> New event</button>}
          </div>
        </div>
      </header>
      <div className="crm-wrap crm-main ai-cal-main">
        <section className="crm-heading-row ai-cal-heading">
          <div><p className="crm-eyebrow">Aroma Institute · {surface === "admin" ? "All departments" : "Learning calendar"}</p><h1 className="crm-heading">The day, in good order.</h1><p className="crm-subheading">Admissions, classes, workshops and the people who make them happen.</p></div>
          <div className="ai-cal-summary"><span className="ai-cal-summary-number">{loading ? "—" : eventCounts.toLocaleString("en-IN")}</span><span>items in view</span><i aria-hidden="true" /></div>
        </section>

        <section className="ai-cal-toolbar" aria-label="Calendar controls">
          <div className="ai-cal-toolbar-row">
            <div className="ai-cal-date-nav">
              <button className="crm-icon-button" type="button" onClick={() => stepDate(-1)} aria-label="Previous period"><ChevronLeft size={18} /></button>
              <button className="crm-button ai-cal-today" type="button" onClick={() => setAnchor(dateKey(new Date()))}>Today</button>
              <button className="crm-icon-button" type="button" onClick={() => stepDate(1)} aria-label="Next period"><ChevronRight size={18} /></button>
              <h2>{dateRangeText(anchor, view)}</h2>
            </div>
            <div className="ai-cal-viewtabs" role="tablist" aria-label="Calendar view">
              {views.map((item) => <button key={item.id} type="button" role="tab" aria-selected={view === item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}
            </div>
          </div>
          <div className="ai-cal-filters-row">
            <label className="ai-cal-search"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search schedule…" aria-label="Search events" /></label>
            <button className={`crm-button ai-cal-filter-toggle ${filtersOpen ? "is-active" : ""}`} type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={15} /> Filters{[category, status, resourceId, staffId, courseId, batchId].filter(Boolean).length > 0 && <span className="ai-cal-filter-count">{[category, status, resourceId, staffId, courseId, batchId].filter(Boolean).length}</span>}</button>
            {canShowWrite && <button className="crm-button crm-button-primary ai-cal-create-mobile" type="button" onClick={() => openCreate()}><Plus size={16} /> New event</button>}
          </div>
          {filtersOpen && <div className="ai-cal-filter-grid">
            <label><span>Category</span><select className="crm-select" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>Status</span><select className="crm-select" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Any status</option>{["draft", "requested", "confirmed", "completed", "cancelled", "rescheduled"].map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}</select></label>
            <label><span>Location</span><input className="crm-input" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Campus, room, online" /></label>
            <label><span>Resource</span><select className="crm-select" value={resourceId} onChange={(event) => setResourceId(event.target.value)}><option value="">All resources</option>{resources.map((resource) => <option value={resource.id} key={resource.id}>{resource.name}</option>)}</select></label>
            <label><span>Staff ID</span><input className="crm-input" inputMode="numeric" value={staffId} onChange={(event) => setStaffId(event.target.value.replace(/\D/g, ""))} placeholder="Any staff" /></label>
            <label><span>Course ID</span><input className="crm-input" inputMode="numeric" value={courseId} onChange={(event) => setCourseId(event.target.value.replace(/\D/g, ""))} placeholder="Any course" /></label>
            <label><span>Batch ID</span><input className="crm-input" inputMode="numeric" value={batchId} onChange={(event) => setBatchId(event.target.value.replace(/\D/g, ""))} placeholder="Any batch" /></label>
            <button type="button" className="crm-text-button ai-cal-clear" onClick={() => { setCategory(""); setStatus(""); setResourceId(""); setStaffId(""); setCourseId(""); setBatchId(""); setSearch(""); setLocation(""); }}>Clear filters</button>
          </div>}
        </section>

        {eventsQuery.isError && <div className="crm-error ai-cal-query-error" role="alert"><AlertCircle size={17} /><span><strong>Schedule unavailable.</strong> {errorMessage(eventsQuery.error, "We could not load the calendar.")}</span><button type="button" className="crm-text-button" onClick={() => void eventsQuery.refetch()}>Try again</button></div>}
        {resourcesQuery.isError && <div className="crm-info" role="status">Resource options are temporarily unavailable. Events are still shown.</div>}
        <section className={`ai-cal-board ${view === "month" ? "is-month" : ""}`} aria-label={`${views.find((item) => item.id === view)?.label ?? "Calendar"} events`} aria-busy={loading}>
          <div className="ai-cal-weekdays" aria-hidden="true">{view === "day" ? <span>{dateLabel(startInKolkata(anchor), { weekday: "long" })}</span> : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}</div>
          {loading ? <div className="ai-cal-skeleton-grid" aria-label="Loading calendar"><div /><div /><div /><div /><div /><div /><div /></div> :
            eventsQuery.isError ? <div className="crm-empty ai-cal-empty"><CalendarDays size={26} /><strong>Calendar could not be opened</strong><p>Try again when your connection is available.</p><button type="button" className="crm-button" onClick={() => void eventsQuery.refetch()}>Reload schedule</button></div> :
            !displayEvents.length ? <div className="crm-empty ai-cal-empty"><CalendarDays size={27} /><strong>Nothing scheduled here</strong><p>There are no returned events for this period and filter set.</p>{canShowWrite && <button type="button" className="crm-button crm-button-primary" onClick={() => openCreate(anchor)}><Plus size={15} /> Add an event</button>}</div> :
            view === "agenda" ? <div className="ai-cal-agenda">{dayKeys.map((day) => <section key={day} className="ai-cal-agenda-day"><h3><span>{dateLabel(startInKolkata(day), { weekday: "short" })}</span>{dateLabel(startInKolkata(day), { day: "numeric", month: "short" })}</h3><div>{eventsForDay(day).map((item) => <EventChip key={item.id} event={item} resourceName={selectedResource(item.resourceId)} onClick={() => setActiveEvent(item)} />)}</div></section>)}</div> :
            <div className={`ai-cal-grid ${view === "month" ? "month-grid" : view === "day" ? "day-grid" : ""}`} style={{ "--ai-cal-columns": view === "day" ? 1 : 7 } as CSSProperties}>
              {dayKeys.map((day) => {
                const dayEvents = eventsForDay(day);
                const outsideMonth = view === "month" && day.slice(0, 7) !== anchor.slice(0, 7);
                return <article key={day} className={`ai-cal-day ${outsideMonth ? "is-outside" : ""} ${day === dateKey(new Date()) ? "is-today" : ""}`}>
                  <header><span>{view === "day" ? dateLabel(startInKolkata(day), { day: "numeric", month: "long" }) : Number(day.slice(-2))}</span>{view !== "month" && <small>{dayEvents.length ? `${dayEvents.length} ${dayEvents.length === 1 ? "item" : "items"}` : ""}</small>}</header>
                  <div className="ai-cal-day-events">{dayEvents.map((item) => <EventChip key={item.id} event={item} resourceName={selectedResource(item.resourceId)} onClick={() => setActiveEvent(item)} />)}</div>
                  {canShowWrite && <button type="button" className="ai-cal-add-day" onClick={() => openCreate(day)} aria-label={`Add event on ${dateLabel(startInKolkata(day), { dateStyle: "long" })}`}><Plus size={14} /></button>}
                </article>;
              })}
            </div>}
          {eventsQuery.isFetching && !eventsQuery.isLoading && <span className="ai-cal-refreshing" role="status">Updating schedule…</span>}
        </section>
        {view === "resource" && <section className="ai-cal-resource-strip"><strong>Resource availability</strong>{resourcesQuery.isLoading ? <span>Loading resources…</span> : resources.length ? resources.map((resource) => <button key={resource.id} type="button" aria-pressed={resourceId === String(resource.id)} onClick={() => setResourceId((value) => value === String(resource.id) ? "" : String(resource.id))}><span className="ai-cal-resource-dot" />{resource.name}<small>{resource.kind}</small></button>) : <span>No resources were returned for this account.</span>}</section>}
      </div>

      {activeEvent && <div className="crm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveEvent(null); }}>
        <section className="crm-dialog ai-cal-dialog ai-cal-event-detail" role="dialog" aria-modal="true" aria-labelledby="ai-event-title">
          <div className="ai-cal-dialog-head"><span className={`ai-cal-category-mark ai-cal-${activeEvent.category}`} /><button className="crm-icon-button" type="button" onClick={() => setActiveEvent(null)} aria-label="Close event details"><X size={17} /></button></div>
          <p className="crm-eyebrow">{categoryLabels[activeEvent.category]} · {activeEvent.status}</p><h2 id="ai-event-title">{activeEvent.title}</h2>
          <p className="ai-cal-event-type">{activeEvent.eventType}{activeEvent.recurrence && ` · repeats ${activeEvent.recurrence.frequency}`}</p>
          <dl className="ai-cal-detail-list">
            <div><dt><Clock3 size={15} />When</dt><dd>{activeEvent.allDay ? "All day · " : ""}{dateLabel(new Date(activeEvent.startsAt), { weekday: "long", day: "numeric", month: "long", hour: activeEvent.allDay ? undefined : "numeric", minute: activeEvent.allDay ? undefined : "2-digit" })}{activeEvent.endsAt && ` – ${dateLabel(new Date(activeEvent.endsAt), { hour: "numeric", minute: "2-digit" })}`} IST</dd></div>
            {(activeEvent.location || activeEvent.onlineUrl) && <div><dt><MapPin size={15} />Where</dt><dd>{activeEvent.location}{activeEvent.onlineUrl && <a href={activeEvent.onlineUrl} target="_blank" rel="noreferrer">Join online</a>}</dd></div>}
            {activeEvent.resourceId && <div><dt><CalendarDays size={15} />Resource</dt><dd>{selectedResource(activeEvent.resourceId) ?? `Resource ${activeEvent.resourceId}`}</dd></div>}
            {((activeEvent.capacity ?? 0) > 0 || activeEvent.attendeeIds.length > 0) && <div><dt><Users size={15} />Attendance</dt><dd>{activeEvent.attendeeIds.length} attending{activeEvent.capacity ? ` · capacity ${activeEvent.capacity}` : ""}</dd></div>}
          </dl>
          {activeEvent.description && <p className="ai-cal-description">{activeEvent.description}</p>}
          {!!activeEvent.conflictWarnings.length && <div className="crm-warning"><AlertCircle size={16} /><span>{activeEvent.conflictWarnings.join(" ")}</span></div>}
          <div className="ai-cal-dialog-actions"><span className="ai-cal-source-label">Source · {activeEvent.source.replaceAll("_", " ")}</span>{canShowWrite && activeEvent.source === "calendar" && <button className="crm-button crm-button-primary" type="button" onClick={() => openEdit(activeEvent)}>Edit event</button>}{canShowWrite && activeEvent.source === "counselling_request" && <button className="crm-button crm-button-primary" type="button" onClick={() => openCounsellingBooking(activeEvent)}>Review & book slot</button>}</div>
        </section>
      </div>}

      {formOpen && <div className="crm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !createEvent.isPending && !updateEvent.isPending) setFormOpen(false); }}>
        <form className="crm-dialog ai-cal-dialog ai-cal-form" onSubmit={submitEvent} role="dialog" aria-modal="true" aria-labelledby="ai-form-title">
          <div className="ai-cal-dialog-head"><div><p className="crm-eyebrow">Scheduling desk</p><h2 id="ai-form-title">{editingEvent ? "Edit event" : "Create an event"}</h2></div><button className="crm-icon-button" type="button" onClick={() => setFormOpen(false)} aria-label="Close event form"><X size={17} /></button></div>
          <div className="ai-cal-form-grid">
            <label className="crm-field ai-cal-wide"><span className="crm-field-label">Event title</span><input className="crm-input" required autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="e.g. Foundation class · intake 08" /></label>
            <label className="crm-field"><span className="crm-field-label">Category</span><select className="crm-select" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as CalendarCategory })}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="crm-field"><span className="crm-field-label">Type</span><input className="crm-input" value={draft.eventType} onChange={(event) => setDraft({ ...draft, eventType: event.target.value })} placeholder="session, interview…" /></label>
            <label className="crm-field"><span className="crm-field-label">Starts · IST</span><input className="crm-input" required type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} /></label>
            <label className="crm-field"><span className="crm-field-label">Ends · IST</span><input className="crm-input" type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} /></label>
            <label className="crm-field"><span className="crm-field-label">Status</span><select className="crm-select" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as CalendarEvent["status"] })}>{["draft", "requested", "confirmed", "completed", "cancelled", "rescheduled"].map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}</select></label>
            <label className="crm-field"><span className="crm-field-label">Resource</span><select className="crm-select" value={draft.resourceId} onChange={(event) => setDraft({ ...draft, resourceId: event.target.value })}><option value="">Not assigned</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
            <label className="crm-field"><span className="crm-field-label">Location</span><input className="crm-input" value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} placeholder="Room or campus" /></label>
            <label className="crm-field"><span className="crm-field-label">Online link</span><input className="crm-input" type="url" value={draft.onlineUrl} onChange={(event) => setDraft({ ...draft, onlineUrl: event.target.value })} placeholder="https://" /></label>
            <label className="crm-field"><span className="crm-field-label">Trainer ID</span><input className="crm-input" inputMode="numeric" value={draft.trainerId} onChange={(event) => setDraft({ ...draft, trainerId: event.target.value.replace(/\D/g, "") })} /></label>
            <label className="crm-field"><span className="crm-field-label">Course ID</span><input className="crm-input" inputMode="numeric" value={draft.courseId} onChange={(event) => setDraft({ ...draft, courseId: event.target.value.replace(/\D/g, "") })} /></label>
            <label className="crm-field"><span className="crm-field-label">Batch ID</span><input className="crm-input" inputMode="numeric" value={draft.batchId} onChange={(event) => setDraft({ ...draft, batchId: event.target.value.replace(/\D/g, "") })} /></label>
             {draft.category === "admissions" && <label className="crm-field"><span className="crm-field-label">Saved enquiry ID</span><input className="crm-input" inputMode="numeric" value={draft.inquiryId} onChange={(event) => setDraft({ ...draft, inquiryId: event.target.value.replace(/\D/g, "") })} placeholder="Required to confirm counselling" /></label>}
            <label className="crm-field"><span className="crm-field-label">Capacity</span><input className="crm-input" inputMode="numeric" value={draft.capacity} onChange={(event) => setDraft({ ...draft, capacity: event.target.value.replace(/\D/g, "") })} /></label>
            <label className="crm-checkline ai-cal-all-day"><input type="checkbox" checked={draft.allDay} onChange={(event) => setDraft({ ...draft, allDay: event.target.checked })} /><span>All-day event</span></label>
            <div className="ai-cal-recurrence ai-cal-wide"><p className="crm-field-label">Repeat</p><div>
              <select className="crm-select" value={draft.recurrenceFrequency} onChange={(event) => setDraft({ ...draft, recurrenceFrequency: event.target.value })}><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
              {draft.recurrenceFrequency && <><label>Every <input className="crm-input" type="number" min="1" max="99" value={draft.recurrenceInterval} onChange={(event) => setDraft({ ...draft, recurrenceInterval: event.target.value })} /> {draft.recurrenceFrequency === "daily" ? "day(s)" : draft.recurrenceFrequency === "weekly" ? "week(s)" : "month(s)"}</label><label>Until <input className="crm-input" type="date" value={draft.recurrenceUntil} onChange={(event) => setDraft({ ...draft, recurrenceUntil: event.target.value })} /></label></>}
            </div></div>
             <label className="crm-field ai-cal-wide"><span className="crm-field-label">Notes</span><textarea className="crm-textarea" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Useful context for attendees" /></label>
             <label className="crm-field ai-cal-wide"><span className="crm-field-label">Conflict override reason · managers only</span><input className="crm-input" value={draft.overrideReason} onChange={(event) => setDraft({ ...draft, overrideReason: event.target.value })} placeholder="Required when an authorized manager overrides a conflict" /></label>
          </div>
          {formError && <div className="crm-error" role="alert">{formError}</div>}
          <div className="crm-dialog-actions"><button className="crm-button" type="button" disabled={createEvent.isPending || updateEvent.isPending} onClick={() => setFormOpen(false)}>Cancel</button><button className="crm-button crm-button-primary" type="submit" disabled={createEvent.isPending || updateEvent.isPending}>{createEvent.isPending || updateEvent.isPending ? "Saving…" : editingEvent ? "Save changes" : "Create event"}</button></div>
        </form>
      </div>}

      {inboxOpen && <div className="crm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInboxOpen(false); }}>
        <section className="crm-dialog ai-cal-dialog ai-cal-inbox" role="dialog" aria-modal="true" aria-labelledby="ai-inbox-title">
          <div className="ai-cal-dialog-head"><div><p className="crm-eyebrow">Updates that matter</p><h2 id="ai-inbox-title">Your inbox <span className="ai-cal-unread-count">{unreadCount} unread</span></h2></div><button className="crm-icon-button" type="button" onClick={() => setInboxOpen(false)} aria-label="Close inbox"><X size={17} /></button></div>
          {inboxQuery.isLoading ? <div className="ai-cal-inbox-loading"><div className="crm-skeleton" /><div className="crm-skeleton" /></div> : inboxQuery.isError ? <div className="crm-error" role="alert">Inbox could not be loaded. <button className="crm-text-button" type="button" onClick={() => void inboxQuery.refetch()}>Try again</button></div> : !(inboxQuery.data?.items.length) ? <div className="crm-empty ai-cal-inbox-empty"><BellOff size={23} /><strong>All caught up</strong><p>Calendar updates will appear here.</p></div> : <>
            <div className="ai-cal-inbox-tools"><span>{inboxQuery.data?.items.length} updates</span><button type="button" className="crm-text-button" disabled={!unreadCount || markAllRead.isPending} onClick={() => markAllRead.mutate()}>Mark all read</button></div>
            <div className="ai-cal-inbox-list">{inboxQuery.data?.items.map((item) => <article key={item.id} className={`ai-cal-inbox-item ${item.readAt ? "is-read" : ""}`}><div className={`ai-cal-priority priority-${item.priority}`} /><div><div className="ai-cal-inbox-title">{item.title}<span>{item.priority}</span></div><p>{item.body}</p><small>{dateLabel(new Date(item.createdAt), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · {item.category}</small><div className="ai-cal-inbox-actions">{item.link && <a href={item.link}>Open related item</a>}{!item.readAt && <button type="button" onClick={() => markRead.mutate(item.id)} disabled={markRead.isPending}>Mark read</button>}</div></div></article>)}</div>
          </>}
          {markRead.isError || markAllRead.isError ? <div className="crm-error" role="alert">Could not update read status. Please try again.</div> : null}
        </section>
      </div>}

      {settingsOpen && <div className="crm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="crm-dialog ai-cal-dialog ai-cal-settings" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
          <div className="ai-cal-dialog-head"><div><p className="crm-eyebrow">Your calendar, your way</p><h2 id="ai-settings-title">Notifications</h2></div><button className="crm-icon-button" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close preferences"><X size={17} /></button></div>
          {preferencesQuery.isLoading ? <div className="crm-skeleton" /> : preferencesQuery.isError ? <div className="crm-error" role="alert">Notification preferences could not be loaded. <button className="crm-text-button" type="button" onClick={() => void preferencesQuery.refetch()}>Try again</button></div> : preferencesQuery.data && <>
            <div className="ai-cal-pref-row"><div><strong>In-app inbox</strong><span>Calendar changes and reminders inside Aroma Institute</span></div><label className="ai-cal-switch"><input type="checkbox" checked={preferencesQuery.data.inAppEnabled} onChange={(event) => savePref({ inAppEnabled: event.target.checked })} /><span aria-hidden="true" /></label></div>
            <div className="ai-cal-pref-row"><div><strong>Quiet hours</strong><span>Pause reminders during your chosen window</span></div><div className="ai-cal-quiet-hours"><input className="crm-input" aria-label="Quiet hours start" type="time" value={preferencesQuery.data.quietHoursStart ?? ""} onChange={(event) => savePref({ quietHoursStart: event.target.value || null })} /><span>to</span><input className="crm-input" aria-label="Quiet hours end" type="time" value={preferencesQuery.data.quietHoursEnd ?? ""} onChange={(event) => savePref({ quietHoursEnd: event.target.value || null })} /></div></div>
            <div className="ai-cal-pref-row ai-cal-pref-column"><div><strong>Reminder lead time</strong><span>Select how early a reminder should arrive</span></div><div className="ai-cal-reminders">{[5, 15, 30, 60].map((minutes) => <label key={minutes}><input type="checkbox" checked={preferencesQuery.data.reminderOffsetsMinutes.includes(minutes)} onChange={(event) => {
              const current = preferencesQuery.data?.reminderOffsetsMinutes ?? [];
              savePref({ reminderOffsetsMinutes: event.target.checked ? [...current, minutes].sort((a, b) => a - b) : current.filter((value) => value !== minutes) });
            }} />{minutes < 60 ? `${minutes} min` : "1 hour"}</label>)}</div></div>
            <div className="ai-cal-push-card"><div className="ai-cal-push-icon"><Smartphone size={18} /></div><div><strong>Push on this device</strong><span>{preferencesQuery.data.pushEnabled ? "Enabled for this account" : "Off · requires an explicit browser permission"}</span></div>{preferencesQuery.data.pushEnabled ? <button className="crm-button" type="button" disabled={unsubscribePush.isPending} onClick={disablePush}>{unsubscribePush.isPending ? "Turning off…" : "Disable"}</button> : <button className="crm-button crm-button-primary" type="button" disabled={subscribePush.isPending || pushKeyQuery.isLoading} onClick={enablePush}>{subscribePush.isPending ? "Enabling…" : "Enable push"}</button>}</div>
            {pushMessage && <div className="crm-info ai-cal-push-message" role="status">{pushMessage}</div>}
            {/iPhone|iPad|iPod/i.test(typeof navigator === "undefined" ? "" : navigator.userAgent) && !preferencesQuery.data.pushEnabled && <div className="ai-cal-ios-help"><strong>On iPhone or iPad</strong><p>For push alerts, add Aroma Institute to your Home Screen first: open this page in Safari, tap Share, then choose <b>Add to Home Screen</b>. Open the Home Screen app, then tap Enable push here.</p></div>}
          </>}
          {updatePreferences.isError && <div className="crm-error" role="alert">Your preference could not be saved. Try changing it again.</div>}
          {updatePreferences.isPending && <p className="ai-cal-saving" role="status"><Check size={14} /> Saving preferences…</p>}
        </section>
      </div>}
    </main>
  );
}

function EventChip({ event, resourceName, onClick }: { event: CalendarEvent; resourceName?: string; onClick: () => void }) {
  return <button className={`ai-cal-event ${`ai-cal-${event.category}`} ${event.status === "cancelled" ? "is-cancelled" : ""}`} type="button" onClick={onClick} aria-label={`${event.title}, ${dateLabel(new Date(event.startsAt), { hour: "numeric", minute: "2-digit" })}, ${event.status}`}>
    <span className="ai-cal-event-time">{event.allDay ? "All day" : dateLabel(new Date(event.startsAt), { hour: "numeric", minute: "2-digit" })}</span>
    <strong>{event.title}</strong>
    {(event.location || resourceName) && <small>{resourceName ?? event.location}</small>}
  </button>;
}
