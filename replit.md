# Aroma Institute of Cafe & Hospitality Management - Website

## Overview

This is a marketing and lead-generation website for **Aroma Institute of Cafe & Hospitality Management**, a hospitality academy based in Gujarat, India. The site showcases their training programs (barista certification, brewing, mixology, café entrepreneurship) and captures prospective student inquiries through a contact form.

The application is a single-page website with a React frontend and an Express backend. It uses a PostgreSQL database to store inquiry form submissions. The site is designed with a premium, coffee-inspired dark/warm aesthetic using brown, beige, and gold accent colors.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight client-side router) — currently just a single Home page and a 404 page
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
- **API**: Single REST endpoint `POST /api/inquiries` for contact form submissions
- **Validation**: Zod schemas shared between frontend and backend (defined in `shared/schema.ts`), with `zod-validation-error` for readable error messages
- **Dev Server**: Vite dev server middleware integrated into Express during development (`server/vite.ts`)
- **Static Serving**: In production, Express serves the built Vite output from `dist/public/` with SPA fallback (`server/static.ts`)

### Database
- **Database**: PostgreSQL (required via `DATABASE_URL` environment variable)
- **ORM**: Drizzle ORM with `drizzle-orm/node-postgres`
- **Schema**: Defined in `shared/schema.ts` — currently one table:
  - `inquiries`: id (serial PK), name (text), email (text), phone (text), program_interest (text), message (text, nullable)
- **Schema Push**: Use `npm run db:push` (runs `drizzle-kit push`) to sync schema to database
- **Migrations**: Output directory is `./migrations` (configured in `drizzle.config.ts`)

### Shared Code
- `shared/schema.ts` contains Drizzle table definitions, Zod insert schemas, and TypeScript types used by both frontend and backend
- The `insertInquirySchema` includes custom validation (email format, phone min 10 chars, name min 2 chars)

### Storage Layer
- `server/storage.ts` defines an `IStorage` interface and a `DatabaseStorage` implementation
- Currently only has `createInquiry()` method
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
- `npm run db:push` — push Drizzle schema to database

## External Dependencies

### Database
- **PostgreSQL** — Required. Connection string must be provided via `DATABASE_URL` environment variable. Used with `pg` (node-postgres) pool and Drizzle ORM.

### Session Store
- **connect-pg-simple** — Listed as a dependency for PostgreSQL-backed session storage (though session/auth is not currently implemented in routes)

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