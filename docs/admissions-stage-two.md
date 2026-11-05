# Stage 2 — registration follow-up foundation

## Scope and release state

Workspace code only. No production or normal development migrations are applied.
No dispatcher, schedule, outbound workflow or WhatsApp automation is activated.
The native dispatcher cannot send in development. Tests use a new socket-only
PostgreSQL cluster and injected fake webhook transports.

Stage 1 remains compatible with the old schema. The VSL page asks the public,
non-personal `GET /api/vsl/registration-options` whether consent persistence is
available. Until migration, the optional checkbox is unchecked/disabled with an
explanation, and ordinary registration/video access remains available. An opt-in
cannot silently succeed without storage: an opted-in request while schema is
unavailable receives a safe 503. Ordinary legacy clients need not send new fields.

## Consent

Registration accepts two additive fields:

```json
{
  "whatsappAdmissionsConsent": false,
  "consentVersion": "whatsapp-admissions-v1"
}
```

Positive consent requires the exact currently served version. The server stores
its own canonical text/version, not arbitrary browser text.

Text is defined in `shared/vsl-consent.ts`:

> Haan, Aroma Institute mujhe WhatsApp par admissions aur counselling follow-up ke liye contact kar sakta hai. Yeh optional hai; main kabhi bhi opt out kar sakta/sakti hoon.

Unchecked means no new permission; it is not an opt-out action. Returning with the
default unchecked checkbox never silently revokes an earlier grant. An existing
opt-out can never be cleared by registering again, checking the box, or submitting
question 29. A future explicit re-opt-in flow needs separate approval.

`recordWhatsAppOptOut` is an internal server-side helper with `admin`, `n8n` or
`prospect` provenance. There is deliberately no public opt-out write endpoint in
this read-only integration foundation. The existing bot/n8n workflows are unchanged;
STOP/opt-out ingestion is not connected yet.

Question-29 consent stays in `inquiries.counselling_answers.consentToContact`.
The status endpoint returns it independently, with the saved inquiry ID and
submission timestamp (possibly null for historical records). It does not turn
counselling coordination permission into WhatsApp admissions permission.
A saved opt-out overrides both effective `allowed` values.

## Migration and exact schema

`migrations/0008_admissions_follow_up.sql` (plus generated snapshot/journal) creates
two tables, with no rewrite/backfill of existing identities, inquiries or answers.
It is additive/idempotent: guarded table/index creation and foreign-key additions.
No old migration is replayed.

`admissions_lead_contact_preferences`:

- `lead_id` UUID primary key / FK → `admissions_leads.id`
- `consent_status`: `not_provided`, `granted`, `opted_out`
- `consent_recorded_at`, `consent_source`, `consent_text`, `consent_version`
- `status_updated_at`, `opted_out_at`, `opt_out_source`

This is one-to-one consent metadata attached to the existing stable identity,
not another people table/database. Absent preferences mean `not_recorded`.

`admissions_registration_outbox`:

- `id`, `lead_id`, `event_type`, `idempotency_key`, `payload`
- `state`: `pending`, `sending`, `acknowledged`, `failed`
- `created_at`, `available_at`, `attempt_count`, `last_attempt_at`
- `response_at`, `acknowledged_at`, `last_http_status`, `last_error`
- `locked_at`, `lock_token`

`idempotency_key` is unique. Indexes:
`admissions_registration_outbox_due_idx` (`state`, `available_at`) and
`admissions_registration_outbox_lead_idx` (`lead_id`).

No columns are added to `admissions_leads`, so existing Stage 1 ORM reads/writes
continue working before this migration is applied. Old registrations are not
replayed/backfilled. Only a first registration after schema readiness creates the
event; repeat registrations update the same person and do not create another event.
An identity created by a questionnaire, but not yet VSL-registered, can subsequently
create its first registration event.

## Outbound event and delivery contract

The first VSL registration transaction atomically saves consent and queues:

```json
{
  "schemaVersion": 1,
  "event": "vsl.registered",
  "eventId": "vsl-registration:<stable-lead-UUID>",
  "leadId": "<stable-lead-UUID>",
  "phone": "<91-prefixed-Indian-mobile>",
  "name": "<stored-name>",
  "registeredAt": "<ISO timestamp>",
  "source": "vsl_registration",
  "entryPath": "/vsl",
  "entryHost": "<registration-host>",
  "consentToContact": false,
  "consent": {
    "status": "not_provided",
    "recordedAt": "<ISO timestamp>",
    "source": "vsl_registration",
    "text": "<canonical consent text>",
    "version": "whatsapp-admissions-v1",
    "optedOut": false,
    "optedOutAt": null,
    "optOutSource": null,
    "allowed": false
  }
}
```

`payload` is an immutable first-event snapshot. Each delivery refreshes outbound
consent from current preferences, so an old grant is not replayed after opt-out.
The stable event ID/idempotency key is preserved across attempts.

Sender: `dispatchVslRegistrationOnce` in
`server/admissions/outbox-dispatcher.ts`. No startup call, interval, public dispatch
route, CLI sender or workflow is installed.

- Feature switch: function option `enabled`, default **false**
  (`VSL_DISPATCH_DEFAULT_ENABLED=false`).
- Outside production, native delivery is blocked even when `enabled:true`.
  Only tests explicitly inject a fake transport.
