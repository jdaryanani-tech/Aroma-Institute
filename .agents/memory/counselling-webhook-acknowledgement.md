---
name: Counselling webhook acknowledgement
description: The required production endpoint and success contract for counselling submissions.
---

The counselling sender must target exactly `https://n8n.aromacafeinstitute.in/webhook/counselling-submission`. Mark a delivery acknowledged only when n8n returns HTTP 2xx and a JSON object containing `received: true` and the same `submissionId` that was sent. Keep secrets in Replit Secrets and out of client code, logs, and responses.

**Why:** The user requires an explicit downstream receipt instead of treating any HTTP 2xx response as proof that the counselling workflow accepted the record.

**How to apply:** Validate the exact URL before sending; store safe per-attempt status and response metadata; never replay legacy records with unknown delivery history.
