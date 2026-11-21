# CRM, AVNI, and Meta production-readiness runbook

This is an operator checklist, not authorization to change a Production
database, secret, workflow, Page subscription, or deployment. The admin
readiness panel uses **PASS**, **BLOCKED**, and **NOT CHECKED**:

- **PASS** means a runtime check against the named environment completed.
- **BLOCKED** means a known prerequisite failed or a required capability is
  deliberately disabled.
- **NOT CHECKED** means the app has no evidence; configuration presence,
  source code, and unit tests are not proof of live readiness.

Development results never count as Production results. A green check does not
authorize messaging, migration, or cutover. The AVNI dispatch kill switch and
n8n campaign schedules remain off unless separately approved.

## 1. Safe inspection order

1. Record the exact source commit and clean/dirty worktree before review.
   Replit's successful build status alone does not prove which commit is
   serving. Confirm the selected source revision in deployment metadata or
   publish/build logs. If no revision-level evidence is exposed, record the
   running revision as **NOT CHECKED**; do not infer it from Git HEAD.
2. Open the authenticated CRM Admin **Integrated go-live checklist** at
   `/admin`. Its initial request is same-origin and no-store. It reports the
   current app runtime/DB checks; it does not contact Meta or Evolution.
3. The panel loads `GET /api/admin/integrations/readiness` (authenticated
   admin, private no-store response). Run
   `GET /api/admin/integrations/avni/supabase-readiness` only through the
   explicit admin button. It is a read-only catalog/privilege check plus
   synthetic empty lookups; it does not test a writer or dispatch.
4. Run `GET /api/admin/meta/lead-ads-diagnostics` only through the explicit
   admin button. It performs
   Graph GET checks for token identity, Page app subscription, and form-list
   access. It does not enumerate lead submissions, change subscriptions, or
   prove `leads_retrieval`.
5. Do not use a readiness request to test an actual student, create a test
   lead, send a message, or trigger an n8n workflow.

The checklist deliberately leaves the CRM migration ledger/table-scope review,
Replit AVNI migrations `0019`/`0020`, and Supabase runtime migration state as
**NOT CHECKED**. Its live schema probe is not a migration-ledger reconciliation.

## 2. CRM / Replit PostgreSQL

Production CRM startup requires `AICHM_APP_DATABASE_URL`; it does not fall back
to `DATABASE_URL`. The app URL must use a distinct least-privilege login on the
expected internal database endpoint. Startup checks the authenticated role,
database identity, primary/read-write state, allowed memberships, CRM grants,
and schema readiness. A failure is fail-closed before the listener opens.
Development may use its legacy connection behavior when the explicit app URL
is absent; that is not evidence about Production.

Before any Production schema operation:

1. Positively identify the Production primary and the destination. Never treat
   a read-only replica or a local snapshot as the primary.
2. Compare the live catalog and migration ledger with the exact source
   manifests. Resolve the historical 34-versus-50 table scope and Migration
   0013 discrepancy before applying anything. Do not replay historical
   `0000`–`0013` as a batch or infer applied state from source files.
3. Obtain and independently restore-test the required encrypted backups. A
   checksum or successful encryption alone is not a restore test.
4. Review the exact schema diff and owner/role/ACL postconditions. Stop if it
   contains unreviewed DDL, data writes, role changes, or target drift.

The documented Replit CRM forward stream is ordered:

1. `0014` — assignment foundation.
2. `0015` — audit/history additions.
3. `0016` — runtime-role separation and grants; validate role prerequisites
   before proceeding.
4. `0017` — Meta CRM schema additions.
5. `0018` — privacy-safe Meta phone-identity diagnostics.

This sequence is conditional on the earlier schema/ledger reconciliation and
per-migration preflight in `docs/aichm-crm-forward-migrations.md`. It is not a
command to apply the sequence now. That runner is pinned to Development and
must never be pointed at Production. Production schema changes require the
separately reviewed Replit Publish schema-diff flow after a fresh primary
comparison and explicit approval.

The Replit AVNI dispatch protocol drafts `0019` and `0020` are not part of the
regular migration journal. Their order is `0019` then `0020`, only after the
CRM base/forward migrations and role model have been reconciled. Never apply
`0019` alone. Use the read-only migration/role preflight first, then review
each exact diff; the preflight is not itself approval to run a migration.

Rollback requirements:

- Before a migration, retain a fresh encrypted backup and a successful
  isolated restore/reconciliation record.
- Use transaction rollback only for a failed, uncommitted migration where the
  migration's transaction guarantees it. After commit, prefer a reviewed
  forward repair; do not run destructive down SQL or restore over live writes
  without a separately approved recovery plan.
- Keep app code backward-compatible with the verified schema during rollout.
  Deploy only after postconditions pass, then verify health and revision.

## 3. AVNI conversation and follow-up integration

