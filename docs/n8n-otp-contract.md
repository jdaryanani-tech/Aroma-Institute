# Aroma LEAP WhatsApp OTP contract for n8n

Status: draft contract for the Aroma LEAP server and a new n8n WhatsApp Business branch. The app must remain unavailable for sign-in until the workflow implements this contract and its server-side URL and token are configured.

## Connection and authentication

- The app calls one HTTPS n8n production webhook from the server only. The browser never calls n8n.
- Configure the webhook with header authentication. The app sends `Authorization: Bearer <shared-token>`.
- Store the endpoint in the non-secret environment variable `N8N_OTP_WEBHOOK_URL`.
- Store the shared token in Replit Secrets as `N8N_OTP_WEBHOOK_TOKEN`. Use at least 32 random characters. Configure the same token as the n8n webhook credential.
- Do not put credentials in the webhook URL, query string, request body, logs, or frontend bundle. Do not log OTP request or response bodies.
- The app rejects non-HTTPS URLs, redirects, malformed responses, mismatched challenge IDs, and requests taking longer than eight seconds.

## Request: send a code

The app generates a UUID challenge ID and five-minute expiry, applies per-phone request limits, saves the challenge, then sends:

```json
{
  "version": 1,
  "action": "send",
  "challengeId": "4e5bf513-abd4-4df1-81a3-7148e339bb71",
  "phoneE164": "+919876543210",
  "expiresAt": "2030-01-01T00:05:00.000Z"
}
```

The n8n branch must generate and send a six-digit OTP through WhatsApp Business, bind it to both `challengeId` and `phoneE164`, and expire it no later than `expiresAt`. Use a durable, concurrency-safe store with a hash or equivalent protected representation; do not use workflow static data for OTP storage. Never return the OTP to the app.

Successful n8n response (HTTP 200, JSON):

```json
{
  "version": 1,
  "action": "send",
  "challengeId": "4e5bf513-abd4-4df1-81a3-7148e339bb71",
  "accepted": true
}
```

Return `accepted: false` if delivery cannot be queued. Echo the exact challenge ID. Do not include a code, provider credential, or account-existence information.

## Request: verify a code

The app verifies the local challenge is active and within its five-attempt limit, then sends:

```json
{
  "version": 1,
  "action": "verify",
  "challengeId": "4e5bf513-abd4-4df1-81a3-7148e339bb71",
  "phoneE164": "+919876543210",
  "expiresAt": "2030-01-01T00:05:00.000Z",
  "otp": "381642"
}
```

The n8n branch must compare the code for that exact phone and challenge, enforce expiry, and atomically consume a successful code so it cannot be replayed. The code is sent server-to-server over HTTPS and is not stored or logged by the app.

Successful or unsuccessful verification response (HTTP 200, JSON):

```json
{
  "version": 1,
  "action": "verify",
  "challengeId": "4e5bf513-abd4-4df1-81a3-7148e339bb71",
  "verified": true
}
```

Use `verified: false` for an incorrect, expired, consumed, or unknown challenge. Never echo the OTP. The app ignores malformed responses and never creates a session unless `verified` is `true` for the matching challenge.

## App-side limits and behavior

- E.164 phone numbers only; no implicit country-code guessing.
- One send per phone per 60 seconds; at most three sends per phone in 15 minutes.
- Five-minute challenge lifetime; at most five verification attempts per challenge.
- App-side challenge metadata is purged after 24 hours on subsequent OTP requests; the app never stores the OTP itself.
- A new send invalidates older active challenges for that phone.
- Sign-in responses do not reveal whether a phone is already registered. A verified first-time phone receives the student role; existing active users retain their existing roles.
- Provider errors fail closed. No cookie or session is issued before a valid verification response.
- The public app endpoint returns `available: false` until both environment values are valid. A missing or invalid configuration keeps send and verify endpoints disabled.

## Bring-up checklist

1. Add an n8n production webhook protected with the shared header credential.
2. Implement both `action` branches and durable one-time challenge storage.
3. Test delivery, wrong-code rejection, expiry, five-attempt lockout, and successful single-use verification.
4. Add `N8N_OTP_WEBHOOK_URL` to the app environment and `N8N_OTP_WEBHOOK_TOKEN` through Replit Secrets.
5. Verify with a test account before enabling production sign-in.
