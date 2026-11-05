---
name: AVNI questionnaire session state
description: Where to keep partial WhatsApp questionnaire progress and how to persist completed submissions.
---

Keep unfinished AVNI WhatsApp answers and the current question in the existing n8n conversation/workflow state. Save only a complete, validated 29-answer set to the existing counselling inquiry flow with source `avni_whatsapp`.

**Why:** This avoids a second partial-questionnaire schema while preserving multi-message progress; the Replit app remains the authority for final validation, consent, idempotency, and submission status.

**How to apply:** Key n8n progress by normalized WhatsApp sender, use the authenticated question and single-answer validation endpoints, check lookup status before asking, and call the submit endpoint only when all required answers—including question 29 consent—are valid. Do not log answer contents.
