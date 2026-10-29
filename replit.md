# Aroma Institute of Cafe & Hospitality Management - Website

## Overview

This project is the marketing website and staged LMS foundation for **Aroma Institute of Cafe & Hospitality Management**, a hospitality academy based in Gujarat, India. The marketing pages showcase barista certification, brewing, mixology, café entrepreneurship, and collect prospective student inquiries. Aroma LEAP LMS routes are being added to this same application.

The application uses a React frontend and an Express backend with PostgreSQL. The existing marketing site and inquiry records remain in place. The site uses a coffee-inspired dark/warm aesthetic; LMS screens have a separate responsive learning interface.

## User Preferences

Preferred communication style: Simple, everyday language.

For new or revised marketing pages, align the layout and theme with the established Aroma brand identity without waiting for the user to restate it. A logo is optional; brand identity should come through in the overall design.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter — marketing pages plus `/learn`, `/learn/dashboard`, `/learn/courses/:courseId`, `/trainer`, and `/lms-admin`
- **Styling**: Tailwind CSS with CSS variables for theming. Custom coffee-inspired color palette (browns, beiges, gold accents) defined in `client/src/index.css`
- **UI Components**: shadcn/ui component library (new-york style) with Radix UI primitives. Components live in `client/src/components/ui/`
- **Animations**: Framer Motion for scroll-triggered animations and page transitions
- **Forms**: React Hook Form with Zod validation via `@hookform/resolvers`
- **Data Fetching**: TanStack React Query with a custom `apiRequest` helper in `client/src/lib/queryClient.ts`
- **Fonts**: Playfair Display (serif headings), Plus Jakarta Sans (body text), Inter (mono/utility)
- **Icons**: Lucide React icons and react-icons (for social media icons)
- **Build Tool**: Vite with path aliases (`@/` → `client/src/`, `@shared/` → `shared/`)

### Page Structure
The Home page (`client/src/pages/Home.tsx`) is composed of these sections in order:
1. Navbar (fixed, scroll-aware)
2. Hero Section
3. About Section
4. Programs Section
5. Training Model Section
6. Placement/Industry Partners Section
7. Admissions Process Section
8. CTA Section
9. Contact Form (inquiry submission)
10. Footer

### Backend
- **Runtime**: Node.js with TypeScript (via tsx)
- **Framework**: Express 5
- **API**: Express REST endpoints for contact submissions, the legacy leads dashboard, and LMS access/content workflows
- **Validation**: Zod schemas shared between frontend and backend (defined in `shared/schema.ts`), with `zod-validation-error` for readable error messages
- **Dev Server**: Vite dev server middleware integrated into Express during development (`server/vite.ts`)
- **Static Serving**: In production, Express serves the built Vite output from `dist/public/` with SPA fallback (`server/static.ts`)

### Database
- **Database**: PostgreSQL (required via `DATABASE_URL` environment variable)
- **ORM**: Drizzle ORM with `drizzle-orm/node-postgres`
- **Schema**: Inquiry definitions in `shared/schema.ts`; additive LMS definitions in `shared/lms-schema.ts`
- **LMS tables**: Users and roles, courses, modules, chapters, lessons, enrollments, invitations, progress, assessment versions/attempts, trainer assignments, live sessions, attendance, certificates, notifications, audit records, OTP challenges, password setup tokens, auth rate limits, and PostgreSQL sessions
- **Schema Push**: Use `npm run db:push` (runs `drizzle-kit push`) to sync schema to database
- **Migrations**: Output directory is `./migrations` (configured in `drizzle.config.ts`)

### Shared Code
- `shared/schema.ts` contains inquiry Drizzle definitions, Zod insert schemas, and types used by both frontend and backend
- The `insertInquirySchema` includes custom validation (email format, phone min 10 chars, name min 2 chars)

### Storage Layer
- `server/storage.ts` defines an `IStorage` interface and a `DatabaseStorage` implementation
- Handles inquiry persistence; LMS workflows use their route modules and Drizzle directly
- The singleton `storage` export is used by route handlers

### Build Process
- **Dev**: `npm run dev` — runs tsx with Vite middleware for HMR
- **Build**: `npm run build` — runs `script/build.ts` which builds the client with Vite and bundles the server with esbuild
- **Production**: `npm start` — serves the built application from `dist/`
- Server dependencies are selectively bundled (allowlisted in `script/build.ts`) to reduce cold start times

### Key Scripts
- `npm run dev` — development server with HMR
- `npm run build` — production build
- `npm start` — production server
- `npm run check` — TypeScript type checking
- `npm test` — LMS assessment scoring tests
- `npm run db:generate` — generate a Drizzle migration from both schemas
- `npm run db:migrate` — apply pending migrations to the development database
- `npm run db:push` — push Drizzle schema to database
- `npm run lms:bootstrap-admin` — create the first admin account interactively

## LMS implementation status

- LMS routes use the existing Express server and PostgreSQL database. LMS sessions are stored in the `sessions` table with HttpOnly, SameSite cookies and role checks on protected API routes.
- The `/learn` login currently uses phone and password as the temporary no-SMS method chosen by the institute. Passwords are scrypt-hashed server-side, login/setup attempts are rate-limited, and users set or reset passwords through single-use links issued by an LMS administrator. The n8n WhatsApp endpoint remains configured only on the server and is never called; OTP send/verify endpoints return `503` and cannot create a session. See `docs/lms-otp-provider-contract.md` for the provider contract still required before WhatsApp OTP can be enabled.
- The initial UI includes student dashboard/course learning and assessment attempts, certificate status/review requests, a trainer course outline and assessment editor, and admin course/invitation/certificate-review workflows. More account, roster, reporting, live-session, notification, and settings screens remain.
- Course modules, chapters, lessons, and assessments are stored in PostgreSQL. Resource metadata is modeled, but persistent resource upload/download storage is not connected.
- Approved certificates can be rendered as a branded PDF and are protected by the student/admin authorization check.
- The leads dashboard at `/admin` now requires an LMS administrator session; the previous hard-coded password fallback and browser `sessionStorage` password are removed.
- Create the first admin account with `npm run lms:bootstrap-admin` after applying migrations. The command prompts for the admin password without echoing it. An administrator can create student/trainer accounts and issue one-time password setup links from `/lms-admin`.

## External Dependencies

### Database
- **PostgreSQL** — Required. Connection string must be provided via `DATABASE_URL` environment variable. Used with `pg` (node-postgres) pool and Drizzle ORM.

### Session Store
- **connect-pg-simple** — Stores LMS sessions in PostgreSQL; LMS protected routes check the authenticated user and required role

### Frontend Libraries
- **@tanstack/react-query** — Server state management and API caching
- **framer-motion** — Animation library for scroll-triggered and entrance animations
- **wouter** — Lightweight client-side routing
- **react-hook-form** — Form state management
- **recharts** — Charting library (available but not currently used in visible components)
- **embla-carousel-react** — Carousel component
- **vaul** — Drawer component
- **react-day-picker** — Calendar/date picker
- **react-resizable-panels** — Resizable panel layout
- **input-otp** — OTP input component
- **cmdk** — Command palette component

### Replit-Specific
- **@replit/vite-plugin-runtime-error-modal** — Runtime error overlay in development
- **@replit/vite-plugin-cartographer** — Dev tooling (dev only)
- **@replit/vite-plugin-dev-banner** — Dev banner (dev only)

### Google Fonts (CDN)
- Playfair Display, Plus Jakarta Sans, Inter — loaded via Google Fonts in `client/index.html`
