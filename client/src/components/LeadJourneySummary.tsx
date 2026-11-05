import type { LeadJourneySummaryData } from "@shared/admissions-schema";

type Props = {
  journey: LeadJourneySummaryData | null | undefined;
};

const milestoneLabels: Record<string, string> = {
  started: "Started",
  "25": "25% milestone observed",
  "50": "50% milestone observed",
  "75": "75% milestone observed",
  "90": "90% milestone observed",
  completed: "Completed",
};

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export default function LeadJourneySummary({ journey }: Props) {
  if (!journey) {
    return (
      <section
        className="mt-3 rounded-lg border border-white/10 bg-white/[0.025] p-3 text-xs"
        aria-label="Video journey"
        data-testid="lead-journey-unavailable"
      >
        <p className="font-semibold text-white/65">Video journey</p>
        <p className="mt-1 leading-relaxed text-white/40">
          No linked journey record is available. This may be an older inquiry or an unlinked visit; it does not confirm whether a video registration occurred.
        </p>
      </section>
    );
  }

  const completedEvent = journey.events.find((event) => event.event === "completed");
  const lastEvent = journey.events.reduce<(typeof journey.events)[number] | null>(
    (latest, event) => {
      if (!latest) return event;
      const latestTime = new Date(latest.occurredAt).getTime();
      const eventTime = new Date(event.occurredAt).getTime();
      return Number.isFinite(eventTime) && (!Number.isFinite(latestTime) || eventTime > latestTime)
        ? event
        : latest;
    },
    null,
  );
  const registeredAt = formatTimestamp(journey.registeredAt);
  const lastRegisteredAt = formatTimestamp(journey.lastRegisteredAt);
  const milestoneTime = formatTimestamp(lastEvent?.occurredAt);
  const questionnaireTime = formatTimestamp(journey.questionnaireCompletedAt);
  const legacyAmbiguous = journey.legacyMatchStatus.toLowerCase().includes("ambiguous");

  return (
    <section
      className="mt-3 rounded-lg border border-white/10 bg-white/[0.025] p-3 text-xs"
      aria-label="Video journey"
      data-testid={`lead-journey-${journey.leadId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="font-semibold text-white/75">Observed video journey</h3>
        <span className="font-mono text-[10px] text-white/40">Lead {journey.leadId}</span>
      </div>

      <div className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-white/35">VSL registration</p>
          <p className="mt-0.5 text-white/70">
            {registeredAt ?? "Registration timestamp not recorded"}
          </p>
          {journey.entrySource && (
            <p className="mt-0.5 break-words text-white/45">Source: {journey.entrySource}</p>
          )}
          {(journey.entryPath || journey.entryHost) && (
            <p className="mt-0.5 break-all text-white/35">
              {[journey.entryHost, journey.entryPath].filter(Boolean).join("")}
            </p>
          )}
          {lastRegisteredAt && lastRegisteredAt !== registeredAt && (
            <p className="mt-0.5 text-white/40">Last registered: {lastRegisteredAt}</p>
          )}
        </div>

        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-white/35">Observed VSL progress</p>
          {lastEvent ? (
            <>
              <p className="mt-0.5 font-medium text-white/75">
                {milestoneLabels[lastEvent.event] ?? lastEvent.event}
              </p>
              {milestoneTime && <p className="mt-0.5 text-white/45">{milestoneTime}</p>}
              {(lastEvent.positionSeconds !== null || lastEvent.durationSeconds !== null) && (
                <p className="mt-0.5 font-mono text-white/45">
                  {lastEvent.positionSeconds !== null ? formatDuration(lastEvent.positionSeconds) : "—"}
                  {" / "}
                  {lastEvent.durationSeconds !== null ? formatDuration(lastEvent.durationSeconds) : "—"}
                </p>
              )}
            </>
          ) : (
            <p className="mt-0.5 text-white/45">No playback milestone observed</p>
          )}
          <p className={`mt-1 font-semibold ${completedEvent ? "text-emerald-300" : "text-amber-200"}`}>
            {completedEvent ? "Video completion recorded" : "Completion not recorded"}
          </p>
        </div>

        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-white/35">Questionnaire</p>
          <p className="mt-0.5 break-words text-white/65">
            {journey.questionnaireStatus === "completed" ? "Completed" : "No linked questionnaire recorded"}
          </p>
          {questionnaireTime && <p className="mt-0.5 text-white/40">Completed: {questionnaireTime}</p>}
        </div>

        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-white/35">Linked inquiries</p>
          <p className="mt-0.5 break-words font-mono text-white/60">
            {journey.linkedInquiryIds.length > 0 ? journey.linkedInquiryIds.join(", ") : "None linked"}
          </p>
        </div>
      </div>

      {legacyAmbiguous && (
        <p className="mt-2 rounded-md border border-amber-300/20 bg-amber-300/[0.06] px-2.5 py-2 leading-relaxed text-amber-100/75" role="note">
          Legacy match is ambiguous: multiple older inquiries share this mobile. They were not automatically linked or merged.
        </p>
      )}
    </section>
  );
}
