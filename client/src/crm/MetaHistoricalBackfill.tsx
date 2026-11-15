import { useMemo, useState } from "react";
import type {
  MetaBackfillForm,
  MetaBackfillProgress,
  MetaBackfillSafeError,
} from "@shared/meta-backfill";

type FormsResponse = { forms: MetaBackfillForm[] };
type ProgressResponse = MetaBackfillProgress & { correlationId?: string };

class SafeBackfillRequestError extends Error {
  constructor(readonly safe: MetaBackfillSafeError) {
    super(safe.message || "Historical import request failed.");
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => null) as (T & MetaBackfillSafeError) | null;
  if (!response.ok) {
    throw new SafeBackfillRequestError({
      code: result && typeof result.code === "string" ? result.code : "backfill_unavailable",
      message: result && typeof result.message === "string" ? result.message : "Historical import is temporarily unavailable.",
      ...(result && typeof result.retryAfterSeconds === "number" ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      ...(result && result.graph ? { graph: result.graph } : {}),
      ...(result && typeof result.continuationToken === "string" ? { continuationToken: result.continuationToken } : {}),
      ...(result && result.progress ? { progress: result.progress } : {}),
    });
  }
  if (!result) throw new Error("Historical import response was unavailable.");
  return result;
}

function defaultDateRange() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = `${fields.year}-${fields.month}-${fields.day}`;
  const start = new Date(`${today}T00:00:00.000Z`);
  // The end date is inclusive, so 90 calendar days are today and the prior 89 days.
  start.setUTCDate(start.getUTCDate() - 89);
  return { startDate: start.toISOString().slice(0, 10), endDate: today };
}

function count(value: number) {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}

