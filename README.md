<p align="center">
  <a href="https://github.com/Abdullah931-stack/LUGX">
    <img src="./public/lugx-icon.svg" width="120" height="120" alt="LUGX Logo" />
  </a>
</p>

<h1 align="center">LUGX</h1>

<p align="center">
  <strong>Enterprise AI Proofreading, Linguistic Enhancement & Intelligent Translation Platform</strong><br />
  High-concurrency collaborative text editor engineered for Arabic and English with atomic quota reservation, fail-closed Stripe monetization, and offline-first synchronization.
</p>

<p align="center">
  <a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-16.1.4-black?style=for-the-badge&logo=next.js" alt="Next.js 16" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19.2.3-20232A?style=for-the-badge&logo=react" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript" alt="TypeScript 5" /></a>
  <a href="https://orm.drizzle.team"><img src="https://img.shields.io/badge/Drizzle_ORM-0.45.1-C5F74F?style=for-the-badge&logo=drizzle" alt="Drizzle ORM" /></a>
  <a href="https://ai.google.dev"><img src="https://img.shields.io/badge/Gemini_AI-SDK_0.24-8E75B2?style=for-the-badge&logo=google" alt="Google Gemini AI" /></a>
  <a href="https://stripe.com"><img src="https://img.shields.io/badge/Stripe-Fail--Closed_Webhooks-635BFF?style=for-the-badge&logo=stripe" alt="Stripe" /></a>
  <a href="https://vitest.dev"><img src="https://img.shields.io/badge/Vitest-225%2F225_Passing-6E9F18?style=for-the-badge&logo=vitest" alt="Vitest 225 Passing" /></a>
  <a href="#contributing--license"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge&logo=apache" alt="License Apache 2.0" /></a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Architecture & Tech Stack](#architecture--tech-stack)