- Exactly two integration environment variables, both server-only:
  `N8N_VSL_REGISTRATION_WEBHOOK_URL` and
  `N8N_VSL_REGISTRATION_WEBHOOK_SECRET`.
- Neither variable is set/requested/changed for this work.
- URL must use HTTPS on `n8n.aromacafeinstitute.in` with a dedicated
  `/webhook/<slug>` path, no credentials/query/fragment/non-default port.
  Existing counselling and WhatsApp endpoints are explicitly rejected.
- Outbound authentication: one `x-aichm-webhook-secret` header containing the
  trimmed raw secret. No Bearer/Authorization header.
- `Idempotency-Key` equals `eventId`; redirects are rejected; timeout is 10 seconds.
- Acknowledged only for HTTP 2xx plus JSON
  `{ "received": true, "eventId": "<matching eventId>" }`.
- Non-2xx, invalid/mismatched acknowledgement, malformed JSON and timeouts fail.
  Only static safe summaries and HTTP status are stored; bodies/secrets are not.
- Retry delay: 30 seconds, doubling each attempt (24-hour upper bound), at most
  eight attempts. Failed events remain available for manual review after exhaustion.
- Atomic `SKIP LOCKED` claim, 60-second lease and lock-token-guarded result writes
  prevent concurrent sends of the same active job. An abandoned lease can recover.

Delivery is **at least once**, not magic exactly-once. n8n must deduplicate by
`eventId` before creating downstream side effects. An acknowledged registration is
not permission to message or a confirmed appointment.

## Authenticated read-only status API

`GET /api/integrations/n8n/leads/:leadId/status`

The path accepts only a stable UUID. Send the same custom secret header above.
Admin/applicant cookies alone, Bearer auth and query-string secrets do not grant
access. Missing secret/schema fails closed with 503; missing/wrong header is 401;
malformed UUID is 400; unknown UUID is 404. Authenticated reads are rate-limited
in memory and do not write lead records. All responses are private/no-store.

Response:

```json
{
  "leadId": "<UUID>",
  "phone": "<91-prefixed-Indian-mobile>",
  "name": "<stored-name>",
  "registeredAt": "<ISO timestamp or null>",
  "questionnaire": { "status": "completed", "completedAt": "<ISO timestamp or null>" },
  "consent": {
    "whatsappAdmissions": {
      "status": "granted",
      "recordedAt": "<ISO timestamp or null>",
      "source": "vsl_registration",
      "text": "<canonical text>",
      "version": "whatsapp-admissions-v1",
      "optedOut": false,
      "optedOutAt": null,
      "optOutSource": null,
      "allowed": true
    },
    "counsellingQuestion29": {
      "consentToContact": true,
      "recordedAt": "<ISO timestamp or null>",
      "inquiryId": 123,
      "source": "counselling_question_29",
      "allowed": true
    },
    "optedOut": false,
    "optedOutAt": null
  }
}
```

No questionnaire answers, email, notes, messages, cookies or secrets are returned.
n8n must check current status/opt-out immediately before outreach. Questionnaire
completion is available independently to stop or adapt questionnaire reminders.
Phone matching still associates leads; it does not authenticate applicants.

## Counselling compatibility

`server/n8n-counselling.ts` adds only top-level `leadId` (UUID or null).
Existing numeric `lead.id`, `submissionId`, all 29 answers, appointment request,
acknowledgement rules, URL/secret configuration and custom header stay unchanged.
Questionnaire submission still saves locally and updates completion in the same
transaction, then attempts its existing counselling delivery.

## Safe checks and release work still required

Verified in this workspace: TypeScript and production compilation pass; the default
test run passed 44 checks with 5 expected opt-in integration skips. The Stage 2
disposable-database suite then passed both tests with no skips, covering consent,
independent question-29 permission, opt-out preservation, atomic/idempotent queuing,
retry/backoff, acknowledgements, lease recovery/concurrency, retry exhaustion,
status authentication/data minimization, questionnaire completion and payload
compatibility. Six targeted Chromium scenarios passed, including the three consent
states, all 29 questions, HLS playback/seeking and media-failure behavior. The old
VSL test's exact-body assertion was updated for the two additive consent fields.

The running preview reports `whatsappConsentAvailable:false`; the unconfigured
status API returns 503. This is expected and confirms the foundation remains gated,
not activated. No real app submission was made by these browser tests.

- `npm run check`
- `NODE_ENV=test npm test` (opt-in DB/auth suites explicitly skip without approval)
- `npm run test:follow-up` creates/destroys a new local socket-only test cluster,
  uses synthetic data, applies the new migration twice there only, and mocks all
  outbound responses. Its `db:push --force` cannot target the app database because
  the script sets `DATABASE_URL` to its newly created disposable socket database.
- Chromium `tests/browser/vsl-consent.spec.ts` mocks registration/options endpoints;
  no real applicant registration/submission or n8n delivery is made.

Before release, obtain approval to apply/review development and production schema
changes through the normal managed flow, configure a dedicated receiver and secrets
securely, implement its event-ID deduplication/acknowledgement, connect opt-out
ingestion, and approve a controlled deployment/test. Configuring secrets alone
does not activate delivery; a separately reviewed dispatcher invocation is needed.