export default function MetaHistoricalBackfill() {
  const defaults = useMemo(defaultDateRange, []);
  const [forms, setForms] = useState<MetaBackfillForm[]>([]);
  const [selectedForms, setSelectedForms] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [loadingForms, setLoadingForms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [failure, setFailure] = useState<MetaBackfillSafeError | null>(null);

  const clearPreview = () => {
    if (progress?.phase !== "import") {
      setProgress(null);
      setFailure(null);
      setShowConfirmation(false);
    }
  };

  const loadForms = async () => {
    setLoadingForms(true);
    setFailure(null);
    try {
      const result = await request<FormsResponse>("/api/admin/crm/meta-backfill/forms");
      setForms(result.forms);
      setSelectedForms((current) => current.filter((id) => result.forms.some((form) => form.id === id)));
      clearPreview();
    } catch (error) {
      setFailure(error instanceof SafeBackfillRequestError
        ? error.safe
        : { code: "backfill_unavailable", message: "Meta forms could not be loaded." });
    } finally {
      setLoadingForms(false);
    }
  };

  const run = async (action: () => Promise<ProgressResponse>) => {
    setBusy(true);
    setFailure(null);
    try {
      setProgress(await action());
    } catch (error) {
      if (error instanceof SafeBackfillRequestError) {
        setFailure(error.safe);
        if (error.safe.progress) setProgress(error.safe.progress as ProgressResponse);
      } else {
        setFailure({ code: "backfill_unavailable", message: "The request did not complete. Resume the saved batch or start a new preview." });
      }
    } finally {
      setBusy(false);
    }
  };

  const startPreview = () => run(() => request("/api/admin/crm/meta-backfill/preview/start", {
    formIds: selectedForms,
    startDate,
    endDate,
  }));

  const continuePreview = () => {
    if (!progress) return;
    return run(() => request("/api/admin/crm/meta-backfill/preview/continue", {
      continuationToken: progress.continuationToken,
    }));
  };

  const startImport = () => {
    if (!progress) return;
    setShowConfirmation(false);
    return run(() => request("/api/admin/crm/meta-backfill/import/start", {
      continuationToken: progress.continuationToken,
      confirmed: true,
      count: progress.totals.eligibleNew,
    }));
  };

  const continueImport = () => {
    if (!progress) return;
    return run(() => request("/api/admin/crm/meta-backfill/import/continue", {
      continuationToken: progress.continuationToken,
    }));
  };

  const startAnotherPreview = () => {
    setProgress(null);
    setFailure(null);
    setShowConfirmation(false);
  };

  const toggleForm = (id: string) => {
    if (!selectedForms.includes(id) && selectedForms.length >= 50) {
      setFailure({ code: "form_selection_limit", message: "Select no more than 50 forms for one run." });
      return;
    }
    clearPreview();
    setSelectedForms((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const totals = progress?.totals;
  const importPhase = progress?.phase === "import";
  return (
    <section className="crm-meta-backfill" aria-labelledby="crm-meta-backfill-title" data-testid="crm-meta-backfill">
      <div className="crm-meta-backfill-header">
        <div>
          <p className="crm-eyebrow">Administrator only · Preview before import</p>
          <h2 id="crm-meta-backfill-title">Historical Meta Lead Import</h2>
          <p className="crm-meta-backfill-intro">
            Retrieve existing Instant Form submissions for selected forms and a bounded date range.
            Preview is read-only; import is a separate confirmation.
          </p>
        </div>
        <button className="crm-button" type="button" onClick={loadForms} disabled={loadingForms || busy || importPhase}>
          {loadingForms ? "Loading forms…" : forms.length ? "Refresh form list" : "Load available forms"}
        </button>
      </div>

      <div className="crm-meta-backfill-notice" role="note">
        Historical retrieval requires Meta’s <code>leads_retrieval</code> permission. Availability depends on Meta permissions and retention.
        Forms may be reused across campaigns, so form totals are not campaign totals. Canonical identity resolution is determined during import
        by the existing CRM rules; preview does not infer matches from names.
      </div>

      <div className="crm-meta-backfill-controls">
        <label className="crm-field">
          <span className="crm-field-label">Start date · Asia/Kolkata</span>
          <input className="crm-input" type="date" value={startDate} disabled={busy || importPhase}
            onChange={(event) => { clearPreview(); setStartDate(event.target.value); }} />
        </label>
        <label className="crm-field">
          <span className="crm-field-label">End date · inclusive</span>
          <input className="crm-input" type="date" value={endDate} disabled={busy || importPhase}
            onChange={(event) => { clearPreview(); setEndDate(event.target.value); }} />
        </label>
      </div>

      {forms.length > 0 && <fieldset className="crm-meta-backfill-forms" disabled={busy || importPhase}>
        <legend>Available Page forms · select up to 50 for one run</legend>
        {forms.map((form) => (
          <label className="crm-meta-backfill-form" key={form.id}>
            <input type="checkbox" checked={selectedForms.includes(form.id)} onChange={() => toggleForm(form.id)} />
            <span className="crm-meta-backfill-form-copy">
              <strong>{form.name}</strong>
              <span>Form {form.id} · {form.status} · {form.leadsCount === null ? "lead count unavailable" : `${count(form.leadsCount)} leads`}
                {form.createdAt ? ` · created ${new Date(form.createdAt).toLocaleDateString()}` : ""}
              </span>
            </span>
          </label>
        ))}
      </fieldset>}

      {!importPhase && <div className="crm-meta-backfill-actions">
        <button className="crm-button crm-button-primary" type="button" onClick={startPreview}
          disabled={busy || loadingForms || !forms.length || !selectedForms.length || !startDate || !endDate}>
          {busy && !progress ? "Starting preview…" : "Start read-only preview"}
        </button>
        {progress?.phase === "preview" && progress.state === "running" && <button className="crm-button" type="button" onClick={continuePreview} disabled={busy}>
          {busy ? "Scanning batch…" : "Continue preview batch"}
        </button>}
      </div>}

      {progress && <div className="crm-meta-backfill-results" aria-live="polite">
        <div className="crm-meta-backfill-result-heading">
          <div>
            <h3>{importPhase ? "Import progress" : "Preview results"}</h3>
            <p>{progress.window.startDate} through {progress.window.endDate} · Asia/Kolkata</p>
            <p className="crm-meta-backfill-utc">UTC window: {progress.window.startUtc} to {progress.window.endUtcExclusive} (end exclusive)</p>
          </div>
          <span className="crm-meta-backfill-state" data-state={progress.state}>{progress.state === "complete" ? "Complete" : "More batches remain"}</span>
        </div>
        <div className="crm-meta-backfill-totals">
          <div><span>{importPhase ? "Imported" : "Fetched in window"}</span><strong>{count(importPhase ? totals?.imported ?? 0 : totals?.fetched ?? 0)}</strong></div>
          <div><span>{importPhase ? "Already present / skipped" : "Already in CRM"}</span><strong>{count(totals?.alreadyPresent ?? 0)}</strong></div>
          <div><span>{importPhase ? "Needs identity review" : "Eligible new"}</span><strong>{count(importPhase ? totals?.importReview ?? 0 : totals?.eligibleNew ?? 0)}</strong></div>
          <div><span>{importPhase ? "Failed" : "Phone valid"}</span><strong>{count(importPhase ? totals?.failed ?? 0 : totals?.validPhone ?? 0)}</strong></div>
        </div>
        {!importPhase && <p className="crm-meta-backfill-note">
          {count(totals?.phoneReview ?? 0)} eligible submissions have missing or invalid phone data and would follow the existing review path.
          Matching quality is not estimated in preview.
        </p>}
        <div className="crm-meta-backfill-table-wrap">
          <table className="crm-meta-backfill-table">
            <caption>Counts are aggregated per form. No lead details are shown.</caption>
            <thead><tr>
              <th scope="col">Form</th><th scope="col">Fetched</th><th scope="col">Existing</th>
              {importPhase
                ? <><th scope="col">Imported</th><th scope="col">Review</th><th scope="col">Failed</th></>
                : <><th scope="col">Eligible new</th><th scope="col">Phone valid</th><th scope="col">Review</th></>}
            </tr></thead>
            <tbody>{progress.forms.map((form) => <tr key={form.formId}>
              <th scope="row">{form.name}<small>{form.status} · form {form.formId}</small></th>
              <td>{count(form.fetched)}</td><td>{count(form.alreadyPresent)}</td>
              {importPhase
                ? <><td>{count(form.imported)}</td><td>{count(form.importReview)}</td><td>{count(form.failed)}</td></>
                : <><td>{count(form.eligibleNew)}</td><td>{count(form.validPhone)}</td><td>{count(form.phoneReview)}</td></>}
            </tr>)}</tbody>
          </table>
        </div>

        {progress.phase === "preview" && progress.state === "complete" && progress.totals.eligibleNew > 0 && (
          <button className="crm-button crm-button-primary crm-meta-backfill-import-button" type="button" onClick={() => setShowConfirmation(true)} disabled={busy}>
            Review import of {count(progress.totals.eligibleNew)} new submissions
          </button>
        )}
        {progress.phase === "import" && progress.state === "running" && (
          <button className="crm-button crm-button-primary crm-meta-backfill-import-button" type="button" onClick={continueImport} disabled={busy}>
            {busy ? "Importing batch…" : "Import next batch"}
          </button>
        )}
        {importPhase && progress.state === "complete" && <p className="crm-meta-backfill-note" role="status">
          Import run complete. Existing CRM records were skipped; unmatched phone submissions follow the standard review path.
        </p>}
        {importPhase && progress.state === "complete" && <button className="crm-button crm-meta-backfill-import-button" type="button" onClick={startAnotherPreview}>
          Start another preview
        </button>}
      </div>}

      {failure && <div className="crm-error crm-meta-backfill-error" role="alert">
        {failure.message}
        {failure.retryAfterSeconds !== undefined && <span> Retry after about {count(failure.retryAfterSeconds)} seconds.</span>}
        {failure.progress?.continuationToken && <span> Use the continue button above to resume this saved batch.</span>}
      </div>}

      {showConfirmation && progress?.phase === "preview" && progress.state === "complete" && <div className="crm-dialog-backdrop" role="presentation">
        <section className="crm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="crm-meta-backfill-confirm-title">
          <h2 id="crm-meta-backfill-confirm-title">Confirm historical import</h2>
          <p>
            This will re-fetch the selected forms for the exact date window above and import up to
            <strong> {count(progress.totals.eligibleNew)} new submissions</strong>. Existing Meta lead IDs will be skipped.
            The CRM’s current phone validation, identity matching, and review rules will apply.
          </p>
          <p>No names, contact details, or lead identifiers will be displayed in the results.</p>
          <div className="crm-dialog-actions">
            <button className="crm-button" type="button" onClick={() => setShowConfirmation(false)} disabled={busy}>Cancel</button>
            <button className="crm-button crm-button-primary" type="button" onClick={startImport} disabled={busy}>
              {busy ? "Starting import…" : `Import ${count(progress.totals.eligibleNew)} submissions`}
            </button>
          </div>
        </section>
      </div>}
    </section>
  );
}
