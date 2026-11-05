# Admissions journey — Stage 1

## Scope and database

The unified identity is an `admissions_leads` UUID keyed by a unique canonical Indian
mobile (`91` + ten digits). This is a contact association, **not verification of phone
ownership** and must not be used to authenticate applicants or reveal their history.

Migration `migrations/0006_admissions_stage_one.sql` is additive and repeatable:

- `admissions_leads`: identity, registration/source and questionnaire state.
- Nullable indexed `inquiries.lead_id`: preserves every existing inquiry and answer.
- `admissions_vsl_playbacks`: session-bound observation state and coverage intervals.
- `admissions_vsl_events`: timestamped milestones, unique on lead + event.
- `admissions_capture_limits`: atomic persistent capture rate limits.

No data is copied from development to production. No historical rows are bulk
merged. New registrations/submissions lazily link exactly one matching unlinked
legacy inquiry. Two or more matching legacy inquiries remain untouched and are
flagged ambiguous. Historical timestamps are never invented.

The historical migration ledger predates some schema pushes. Do not replay the
whole migration chain against an existing database without reconciling it.
Development uses schema synchronization or this specific additive migration;
managed production schema changes remain exclusively the user-approved Publish flow.

## Public capture and identity

- `POST /api/vsl/registrations`: `{name, phone, entryPath}`; upserts identity,
  first/last registration times, source/path/host. Creates at most one registration
  inquiry if the identity has no inquiry. Returns only `{registered:true}`.
- The server stores `admissionsLeadId` in the existing persistent, HttpOnly,
  SameSite session cookie. No lead ID, phone, or secret is put in a URL or localStorage.
- The VSL links to `/counselling` on the same hostname. Questionnaire submission
  resolves identity from the submitted normalized mobile. Same phone means the same
  identity, including across browsers; a different phone means a different identity.
  Client-supplied `leadId` is never accepted.
- `POST /api/counselling-inquiries` retains its existing response and local-save-first
  webhook flow. Each completed questionnaire remains its own saved submission with
  its original inquiry-based webhook/idempotency identifier and all 29 answers.
  It also records lead-level completion state/time. Old answers are not overwritten.
- `POST /api/vsl/playbacks`: creates a random playback token only for a registered
  session. The actual VSL duration is read from the server's HLS VOD manifest.
- `POST /api/vsl/events`: `{playbackId, sequence, type, position, duration}`.
  Types are `play`, `sample`, `pause`, `seek`, `ended`. The server checks session
  association, sequence, manifest duration, position, continuity and elapsed-time
  plausibility. Arbitrary lead IDs are rejected.

Registration, playback initialization, event capture and questionnaire saves have
persistent IP-based rate limits. New capture routes require same-origin writes.
Playback tokens expire after 24 hours. Requests are serialized and event delivery
retries reuse the same sequence number. Database row locks and unique indexes make
duplicates harmless.

## What counts as watched

The browser sends observations approximately every four seconds plus play, pause,
seek and ended signals. Seeking, long discontinuities, and implausible jumps do not
add coverage. A milestone requires an observed interval actually crossing that
threshold and at least 95% observed prefix coverage. Completion requires an ended
signal, observed coverage reaching the end, and at least 95% total observed coverage.
Wall-clock time alone cannot complete a video.

These are conservative browser observations, not proof of attention or protection
against a deliberately modified browser. Refresh/new playback runs start fresh
coverage; already persisted lead milestones remain. Dropped requests or long
network/browser suspension can undercount rather than claim unobserved progress.
There is no offline durable queue or automatic cross-device resume in Stage 1.

The counselling CTA remains visible from initial video load. Its previous halfway
check still exists, but initial visibility was already `true` and is unchanged.
Umami hooks remain optional; database persistence does not depend on them.

## Admin surface

The existing `/admin` Leads Dashboard and admin-only `GET /api/admin/inquiries` show
the stable identity and linked inquiry IDs, registration/source, last recorded
milestone/time/position, video completion, questionnaire status/time, and ambiguous
legacy warnings. There is no public lead/history lookup.

Stage 1 adds no WhatsApp/AVNI follow-up triggers from registration or video events.
Existing counselling webhook behavior/configuration is unchanged. No calendar
booking is confirmed by video events or questionnaire receipt.

## Safe validation

1. `npm run check` and `npm run build`.
2. `npm test`: pure normalization/coverage/client queue tests and existing regressions.
3. For database persistence checks in the workspace development database:
   `NODE_ENV=test ADMISSIONS_TEST_DB_WRITE_APPROVED=TEMPORARY_DEVELOPMENT_SCHEMA_ONLY npm run test:admissions`.
   This explicitly creates a disposable uniquely named schema, clones **schema only**
   for inquiries, replaces its serial default with an isolated sequence, applies the
   additive migration twice, exercises synthetic records and HTTP capture, and drops
   only that schema. It never calls n8n, sends messages, or writes normal applicant rows.
   Never run this command with a production connection.
4. `npx playwright test --project=chromium --output=generated-artifacts/admissions-browser`:
   browser fixtures mock registration, capture, questionnaire submission and admin
   data. No real applicant submission or live webhook is used. When the matching
   bundled browser is unavailable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the
   installed system Chromium executable for that command.

For a human preview, register only with an owner-approved test number, watch
without seeking, then inspect `/admin` as an authorized admin. **Submitting the real
counselling form still invokes the existing configured webhook**; do not use that
as a safe test without separately arranging a mocked/nonproduction receiver.

## Changed-file manifest

- Identity/schema: `shared/indian-mobile.ts`, `shared/admissions-schema.ts`,
  `shared/schema.ts`.
- Server: `server/admissions/identity.ts`, `server/admissions/playback.ts`,
  `server/admissions/routes.ts`, `server/admissions/summary.ts`,
  `server/routes.ts`, `server/storage.ts`, `server/vsl-media.ts`.
- Client: `client/src/pages/VSL.tsx`, `client/src/pages/VSLVideo.tsx`,
  `client/src/pages/Admin.tsx`, `client/src/lib/vsl-capture.ts`,
  `client/src/components/LeadJourneySummary.tsx`.
- Migration: `migrations/0006_admissions_stage_one.sql`,
  `migrations/meta/0006_snapshot.json`, `migrations/meta/_journal.json`.
- Tests/tooling: `server/admissions/playback.test.ts`,
  `server/admissions/persistence.test.ts`, `server/n8n-counselling.test.ts`,
  `client/src/lib/vsl-capture.test.ts`, `tests/browser/admissions-journey.spec.ts`,
  `tests/browser/vsl.spec.ts`, `tests/browser/counselling.spec.ts`,
  `package.json`, `playwright.config.ts`.
- Documentation: this file; `.agents/memory/lead-identity-trust.md` and its index
  preserve the privacy/association distinction and historical-match policy.
