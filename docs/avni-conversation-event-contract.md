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
references are bounded opaque identifiers. Timestamps must include a timezone.
Message type is one of `text`, `image`, `audio`, `video`, `document`,
`interactive`, `location`, or `unknown`. Text is optional for non-text messages
and bounded to 12,000 characters. Media references, when used, are opaque
handles, never public URLs. Adapters must not pass raw webhook JSON, headers,
tokens, or credentials to this contract.

The `author` values are `prospect`, `assistant`, `human_staff`, `system`, and
`unknown`; `direction` is `inbound` or `outbound`. An AI prompt is eligible only
for an inbound message authored by a prospect. Outbound human/AI events and
delivery events are never new AI prompts.

Delivery events use the same version, provider/event/thread/time fields plus
`kind: "delivery"`, `providerMessageRef`, and `deliveryState` from `queued`,
`sent`, `delivered`, `read`, `failed`, or `unknown`.

## Idempotency

- Event idempotency key: SHA-256 over the contract version, namespace, provider,
  event kind, and opaque provider event reference.
- Message idempotency key: SHA-256 over the contract version, namespace,
  provider, and opaque provider message reference. This also collapses the same
  message repeated under different provider event wrappers.
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
events, produces opaque idempotency keys, evaluates AI eligibility, invalidates
stale queue items, and models takeover/resume transitions. Its tests use only
synthetic values. No code in this phase receives provider webhooks, stores
transcripts, invokes AI, or sends messages.
