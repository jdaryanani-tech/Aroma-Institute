# AVNI conversation event contract — v1

This document and its companion pure helpers define a provider-neutral boundary
for a future conversation lifecycle implementation. They do **not** add a
webhook, transport, database writer, AI model call, or message sender.

## Ownership and source of truth

- Replit PostgreSQL remains authoritative for the admissions lead and its
  consent/opt-out status.
- Supabase remains the proposed authoritative store for conversation events and
  transcripts. The repository's Supabase SQL contract is workspace-preparation
  material; its presence in source is not evidence that the migration is live.
- n8n may orchestrate work, but must not decide canonical identity, consent,
  human ownership, or whether an AI queue item is still current.
- A provider adapter must map a thread to exactly one reviewed canonical lead.
  Unknown or ambiguous mappings fail closed; phone similarity alone is not a
  mapping decision.

## Normalized event envelope

All events use strict JSON with no provider-specific raw payload field:

```json
{
  "contractVersion": 1,
  "provider": "whatsapp",
  "providerEventRef": "opaque-provider-event-reference",
  "threadRef": "opaque-provider-thread-reference",
  "occurredAt": "2026-11-18T08:00:00.000Z",
  "kind": "message",
  "providerMessageRef": "opaque-provider-message-reference",
  "direction": "inbound",
  "author": "prospect",
  "messageType": "text",
  "text": "Message content"
}
```

`provider` is a stable lowercase provider key; the event, thread, and message
references are bounded opaque identifiers present only in transient adapter
memory. They must be discarded after keyed tokenization and never logged,
returned to clients, or written to Supabase. Timestamps must include a timezone.
Message type is one of `text`, `image`, `audio`, `video`, `document`,
`interactive`, `location`, or `unknown`. Text is optional for non-text messages
and bounded to 12,000 characters. Media references, when used, must be
app-owned `media:v1:<uuid>` handles, never provider media IDs or public URLs.
Adapters must not pass raw webhook JSON, headers, tokens, or credentials to
this contract.

The `author` values are `prospect`, `assistant`, `human_staff`, `system`, and
`unknown`; `direction` is `inbound` or `outbound`. An AI prompt is eligible only
for an inbound message authored by a prospect. Outbound human/AI events and
delivery events are never new AI prompts.

Delivery events use the same version, provider/event/thread/time fields plus
`kind: "delivery"`, `providerMessageRef`, and canonical `deliveryState` from
`queued`, `sent`, `delivered`, `read`, `failed`, or `unknown`. An optional
`rawProviderReceiptValue` (1–100 safe label characters) preserves the provider's
status label separately; it is not used for state decisions. Legacy UI
presentation may call an inbound message `received`, and the old proposal SQL
has `pending`; neither is a canonical outbound delivery state. A reader must
map legacy `pending` to `queued` rather than add a second state vocabulary.

Within one provider send attempt, receipts only advance through
`queued → sent → delivered → read`; `failed` is terminal for that attempt, and
`unknown` can be replaced by a known state. Late lower-state receipts are
retained as receipt events but cannot regress the attempt/message state. A retry
is a new attempt, not a receipt-state rollback.

## Idempotency

- Event/thread/message/receipt identity tokens: server-only, keyed,
  domain-separated HMAC-SHA-256 values represented as
  `hmac-sha256:v1:<64 lowercase hex>`. Idempotency keys use the token suffix
  under distinct `event:v1:` or `message:v1:` namespaces. A plain SHA-256 digest
  of a provider reference is forbidden because it can be guessed offline.
- The SQL draft validates token shape and key/token consistency but cannot
  verify the HMAC. No HMAC adapter or key is implemented: this repository lacks
  an approved server-only key-management boundary. That adapter is a hard
  prerequisite before persistence or transport work begins; do not invent a
  key or persist raw provider references in the meantime.
- Keys contain no message text, phone number, or raw provider reference.
- A production adapter must require stable provider event/message identifiers;
  it must not synthesize dedupe keys from message text or contact details.

## Conversation control state

The pure state model is:

```text
version: non-negative integer
mode: ai | human
lifecycle: open | closed
consentStatus: granted | not_provided | revoked | unknown
optedOut: boolean
```

1. AI eligibility requires a unique canonical mapping, open lifecycle, AI mode,
   granted WhatsApp consent, no opt-out, and an inbound prospect message.
2. Human takeover is an authenticated staff action with compare-and-swap
   `expectedVersion`. A successful takeover sets mode to `human` and increments
   the version. This makes queued AI work carrying the old version stale.
3. Resume is a separate authenticated staff action with the current version. It
   is allowed only from human mode while open, consent remains granted, and the
   lead is not opted out. A successful resume changes mode to `ai` and increments
   the version again. Old queued work remains stale.
4. Queue dispatch must re-check mapping, lifecycle, consent, opt-out, mode, and
   expected version immediately before the provider call. A decision helper is
   not a substitute for an atomic durable claim or a real sender-side guard.
5. A provider send already accepted cannot be recalled. Future durable
   implementation must distinguish cancellable queued work from in-flight or
   provider-accepted work and report delivery truthfully.

The pure helpers accept authorization as an input boolean solely to make the
transition decision testable. A future route must derive it from the
authenticated CRM staff session and assignment scope; it must never trust a
client-supplied authorization flag.

## Current phase boundary

`server/integrations/avni-conversation-contract.ts` validates and classifies
events, derives idempotency-key strings only from a supplied validated HMAC
token, evaluates AI eligibility, invalidates
stale queue items, and models takeover/resume transitions. Its tests use only
synthetic values. No code in this phase receives provider webhooks, stores
transcripts, invokes AI, or sends messages.