- [Project Structure](#project-structure)
- [Quickstart & Setup](#quickstart--setup)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Environment Configuration](#2-environment-configuration)
  - [3. Database Migrations](#3-database-migrations)
  - [4. Running Development & Production](#4-running-development--production)
  - [5. Automated Test Suite](#5-automated-test-suite)
- [Core Engineering Subsystems](#core-engineering-subsystems)
  - [1. Atomic Quota Reservation & Gemini Engine](#1-atomic-quota-reservation--gemini-engine)
  - [2. Stripe Subscription Lifecycle](#2-stripe-subscription-lifecycle)
  - [3. Concurrency Control & Synchronization](#3-concurrency-control--synchronization)
  - [4. Scheduled Maintenance & Cron](#4-scheduled-maintenance--cron)
- [Security Architecture](#security-architecture)
- [Documentation Index](#documentation-index)
- [Deployment Blueprints](#deployment-blueprints)
- [Contributing & License](#contributing--license)

---

## Overview

**LUGX** is an enterprise-grade cloud text editing and linguistic intelligence workstation designed specifically for Arabic and English content. It combines real-time AI assistance (grammar correction, style enhancement, translation, summarization, and prompt engineering) with an offline-capable document editor, deterministic concurrency control, and a rock-solid subscription engine.

### Key Capabilities
- ✍️ **Intelligent Arabic & English Proofreading:** Context-aware grammar and vocabulary corrections powered by Google Gemini SDK.
- ⚡ **Atomic Quota Reservation:** Eliminates TOCTOU race conditions with database-level conditional guards and automatic refunds on downstream failures.
- 💳 **Fail-Closed Stripe Subscriptions:** 8-state exhaustive mapping with database-level uniqueness constraints preventing duplicate entitlements.
- 🔄 **Deterministic Concurrency Control:** SQL-level version predicates (`WHERE version = :currentVersion`) preventing lost updates and returning structured `412 Precondition Failed` conflict recovery payloads.
- 📴 **Offline-First Synchronization:** Client IndexedDB storage, ETag validation (`If-Match` / `If-None-Match`), and bounded worker concurrency.

---

## Architecture & Tech Stack

| Domain | Technology / Specification |
|---|---|
| **Frontend Framework** | Next.js 16 (App Router) · React 19 (Server & Client Components) |
| **Language & Typings** | TypeScript 5 (Strict Mode) |
| **Styling & Design** | Tailwind CSS 4 · Radix UI Primitives · Lucide Icons |
| **Rich Text Editor** | Tiptap Editor (ProseMirror Toolkit) · DOMPurify Sanitizer |
| **Database & ORM** | PostgreSQL (Neon / Supabase / Local) · Drizzle ORM (Migrations 0001–0004) |
| **Authentication** | Supabase Auth (SSR Edge Proxy Session Validation) |
| **AI LLM Engine** | Google Gemini SDK (`@google/generative-ai`) · Tier-based Model Routing · Multi-Key Rotation |
| **Payment Gateway** | Stripe SDK · Webhook Signature Verification · Idempotency Guard |
| **Rate Limiting** | Sliding Window Algorithm (In-Memory Fallback & Upstash Redis) |
| **Testing Harness** | Vitest · PostgreSQL Integration Suite (225 Tests Across 20 Test Files) |

---

## Project Structure

```
lugx/
├── .github/
│   └── workflows/
│       └── cron.yml               # Scheduled maintenance workflow (Daily 03:00 UTC)
├── docs/                          # Comprehensive technical specifications & audits
│   ├── CHANGELOG.md
│   ├── Plan for an improved synchronization system.md
│   ├── Production Readiness Roadmap — M0-M5 Execution Record.md
│   ├── STRIPE_INTEGRATION.md & STRIPE_SETUP.md
│   ├── SYNC_ARCHITECTURE.md, SYNC_API.md, SYNC_SYSTEM.md
│   ├── Technical Fix Documentation — Security & Architecture Hardening.md
│   └── W10-Final-Closure-Round.md
├── migrations/                    # Versioned Drizzle SQL migration files (0001–0004)
├── public/                        # Static assets & brand icons (lugx-icon.svg, icon.svg)
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── api/                   # REST API routes (files, AI stream, Stripe webhook, cron)
│   │   ├── (routes)/              # Page views (Workspace, Dashboard, Account, Auth)
│   │   ├── layout.tsx             # Root layout with typography, themes, and icon metadata
│   │   └── globals.css            # Global theme styles & Tailwind utilities
│   ├── components/                # Modular React UI components (Modals, Diff viewer, Editor)
│   ├── hooks/                     # Custom React hooks (Network status, sync state, editor ops)
│   ├── lib/
│   │   ├── ai/                    # Gemini client, model tiering, multi-key rotation pool
│   │   ├── db/                    # Drizzle schema definitions & client initialization
│   │   ├── sync/                  # Concurrency manager, ETag engine, bounded worker pool
│   │   ├── rate-limit.ts          # Sliding window rate limiters (Auth / API / AI)
│   │   ├── sanitize.server.ts     # JSDOM + DOMPurify server-side HTML sanitizer
│   │   └── storage/               # Browser IndexedDB storage client
│   ├── server/actions/            # Authenticated Next.js Server Actions (file-ops, ai-ops)
│   ├── test/                      # Database integration test harnesses & fixtures
│   └── proxy.ts                   # Route protection and Supabase session validation (Next.js 16 Edge Proxy)
├── vitest.config.ts                # Default test runner (unit/contract only)
├── vitest.live.config.ts           # LIVE integration runner (isolated Neon branch)
└── package.json
```

---

## Quickstart & Setup

### 1. Prerequisites

- **Node.js**: v20.x or later
- **Package Manager**: `npm` (or `pnpm` / `yarn`)
- **Database**: PostgreSQL 14+ instance (local Docker, Neon, or Supabase)

```bash
# Clone the repository
git clone https://github.com/Abdullah931-stack/LUGX.git
cd LUGX

# Install project dependencies
npm install
```

### 2. Environment Configuration

Copy the documented `.env.example` template:

```bash
cp .env.example .env
```

Configure the necessary credentials in `.env`:

```ini
# Database Connection
DATABASE_URL="postgresql://postgres:password@localhost:5432/lugx_db"

# Supabase Authentication
NEXT_PUBLIC_SUPABASE_URL="https://your-project.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Google Gemini AI (Supports key rotation via fallbacks)
GEMINI_API_KEY="AIzaSyYourPrimaryApiKey"
GEMINI_API_KEY_FALLBACK_1="AIzaSyYourFallbackKey1"

# Stripe Monetization
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRO_MONTHLY_PRICE_ID="price_..."
STRIPE_ULTRA_MONTHLY_PRICE_ID="price_..."

# Maintenance Security Secret
CRON_SECRET="your-32-byte-random-secret"
```

> [!TIP]
> Generate a cryptographically secure `CRON_SECRET` using:
> ```bash
> openssl rand -base64 32
> ```

### 3. Database Migrations

Deploy the Drizzle schema and database constraints:

```bash
npx drizzle-kit push
```

### 4. Running Development & Production

```bash
# Run local development server
npm run dev

# Compile production build
npm run build

# Start production server
npm run start
```

### 5. Automated Test Suite

The suite is split into two isolated buckets so that everyday testing can
never touch a real environment:

| Command | Scope |
|---|---|
| `npm run test` | Unit & contract tests only — no database, no external services. |
| `npm run test:live` | LIVE integration suites against an **isolated Neon test branch** (+ live AI keys for the streaming smoke). |
| `npm run test:all` | Both buckets, sequentially. |

```bash
# Fast feedback loop (unit / contract only) — safe everywhere
npm run test

# Full live integration run (REQUIRES the isolated test branch setup below)
npm run test:live

# Run a single file from either bucket
npx vitest run src/lib/sanitize.test.ts
npx vitest run --config vitest.live.config.ts src/server/actions/file-ops.softdelete.test.ts

# Verify TypeScript types
npx tsc --noEmit
```

#### Isolated Test Branch (required for `test:live`)

LIVE suites never run against the app's production/main database. A fail-closed
guard (`src/test/test-db-guard.ts`) refuses to boot unless `TEST_DATABASE_URL`
is configured and reachable; every live run prints its branch identity line.
One-time setup:

```bash
# 1. Create a dedicated Neon branch and grab its pooled connection string
neonctl branches create --name test-suite --project-id <PROJECT_ID>
neonctl connection-string <BRANCH_ID> --project-id <PROJECT_ID> --pooled

# 2. Store it in `.env.test.local` (git-ignored, never committed)
#    TEST_DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require

# 3. Apply the schema to the branch (re-run after any src/lib/db change)
npx drizzle-kit push --config drizzle.config.test.ts --force
```

See [`docs/reference/test-database-isolation.md`](./docs/reference/test-database-isolation.md)
for the full architecture, guard rules, and the registry of LIVE suites.


---

## Core Engineering Subsystems

### 1. Atomic Quota Reservation & Gemini Engine

```
User Request ──► [reserveTodayUsage (Atomic SQL UPDATE)]
                     ├── If Quota Available ──► [Call Gemini AI] ──► Success (Keep Usage)
                     │                                   └── On Failure ──► [refundUsage (Atomic GREATEST(col - n, 0))]
                     └── If Quota Exhausted ──► Return HTTP 429 (Zero Over-Allocation)
```

- **TOCTOU Elimination:** Solves Time-of-Check to Time-of-Use race conditions across concurrent serverless instances. Word quotas are checked and incremented within a single atomic conditional SQL statement in `src/server/actions/ai-ops.ts`.
- **Fault-Tolerant Refunds:** In the event of downstream LLM timeout or network error, `refundUsage` issues a zero-bounded atomic decrement (`GREATEST(column - n, 0)`), preventing negative consumption counters.
- **Model Tiering & Key Rotation:** Distributes request load across multiple API keys with automated failover.

### 2. Stripe Subscription Lifecycle

- **Fail-Closed Webhook Processing:** The webhook handler (`src/app/api/stripe/webhook/route.ts`) maps all 8 Stripe subscription states explicitly. Unrecognized states abort execution rather than granting unwarranted tier upgrades.
- **Payment Verification:** `checkout.session.completed` strictly validates `payment_status === 'paid'` before tier elevation.
- **Database-Level Uniqueness:** The partial unique constraint `idx_subscriptions_stripe_id_unique` (`migrations/0004_stripe_constraints.sql`) prevents duplicate active subscriptions for a single customer.

### 3. Concurrency Control & Synchronization

- **SQL Optimistic Locking:** Both Server Actions (`src/server/actions/file-ops.ts`) and REST API routes (`src/app/api/files/[id]/route.ts`) enforce version-conditional SQL updates:
  ```sql
  UPDATE files 
  SET content = :newContent, version = version + 1, updated_at = NOW()
  WHERE id = :fileId AND user_id = :userId AND version = :currentVersion
  RETURNING *;
  ```
- **Conflict Recovery:** If an interleaved write occurs, the endpoint returns HTTP `412 Precondition Failed` containing the current server state (`serverVersion: { etag, version, content, updatedAt }`), allowing the client to execute an automated 3-way merge or present an interactive visual diff.
- **Bounded Worker Concurrency:** Offline sync operations (`pushDirtyFiles`) are bounded to 4 concurrent workers to protect upstream database connection pools.

### 4. Scheduled Maintenance & Cron

- **Automated Soft-Delete Purge:** `src/app/api/cron/purge-deleted/route.ts` permanently purges documents marked as deleted beyond the retention window.
- **Automated GitHub Action:** Dispatched daily at 03:00 UTC via `.github/workflows/cron.yml` with Bearer token authentication against `CRON_SECRET`.

---

## Security Architecture

| Security Layer | Technical Implementation |
|---|---|
| **XSS Sanitization** | Server-side DOMPurify (via JSDOM in `sanitize.server.ts`) cleans all incoming HTML content; client-side output escaping prevents injection. |
| **Authentication & Route Protection** | Supabase SSR session token validation in `src/proxy.ts` with sliding-window brute-force rate limiting (20 attempts / 15 mins per normalized email). |
| **API Rate Limiting** | Sliding window rate limiting on file sync routes and streaming AI endpoints. |
| **Webhook Security** | Cryptographic HMAC signature verification (`stripe.webhooks.constructEvent`) with replay attack mitigation. |
| **Secrets Isolation** | Strict `.gitignore` policy isolating `.env` secrets while providing tracked `.env.example` templates. |

---

## Documentation Index

Comprehensive architectural designs, references, guides, and engineering records
are maintained under [`docs/`](./docs). The full map lives in the
**[Documentation Master Index](./docs/README.md)**; the layout is organized as:

| Folder | Content |
|--------|---------|
| `docs/architecture/` | Subsystem designs: sync lifecycle, queue/GC/rollback, 3-way merge, file ownership, AI quota & atomic commit, streaming protocol, security & rate limiting |
| `docs/reference/` | API contracts (`SYNC_API`, `SYNC_ARCHITECTURE`) and implementation specs |
| `docs/specs/` | Design blueprints (offline-first sync plan, AI key rotation, UI streaming requirements) |
| `docs/guides/` | How-tos (Stripe setup/integration, AI model config, editor features) |
| `docs/records/` | Dated engineering records (hardening rounds M0–M5/W10, incident reports, test-fix history) |
| `docs/CHANGELOG.md` · `docs/TECHNICAL_DEBT_REGISTER.md` | Release history and living debt register |

---

## Deployment Blueprints

### Vercel (Recommended)
Deploy directly with Vercel Next.js App Router support. Vercel automatically detects `vercel.json` for cron scheduling and handles edge caching.

### GitHub Actions Scheduled Cron
Ensure `CRON_SECRET` and `DEPLOY_URL` are added to your repository's **Settings > Secrets and variables > Actions**. The `.github/workflows/cron.yml` workflow will trigger daily maintenance automatically.

### Self-Hosted Docker / Linux Server
Schedule maintenance with a system cron job:
```bash
0 3 * * * curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/purge-deleted
```

---

## Contributing & License

Contributions are welcome! Please ensure all submissions maintain 100% test coverage and pass `tsc --noEmit` checks.

Licensed under the [Apache License 2.0](./LICENSE). All reproductions, modifications, and derivative distributions must retain the explicit attribution terms specified in the [NOTICE](./NOTICE) file.

---

<p align="center">
  <sub>Built with precision for high-performance linguistic workflows. © 2026 LUGX.</sub>
</p>
