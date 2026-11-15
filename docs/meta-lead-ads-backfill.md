# Historical Meta Lead Ads import

The Admissions Workspace includes an administrator-only **Historical Meta Lead Import** panel. It is manual and preview-first: opening the page does not call Meta, and the application does not start an import automatically. Admissions staff cannot enumerate forms, preview, or import.

## Before using it

- The server needs `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN`, `META_GRAPH_API_VERSION`, and `SESSION_SECRET` in its environment. Values are read only by server code; they are never returned to the browser.
- The Page token must identify the configured Page and have Meta's `leads_retrieval` permission. Meta may reject a form or time range based on the app, Page, token, permissions, or Meta's data availability. The tool reports a sanitized category; it does not expose Meta's raw error message.
- The CRM Meta lead-link schema must be installed. The tool will not install or migrate schema.
- Verify the Page and selected forms in Meta before importing. Form inventory is fetched live when an admin explicitly selects **Load forms**. Active, inactive, and archived forms are shown if Graph returns them.

## Preview and import

1. In **Admin → Admissions Workspace**, open **Historical Meta Lead Import**.
2. Choose **Load forms**, select up to 50 forms, and choose a start and end date. The default is the last 90 calendar days in `Asia/Kolkata`; the maximum range is 365 days. The displayed UTC bounds are start-inclusive and end-exclusive.
3. Choose **Run read-only preview**. Preview fetches selected form submissions in batches of 40 and does not create or update CRM records. It reports aggregate counts by form: fetched, already present by exact Meta lead ID, eligible new, valid recognized phone, and phone requiring review. Identity matching is not predicted from names; it is determined by the normal CRM persistence path if an admin later imports.
4. Review the exact window, selected forms, and eligible-new total. Only then choose **Import the displayed number of new submissions**. Import re-fetches each page from Meta and passes submissions through the same `saveMetaInstantLead()` path as webhook intake. Existing Meta lead IDs are skipped idempotently; invalid or missing phone numbers remain in the existing review workflow.
5. If Meta rate-limits the request or a transient failure occurs, use the displayed resume action after any indicated wait. Continuation state is encrypted/authenticated, admin-bound, and expires after 24 hours (or shortly after a longer Retry-After). It contains cursors, aggregate progress, and keyed fingerprints for the current batch—not lead field data or contact details.

## Scope and limits

- Requests are made server-side to the fixed HTTPS Graph API host using the configured Graph version. The code reconstructs cursor requests and never follows Meta's `paging.next` URL.
- A request handles at most 40 submissions; a form scan stops after 800 pages (at most 32,000 submissions per form per run). If the selected range exceeds the limit, narrow the date range or selected forms and run a new preview.
- The importer does not guess identity from names or email, merge people, overwrite existing enquiries, or change the real-time webhook. It uses exact Meta lead ID idempotency and the existing phone parser (including `whatsapp_number`).
- No backfill job table or schema migration is required. Preview is read-only; import writes only through the existing admissions persistence path. Counts contain no contact details or Meta lead identifiers.
- A Meta form may have been reused across campaigns. Form-level totals are not campaign-level totals.
