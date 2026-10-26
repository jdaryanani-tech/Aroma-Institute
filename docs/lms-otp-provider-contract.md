# Aroma LEAP OTP provider details needed

WhatsApp OTP sign-in remains disabled. The server does not contact the webhook,
and the browser cannot create or validate an OTP session. Temporary password
sign-in is active instead. The webhook URL is configured server-side as
`LMS_OTP_WEBHOOK_URL`; it is not included in frontend code or API responses.

## Please confirm the approved contract

Provide the following details from Aroma's n8n workflow owner before enabling
any requests:

1. **Operations and routing**
   - HTTP method and path for sending an OTP.
   - HTTP method and path for verifying an OTP. Confirm whether both operations
     share one URL and, if so, the exact action field used to distinguish them.
   - Whether the configured URL is the production or a safe test endpoint.
2. **Send request and response**
   - Exact JSON request fields, including the phone number format.
   - Exact success and failure response bodies and HTTP statuses.
   - Whether a provider challenge ID is returned and must be stored by the LMS.
   - Idempotency and retry behavior, so a timeout cannot send duplicate codes.
3. **Verification**
   - Exact verification request fields and response schema.
   - The server-verifiable signal that means the code is correct (for example,
     an explicit provider verification result tied to the original challenge).
   - Whether a successful code is single-use and what prevents replay.
   - Where codes are generated, stored and compared. Do not accept a
     browser-supplied “verified” flag or a send-only acknowledgement as proof.
4. **Security and limits**
   - Required webhook authentication method and header format. Provide the
     credential separately through Replit Secrets, never in this document,
     source code, or a browser request.
   - Code lifetime, maximum verification attempts, and provider-side send
     throttling.
   - Timeout, retry, and redirect behavior. The server integration must use
     HTTPS, avoid logging credentials or OTPs, and restrict outbound requests to
     the approved endpoint.
5. **Account behavior**
   - Whether an unknown but verified phone may create a student account, or
     must be denied until staff pre-register it.
   - How student enrollment eligibility affects the destination, and whether
     staff with multiple roles should land on a role chooser or a fixed page.
   - Confirm that roles and enrollments come from the LMS database, not from
     untrusted webhook fields.

The LMS will enforce its own phone normalization, resend cooldowns, expiry,
verification attempt limits, and no-enumeration responses after the approved
contract is available. Provider behavior must not replace server-side checks.

## Current safe behavior

- `LMS_OTP_WEBHOOK_URL` is a server-side environment variable.
- `/api/lms/auth/status` reports that the current password sign-in route is
  available; it does not claim that WhatsApp OTP is available.
- OTP request and verification return `503`; they do not send a code, verify a
  browser-provided code, query account existence, or create a session.
- Do not run live OTP tests or send real messages without Aroma's approval.
- Do not enable WhatsApp OTP until the workflow owner confirms the contract
  above and a server-side verifier can establish success independently of
  browser input.
