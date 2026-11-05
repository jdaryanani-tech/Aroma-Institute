---
name: Admissions lifecycle evidence
description: Business rules for truthful admissions CRM lifecycle stages.
---

VSL Shared means the link was actually sent, not merely opened or copied. VSL
Watched requires observed playback/progress or an explicit prospect confirmation
clearly labelled self-reported. Form Submitted requires a saved form record.
Counselling Booked requires a successful verified Cal.com booking ID; webhook
receipt and a selected preferred slot do not confirm appointments. Attendance and
enrolment require explicit staff records. Do not fabricate downstream chat history.

**Why:** The user requires truthful lifecycle visibility while preserving the
working WhatsApp/AVNI automation, public forms, LEAP portal and historical records.

**How to apply:** Use these rules in future stage transitions, automation
ingestion, metrics and UI labels. If trustworthy evidence or a secure integration
is unavailable, state the limitation instead of inferring success.