The Replit CRM remains the identity, assignment, consent, and opt-out authority.
Supabase is intended to own normalized conversation runtime state. n8n remains
an external orchestrator. These boundaries are not interchangeable.

Supabase conversation SQL is draft-only and must be reviewed against the
intended Supabase primary before any apply:

1. `supabase/migrations/20261118_avni_conversation_runtime_v1.sql`
2. `supabase/migrations/20261118_avni_conversation_runtime_v2_preflight.sql`
3. `supabase/migrations/20261118_avni_human_pilot_dispatch_v3.sql` only after
   separate human-pilot approval.

Run an identity, catalog, role, RLS, RPC owner, ACL, and sequence-privilege
preflight against the exact target before each step. Require a dedicated
NOLOGIN function owner and explicitly approved least-privilege runtime login;
do not grant direct table DML or `service_role`. Review postconditions and
synthetic integration tests before proceeding. No live Supabase migration or
writer credential is verified by this source checklist.

Required AVNI configuration names vary by capability:

- `SUPABASE_AVNI_READONLY_DATABASE_URL` and `SUPABASE_DB_SSL_CA` are used by
  the restricted read-only conversation reader. Presence is not proof that
  the target, TLS identity, privileges, or RPCs pass.
- `SUPABASE_AVNI_RUNTIME_DATABASE_URL` appears in readiness/preflight
  contracts, but the application has no trusted live writer pool attached.
  Do not configure it as a substitute for the missing writer/RPC rollout.
- `AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_JSON` is read by the server-only
  HMAC key-ring adapter. Tests use synthetic keys. Do not create a key for
  this checklist. An owner-approved key source, secure provisioning, key-ID
  retention/rotation plan, and production presence verification are required.
- `N8N_AVNI_FOLLOWUP_READ_SECRET` is limited to the candidate-read capability;
  it is not a conversation writer or send credential.
- `AVNI_SINGLE_RECIPIENT_DISPATCH_ENABLED` and
  `AVNI_PILOT_RECIPIENT_E164` are source-defined pilot controls. The app
  registration remains hard-disabled regardless of their presence; do not
  set or use them to bypass the source gate.
- `N8N_VSL_REGISTRATION_WEBHOOK_URL` and
  `N8N_VSL_REGISTRATION_WEBHOOK_SECRET` support the VSL registration
  acknowledgement flow. Confirm the receiver, safe payload contract, and
  acknowledgement semantics with the workflow owner; do not send a real
  registration event as a readiness test.
- `EVOLUTION_API_KEY` and `EVOLUTION_API_INSTANCE` are server-side transport
  settings. Their names or presence do not establish the deployed Evolution
  version, endpoint contract, recipient reachability, or idempotency.

The pilot route at
`POST /api/admin/integrations/avni/pilot-dispatch` is registered but its source
registration remains hard-disabled and passes no Supabase writer. It returns
`dispatch_disabled` after session/admin/origin validation. Do not attempt to
open it by setting only an environment flag. No automated campaign/follow-up
schedule is enabled by this application. Confirm n8n schedules separately and
keep them paused until explicitly approved.

Before considering a later, separately approved pilot:

1. Verify Replit and Supabase schema/role preconditions and migration order
   above against the actual primaries.
2. Verify the trusted CRM authorization adapter, consent epoch, opt-out,
   canonical crosswalk, control-version fence, one-use HMAC grant, and audited
   outbox against disposable synthetic databases.
3. Obtain owner approval for the unavoidable in-flight boundary: after
   Supabase `begin_send` succeeds, a later consent revocation or takeover can
   stop future attempts but cannot recall a request already accepted by a
   provider.
4. Independently verify the installed Evolution version and its documented
   auth, endpoint, request/response, idempotency, timeout, and unknown-outcome
   behavior. The current source targets the configured Evolution host and
   `sendText` API shape; it has not been verified against the live service.
5. Securely provision only approved server-side credentials. Never expose
   provider credentials to browser code or n8n. Keep unknown provider outcomes
   terminal for automatic retry; require human reconciliation.
6. Obtain separate owner approval for the exact recipient, exact message,
   and a one-recipient first action. Do not infer consent from this checklist.
7. Keep the source hard-disable in place until every prerequisite and policy
   approval is complete. A later request must authorize enabling separately.

## 4. Meta Lead Ads

The real-time webhook remains
`POST /api/webhooks/meta/leadgen`. Source tests cover raw-body signature
verification, configured Page-ID checks, phone aliases
`phone_number`/`mobile_phone`/`whatsapp_number`, conservative phone
normalization, exact Meta lead-ID idempotency, and source/ad/form attribution.
Unit tests do not prove live token validity, Page access, webhook delivery, or
stored lead identity.

