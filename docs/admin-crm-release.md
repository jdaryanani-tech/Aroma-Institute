# AICHM Admissions CRM — workspace release notes

## Routes and boundaries

`/admin` is the sole CRM entry. `/admin/login` uses the existing phone/password
authentication and PostgreSQL-backed session, returns admins to `/admin`, and
rejects other roles. No `/crm` route or redirect exists. The learning portal,
learning PWA, public domains/VSL, questionnaire, webhook sender and existing retry
route are not replaced.

New endpoints:

- `GET /api/admin/crm/leads`: validated search, stage/program/source/activity-date/
  follow-up/owner filters, sorting, server-side pagination and global overview.
- `GET /api/admin/crm/leads/:id`: one grouped identity, all inquiry submissions,
  questionnaire answers, recorded delivery attempts, observed video evidence,
  profile and chronological activity history.
- `PATCH /api/admin/crm/leads/:id`: optimistic version check, explicit lifecycle
  evidence/reason, owner, follow-up or appended internal note.

Every CRM endpoint uses the existing server-side active-user and admin-role
guards. Writes also require same-origin requests. Responses are private/no-store.
Applicant content, secrets and SQL error details are never logged by these routes.
Old inquiry/retry APIs remain in place and retain their existing authorization.

## Identity and totals

The CRM never inserts a person or inquiry while browsing or editing a profile.
It groups existing authoritative `lead_id` links. A unique unlinked phone match
may be displayed with its unambiguous existing identity; ambiguous historical
records stay separate and explicitly unresolved. Phone formatting follows the
existing Indian `91` + ten digits convention.

Identified people and stage counts exclude ambiguous/unmatchable records.
Unresolved records are reported separately, not guessed to be distinct people.
Total enquiries counts all inquiry records, including registrations/submissions.
All historical rows and questionnaire JSON remain unchanged by CRM edits.

CRM metadata/history is anchored to an existing inquiry. If safe identity linking
later brings inquiries together, the read model groups their history, selects the
latest profile, and aggregates version counters. It does not delete, duplicate or
overwrite earlier profiles or inquiry answers.

## Lifecycle evidence

- New Enquiry, Contacted, Qualified, Counselling Pending, Nurture and Lost require
  an explicit admin decision/reason when manually changed.
- VSL Shared records an actually sent external message, with staff confirmation,
  reference and past send time. Opening/copying a link does not set this stage.
  The CRM itself does not send WhatsApp messages.
- VSL Watched requires a stored observed milestone (25% or beyond), or an explicit
  prospect confirmation clearly marked **self-reported**.
- Form Submitted requires stored questionnaire JSON and a recorded submission
  timestamp. Webhook receipt is not form/booking proof.
- Counselling Booked is blocked until a trusted server-side path verifies a
  successful Cal.com booking ID. No such existing path was found; arbitrary IDs
  entered by staff are not accepted.
- Counselling Attended and Enrolled require explicit, referenced staff records.

With no manual stage, a timestamped questionnaire or stored video milestone can
derive the corresponding system stage; the saved source event appears in the
timeline. A notes/owner/follow-up edit does not freeze that derived stage.
Manual stage, owner, follow-up and note changes are transactional and record the
server timestamp and authenticated actor. Stale/concurrent edits return 409.

Stage counts are current states, not necessarily a sequential funnel. The
registered-to-form share uses people with a saved VSL registration as its cohort.
Registered without a form means **not yet recorded**, not proven abandonment.
Observed playback summaries do not count self-reported viewing as verified tracking.

## Migration inspection and repair

Inspection found the same older Drizzle migration ledger in development and
production, while the real schemas include later changes. The failed publish
compiled successfully but failed at schema application. Its attempted verification
columns are already present with matching types in both environments.

**Do not run the whole historical `db:migrate` chain against these databases.**
Do not alter migration ledger records or add migration commands to startup/build.

`migrations/0007_admissions_crm.sql` is additive and repeatable:

