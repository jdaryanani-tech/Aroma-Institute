# Aroma Institute

Aroma Institute is a hospitality and coffee-training platform combining the
institute's public website with admissions, CRM, learning, and scheduling
workflows. This repository contains the application source and proposed
database changes; it does not certify that a deployment, migration, or external
integration is live.

## Product areas

- **Marketing and admissions:** institute and course information, contact and
  counselling forms, and lead capture.
- **Admissions CRM:** canonical lead records, assignments, lifecycle and
  follow-up controls, consent/opt-out handling, and audit history.
- **Aroma LEAP LMS:** learner, trainer, admissions, and administrator workflows
  for courses, lessons, assessments, progress, attendance, and certificates.
- **Calendar:** resources, availability, events, bookings, notifications, and
  reminder-job support.
- **VSL:** registration, playback sessions, progress events, and protected
  media delivery.
- **Meta:** signed Lead Ads webhook handling, Page/form validation, lead
  attribution, consent-aware event capture, and a gated Conversions API outbox.
- **AVNI/n8n:** authenticated CRM integration endpoints and server-side
  conversation-history reads. Conversation writing and the single-recipient
  Evolution pilot are guarded by explicit runtime prerequisites and feature
  gates. Source code and tests do not establish live credentials, migrations,
  or provider connectivity.

## Technology

- Node.js 20 and TypeScript
- React 18, Wouter, Vite, Tailwind CSS, and Radix-based UI components
- Express 5 REST server
- PostgreSQL using `pg` and Drizzle ORM
- Replit Object Storage for protected media assets
- Zod request/schema validation
- PostgreSQL-backed sessions, with role checks on protected routes
- Node's built-in test runner and Playwright for automated tests

The project uses `package-lock.json`; install with npm rather than modifying
dependencies without updating the lockfile.

## Architecture and data safety

The application uses PostgreSQL for operational admissions, CRM, LMS, and
Calendar data. Production source requires a dedicated application database
connection and validates its endpoint and role instead of silently using a
privileged migration login. Local development and automated tests should use
only a disposable or explicitly approved non-production database.

Supabase is a separate integration boundary for AVNI conversation/history and
migration tooling. The repository contains Supabase SQL files and preflight
code, but those files are not evidence that a migration has been applied.
Likewise, Meta, n8n, and Evolution source integrations are not evidence of
valid credentials, subscriptions, or successful live delivery. Outbound
AVNI/Evolution dispatch and Meta CAPI have explicit fail-closed gates; public
form integrations still depend on their separately configured server-side
delivery contracts.

The standard Drizzle journal currently covers migrations through `0012`;
later CRM, Meta, and AVNI SQL files and additional forward-migration/preflight
tools are present. Verify the intended runner, ordering, and target
environment's recorded schema before any schema operation. Do not apply a
source SQL file just because it exists in the repository.

## Local development

Use Node.js 20 and a local/disposable PostgreSQL database. Start from the
sanitized variable-name template:

```sh
npm ci
cp .env.example .env
# Fill only the local values required for the work you are doing.
npm run dev
```

Never copy Production credentials or student data into a local `.env` file.
The application needs a database connection to run. Database schema commands
are guarded and are not part of normal startup:

```sh
npm run check
npm test
npm run build
```

Database and browser integration tests are opt-in and must use their isolated
test harnesses. Do not point test variables at Production. See
[`docs/development-schema-changes.md`](docs/development-schema-changes.md)
before proposing a development schema change. Post-merge setup deliberately
does not synchronize schemas automatically.

## Configuration

`.env.example` lists configuration **names only** with blank values. Many
integrations and operations require separately provisioned credentials or
explicit approval. Configure secrets using the environment's secret-management
facility; never commit populated `.env` files, credentials, webhook URLs, or
real applicant/student data.

Some workflows are deliberately disabled until reviewed prerequisites are met.
An environment variable being present is not proof of a valid database role,
Meta Page permission, approved form, Supabase schema, or provider contract.

## Contributing

1. Create a focused branch and keep changes limited to the agreed scope.
2. Do not commit secrets, personal applicant data, production exports, or
   populated local environment files.
3. Add or update isolated tests for behavior changes.
4. Run the relevant tests, `npm run check`, and `npm run build`.
5. For database changes, include migration ordering, read-only preflight,
   postconditions, rollback/forward-recovery notes, and isolated verification.
   Never apply a Production migration or enable an external side effect as part
   of an unreviewed code change.

## License

This project is released under the MIT License. See [`LICENSE`](LICENSE).
