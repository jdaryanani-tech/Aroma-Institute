---
name: AICHM operational database
description: Owner-approved source-of-truth boundary for AICHM runtime data and legacy Supabase reconciliation.
---

Replit PostgreSQL owns canonical AICHM operational records: admissions/leads, student and LMS records, VSL/counselling state, payments when verified, and Calendar. Supabase owns AVNI WhatsApp transcripts/provider delivery, AI interaction logs, conversation memory/summaries, and course knowledge. Its existing `public.leads` rows are conversation identity indexes, not canonical business leads; link them to the stable Replit lead UUID only through an explicit reviewed mapping.

**Why:** The owner explicitly approved a two-database architecture that assigns operational business state to Replit PostgreSQL and conversation/AI knowledge state to the existing Supabase project.

**How to apply:** Keep application operational reads/writes on `DATABASE_URL`. For CRM conversation history and explicit confirmation checks, use only a dedicated server-side Supabase read-only role with strict TLS; never send transcripts or course knowledge to Replit, use a privileged Supabase credential in the browser, or auto-link people by phone alone. Keep n8n as the Supabase conversation writer. Production schema changes and workflow cutover require separate review and approval.