- Adds either missing delivery-verification column with `IF NOT EXISTS`.
- Creates `admissions_crm_profiles` and `admissions_crm_activities`.
- Guards foreign keys by constraint name and relation.
- Creates indexes with `IF NOT EXISTS`.
- Does not copy data, backfill identities, drop/rename columns or overwrite answers.

The new migration is applied to **development only**. Stage 1's existing
`0006_admissions_stage_one.sql` remains the additive identity/video migration.
Production lacks Stage 1 and CRM tables until the normal approved Publish schema
flow applies the development→production diff. CRM reads detect unavailable tables
and explain limitations; edits are disabled if CRM persistence is unavailable.
No startup-time DDL or direct production-migration script is introduced.

The inspected release diff reports no structural data loss, no table/column
removals, and no repeated additions of the already-present verification columns.
`npm run db:check:crm` is a read-only workspace readiness check; it never migrates.
Actual successful production schema application still requires a user-reviewed
publish; a local build cannot prove that future deployment step succeeded.

## iPhone/PWA

The CRM uses readable lead cards, sticky search/filter controls, desktop detail
and full-screen mobile detail, touch-sized controls and safe-area spacing.

Independent admin installation assets:

- `/admin.webmanifest`, identity/start URL/scope `/admin`.
- `/admin-sw.js`, registered with scope `/admin`, covering exact `/admin` and
  `/admin/login` (a `/admin/` scope alone would miss the required root).
- Admin-specific PNG icons, theme and Safari Add to Home Screen instructions.

The admin worker is network-only and never opens browser caches, IndexedDB or
offline lead storage. CRM API fetches explicitly use no-store. Only the install
reminder preference may be persisted locally; no contacts, notes, answers, tokens
or conversations are saved offline. `/learn` keeps its original manifest/worker.
Installation never bypasses login or grants an admin role.

## Safe test commands

1. `npm run check`
2. `npm run build` — compilation only; no migration/deploy hook.
3. `NODE_ENV=test CRM_TEST_DB_WRITE_APPROVED=TEMPORARY_DEVELOPMENT_SCHEMA_ONLY ADMISSIONS_TEST_DB_WRITE_APPROVED=TEMPORARY_DEVELOPMENT_SCHEMA_ONLY npm test`
   — database tests use disposable uniquely named development schemas with only
   synthetic records; main applicant rows are not read/copied/modified.
4. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/repl/tools/bin/chromium npm run test:lms-admin`
   — creates a separate socket-only PostgreSQL cluster, seeds synthetic accounts,
   runs actual password/session/role tests and shuts down/deletes the cluster.
   Its `db:push --force` targets only that new disposable cluster, never the app DB.
5. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/repl/tools/bin/chromium npx playwright test --project=chromium --output=generated-artifacts/crm-browser`
   — browser CRM fixtures intercept data/writes/retries; no live webhook is called.

Never use a real questionnaire submission or resend as a test without separately
approving delivery: those existing actions retain their live downstream behavior.

## Release review

Workspace verification: TypeScript and production compilation pass. The default
suite passed 45 checks; its two opt-in authentication checks passed separately
against the disposable PostgreSQL cluster. All 16 Chromium scenarios were verified,
including targeted reruns after fixing mobile sticky-filter tap interception,
desktop filter-drawer visibility and an inaccessible-background retry assertion.
Actual iPhone/Safari Home Screen installation remains a post-publish manual check.

1. Review the managed production schema diff again immediately before publishing.
2. Confirm there are only the expected additive Stage 1/CRM changes; no data-overwrite
   option, destructive rename, table removal or historical migration replay.
3. Publish only with explicit user approval.
4. Verify dedicated login, authorized CRM list/detail, PWA scope, logout and refresh
   on the actual HTTPS site and an iPhone/Safari Home Screen installation.
5. Leave chat history labelled not connected and booked-stage verification blocked
   until separately approved secure integrations provide real evidence.

No production publish, production data write, historical resend, WhatsApp send,
n8n workflow change, DNS change or secret change was performed for this work.
