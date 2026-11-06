---
name: AICHM appointment source of truth
description: AICHM Calendar booking rules for admissions, AVNI/n8n, CRM evidence and public questionnaire preferences.
---

AICHM’s in-app Calendar is the sole source of truth for confirmed counselling appointments; replace Cal.com for this flow and do not add Google, Outlook or another booking calendar. A submitted questionnaire date/time is only a request. Booking requires server-verified VSL completion, a stored completed questionnaire, an explicitly confirmed slot, and a committed Calendar transaction. CRM “Counselling Booked” evidence must reference that committed Calendar event.

**Why:** the owner approved one internal AICHM scheduling source and requires AVNI/n8n to book only from real availability without inferring attendance or confirmation.

**How to apply:** keep phone/lead/inquiry resolution server-side, enforce idempotency and prospect/staff/resource conflict checks in shared Calendar services, and retain LMS live sessions as their existing system of record.