Webhook intake is restricted by the server-only `META_ALLOWED_FORM_IDS`
setting: a comma-separated list of numeric form IDs. The webhook fails closed
when the setting is absent, empty, malformed, or duplicated; when either the
signed notification or Graph-fetched lead lacks a form ID; when those IDs do
not match; or when the form is not allowlisted. Before any deployment that
enables Lead Ads intake, an authorized administrator must verify the correct
AICHM Instant Form IDs in Meta and configure this allowlist through the
approved secret/configuration flow. Do not copy historical or test form IDs
without verifying that they are the intended active AICHM forms.

The admin diagnostic at `GET /api/admin/meta/lead-ads-diagnostics` is an
explicit, admin-authenticated read-only check. It uses Graph GET requests only
to validate the Page token with `debug_token`, compare `/me` with both the
configured Page and the approved AICHM Page, inspect Page `subscribed_apps`,
and compare the configured approved-form allowlist with the Page's accessible
`leadgen_forms` inventory. It checks the token's `leads_retrieval` and
`pages_manage_metadata` grants, app identity, token expiry and data-access
expiry. Form inventory pagination is bounded to five pages; an incomplete
inventory is reported as blocked, not assumed complete. It returns only booleans, safe
categories, expiry timestamps, and aggregate form counts. It never returns
token/app credentials, Page or form IDs, names, raw Graph messages, or lead
submissions, and it does not modify Page subscriptions or approve forms.

The diagnostic does not call any form `/leads` edge. A permission grant check
does not prove that Meta will return a particular lead record. Before
operational use:

1. Confirm the intended app and Page in the authorized Meta business settings.
2. Run the admin-only diagnostic after authorizing its Meta Graph GET
   requests. Resolve any failed token validity, configured Page/app identity,
   expiry, `leads_retrieval`, `pages_manage_metadata`, or `leadgen` subscription
   check.
3. Verify active/inactive form inventory and form question mapping without
   exporting applicant data. Do not hardcode a previously observed form list.
4. Have an authorized owner confirm the intended active AICHM forms, configure
   only those IDs in `META_ALLOWED_FORM_IDS`, and rerun the diagnostic to
   verify access to every configured form. A missing, empty, malformed, or
   duplicated allowlist continues to reject webhook intake; no form is selected
   or approved automatically.
5. Confirm the app-level webhook callback independently. Do not change
   subscriptions from this app's diagnostic.
6. Verify a sanitized Production webhook POST status and reason code from
   runtime telemetry. A Meta UI “success” or source test is not proof that CRM
   persistence and canonical identity linking succeeded.
7. Confirm `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`,
   `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN`, `META_GRAPH_API_VERSION`, and
   `META_ALLOWED_FORM_IDS`
   through the approved secret-presence/format flow only. Never print values.

The diagnostic checks the token's reported permission grants but deliberately
does not call a form `/leads` edge or fetch applicant data. Therefore successful
permission checks do not establish end-to-end lead retrieval for a particular
submission; use separately approved, privacy-safe operational telemetry for
that evidence.
`META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, and `META_CAPI_ENABLED` are separate
Conversions API settings; they do not establish Lead Ads readiness.

The Production environment metadata checked on 2026-11-20 did not contain
`META_CAPI_ENABLED`, so the CAPI worker is not activated. Credential-name
presence is not proof of a valid Page-token identity, Page subscription, or
lead-retrieval permission. The CAPI worker currently records ambiguous
network outcomes as failed and can retry them; because the provider may have
accepted a request before the connection failed, this is an open duplicate
delivery risk. Expired sending leases are recovered only while the attempt
count is below its ceiling, leaving an expired final attempt potentially stuck.
Keep CAPI off until an explicit unknown-outcome reconciliation and exhausted
lease recovery policy is reviewed and tested.

## 5. Deployment and final go-live gate

Before any separately approved publish:

1. Record exact Git commit, clean worktree, focused/full test results,
   typecheck, build, and diff check.
2. Confirm the selected publish source commit in Replit deployment metadata.
   If the platform does not expose a revision/commit mapping, mark revision
   identity **NOT CHECKED** rather than equating the current branch with the
   serving build.
3. Confirm the deployed startup completed and health endpoint returns success.
4. Re-open the authenticated checklist in Production and run only explicitly
   approved read-only diagnostics. Capture safe status and prerequisite names,
   never secret values or personal records.
5. Do not apply a migration, change routing, enable a workflow, or send a
   message as an implicit consequence of a passing health check.

Current hard blockers are intentionally visible: Production schema/role and
migration-ledger state must be freshly verified; Supabase writer migrations
and role are not confirmed live; the HMAC key custody/rotation process is not
approved; Evolution's deployed contract and idempotency behavior are not
verified; Meta `leads_retrieval` and per-form access are not established by the
read-only Page diagnostic; and deployment revision identity may require
platform metadata. No live migration, provider call, message, workflow change,
or deployment is performed by this runbook.
