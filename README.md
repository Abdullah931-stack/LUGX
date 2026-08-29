<p align="center">
  <a href="https://github.com/Abdullah931-stack/LUGX">
    <img src="./public/lugx-icon.svg" width="120" height="120" alt="LUGX Logo" />
  </a>
</p>

<h1 align="center">LUGX</h1>

<p align="center">
  <strong>Enterprise AI Proofreading, Linguistic Enhancement & Intelligent Translation Platform</strong><br />
  High-concurrency text editor engineered for Arabic and English with atomic quota reservation, fail-closed Stripe monetization, bidirectional typography, and a ground-up offline-first synchronization engine.
</p>

<p align="center">
  <a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-16.1.4-black?style=for-the-badge&logo=next.js" alt="Next.js 16" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19.2.3-20232A?style=for-the-badge&logo=react" alt="React 19" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22_LTS-339933?style=for-the-badge&logo=node.js" alt="Node.js 22 LTS" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript" alt="TypeScript 5" /></a>
  <a href="https://orm.drizzle.team"><img src="https://img.shields.io/badge/Drizzle_ORM-0.45.1-C5F74F?style=for-the-badge&logo=drizzle" alt="Drizzle ORM" /></a>
  <a href="https://ai.google.dev"><img src="https://img.shields.io/badge/Gemini_AI-SDK_0.24-8E75B2?style=for-the-badge&logo=google" alt="Google Gemini AI" /></a>
  <a href="https://stripe.com"><img src="https://img.shields.io/badge/Stripe-Fail--Closed_Webhooks-635BFF?style=for-the-badge&logo=stripe" alt="Stripe" /></a>
  <a href="https://vitest.dev"><img src="https://img.shields.io/badge/Vitest-37%20Suites%20·%20488%2F488%20Passing-6E9F18?style=for-the-badge&logo=vitest" alt="Vitest 488 Passing" /></a>
  <a href="#contributing--license"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge&logo=apache" alt="License Apache 2.0" /></a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Architectural Statement: Custom Ground-Up Synchronization Engine](#architectural-statement-custom-ground-up-synchronization-engine)
- [Architecture & Tech Stack](#architecture--tech-stack)
- [Project Structure](#project-structure)
- [Quickstart & Setup](#quickstart--setup)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Environment Configuration](#2-environment-configuration)
  - [3. Database Migrations](#3-database-migrations)
  - [4. Running Development & Production](#4-running-development--production)
  - [5. Automated Test Suite](#5-automated-test-suite)
- [Core Engineering Subsystems](#core-engineering-subsystems)
  - [1. Standalone Markdown Editor & Bidirectional (Bidi) Engine](#1-standalone-markdown-editor--bidirectional-bidi-engine)
  - [2. Offline-First Synchronization & 3-Way Merge Engine](#2-offline-first-synchronization--3-way-merge-engine)
  - [3. Real-Time AI Streaming & Dual-Phase Atomic Quota Lifecycle](#3-real-time-ai-streaming--dual-phase-atomic-quota-lifecycle)
  - [4. Smart Hybrid Database Client & Neon Isolated Test Infrastructure](#4-smart-hybrid-database-client--neon-isolated-test-infrastructure)
  - [5. Fail-Closed Stripe Subscription Lifecycle & State Machine](#5-fail-closed-stripe-subscription-lifecycle--state-machine)
  - [6. Scheduled Maintenance & Cron Automation](#6-scheduled-maintenance--cron-automation)
- [Security Architecture](#security-architecture)
- [Documentation Index](#documentation-index)
- [Deployment Blueprints](#deployment-blueprints)
- [Contributing & License](#contributing--license)

---

## Overview

**LUGX** is an enterprise-grade cloud text editing and linguistic intelligence workstation designed specifically for bilingual Arabic and English content. It combines real-time AI assistance (grammar correction, style enhancement, translation, summarization, and prompt engineering) with a native, distraction-free Markdown editor, deterministic offline-first synchronization, resilient concurrency control, and a rock-solid subscription engine.

### Key Capabilities
- ✍️ **Native Markdown Editor & Bidi Engine:** Built on CodeMirror 6 with live AST token decorations, line-level bidirectional isolation (`bidiLinePlugin`), three direction modes (`auto`, `rtl`, `ltr`), and code block LTR locking.
- 📴 **Custom Offline-First Synchronization:** User-partitioned IndexedDB storage (`textai_db_${userId}`), deterministic 3-way linear diff merge, SHA-256 ETag verification, bounded worker queues, automatic GC compaction, and atomic rollback snapshots.
- ⚡ **Dual-Phase Atomic Quota Reservation:** Eliminates TOCTOU race conditions with database-level conditional leases (`ai_reservations`), 60s TTL safety, and zero-bounded atomic refunds (`GREATEST(column - n, 0)`).
- 🤖 **Resilient AI NDJSON Streaming:** High-performance inline preview card (`CMStreamingGhostWidget`) positioned at exact document offsets with 60fps in-place DOM updates, 3-state decision triggers (`Accept`, `Reject`, `Retry`), and a distributed 3-state circuit breaker with multi-key API rotation.
- 💳 **Fail-Closed Stripe Subscriptions:** 8-state exhaustive webhook state machine with database-level uniqueness constraints preventing duplicate entitlements.
- 🛡️ **Smart Hybrid Database Client:** Dual-protocol architecture supporting `@neondatabase/serverless` (HTTP/WebSocket) for Neon Cloud serverless edges and `pg.Pool` (TCP) for local Docker, CI, and development environments.

---

## Architectural Statement: Custom Ground-Up Synchronization Engine

> [!IMPORTANT]
> ### Design Rationale & Concurrency Problem-Solving Mastery
> 
> A defining engineering pillar of LUGX is its **custom, zero-dependency offline-first synchronization and concurrency engine** (`src/lib/sync/*`), designed and built entirely from scratch without relying on third-party synchronization frameworks or reference projects.

### 1. The Engineering Intent
The decision to build a ground-up synchronization engine was driven by the desire to demonstrate **deep algorithmic mastery over distributed state, optimistic updates, and concurrency conflict resolution** in web applications. The resulting engine implements:
- A linear **3-Way Line-Based Merge Algorithm** (`src/lib/sync/conflict-resolver.ts`) that cleanly reconciles concurrent non-overlapping local and remote edits without data loss.
- An **Append-Only Operation Log** tracking granular mutations (`insert`, `delete`, `update`, `create`, `rename`, `move`).
- A **Bounded Worker Queue** with concurrency throttles (4 workers) and exponential backoff with jitter to protect backend connection pools.
- An **Automated Garbage Collection & Compaction Subsystem** with a 7-day TTL window (`src/lib/sync/operations-gc.ts`).
- **Dead-Letter Queue (DLQ)** isolation and **Pre-Operation Rollback Snapshots** ensuring that failed sync operations never corrupt local document state.
- **Cross-Tab Synchronization** orchestrated via native `BroadcastChannel` APIs and centralized write controller guards (`src/hooks/use-editor-orchestrator.ts`).

### 2. Acknowledgment of Standard Solutions (e.g., Yjs)
We are fully aware of industry-standard collaborative editing and CRDT frameworks—most notably **Yjs**—which provide robust real-time shared editing capabilities, have first-class CodeMirror 6 bindings, and were evaluated during early architecture reviews. 

The decision to implement a custom engine rather than adopting Yjs was a **deliberate and conscious design choice** grounded in three core factors:

1. **Project Scope & Portfolio Showcase:** In its current phase, LUGX is engineered as a high-caliber showcase for a personal engineering portfolio and as a dedicated tool to solve a specific personal bilingual writing workflow. There is no immediate commercial or multi-user collaborative editing requirement that mandates full CRDT state vectors.
2. **Performance & Extreme Lightweight Footprint:** The custom sync engine is lean, purpose-built, and tightly coupled to raw Markdown text. It avoids the significant memory overhead, complex state vector serialization, and heavy bundle weight associated with general-purpose CRDT frameworks.
3. **Future Architectural Flexibility:** Clean abstraction boundaries were intentionally established across the system (`EditorAdapter` in `src/components/editor/markdown/editor-adapter.ts`, `useSync` in `src/hooks/use-sync.ts`, and `SyncManager` in `src/lib/sync/sync-manager.ts`). If the platform transitions to a commercial product requiring real-time multi-user live collaboration, the architecture is designed so that the sync layer can either be extended or seamlessly swapped for Yjs without requiring radical structural changes to the editor components, database schema, or UI.

*In summary, adopting the custom synchronization engine reflects deliberate engineering discipline and algorithmic problem-solving rather than unfamiliarity with existing industry standards.*

---

## Architecture & Tech Stack

| Domain | Technology / Specification | Purpose / Implementation Highlights |
|---|---|---|
| **Runtime & Framework** | Next.js 16 (App Router) · React 19 · Node.js 22 LTS | Turbopack compilation, Server Components, and Edge Proxies |
| **Language & Typings** | TypeScript 5 (Strict Mode) | Full type-safety across client hooks, server actions, and DB schemas |
| **Styling & Design System** | Tailwind CSS 4 · Radix UI Primitives · Lucide Icons | Dark Glassmorphism, tailored typography, and accessible UI controls |
| **Markdown Editor & Bidi** | Standalone CodeMirror 6 (`MarkdownEditor` & `EditorAdapter`) | Live AST preview decorations, line-level Bidi isolation, LTR code block lock |
| **Database & ORM** | PostgreSQL (Neon Cloud / Local) · Drizzle ORM | Smart Hybrid DB Client (`neon-http` / `pg.Pool`), Migrations 0001–0005 |
| **Authentication & Proxy** | Supabase Auth SSR · Next.js 16 Edge Proxy (`src/proxy.ts`) | Deep-link preservation, session renewal, and protected route gating |
| **Offline Synchronization** | Custom Engine · IndexedDB (`textai_db_${userId}`) | 3-Way Merge, ETag optimistic locks (HTTP 412), Bounded Queue, GC, DLQ |
| **AI LLM Engine** | Google Gemini SDK (`@google/generative-ai`) | NDJSON streaming, 2-phase quota reservation, 3-state circuit breaker |
| **Payment & Billing** | Stripe SDK · Webhook Signature Verification | 8-state fail-closed state machine, partial unique constraint idempotency |
| **Rate Limiting & Cache** | Upstash Redis · Sliding Window Algorithm | Tier-based rate limiting on Auth, File Operations, and AI Streaming |
| **Testing Harness** | Vitest · Neon Isolated Branch Integration Runner | 37 unit/contract test suites (488 tests) + 15 live database test suites |

---

## Project Structure

```
lugx/
├── .github/
│   └── workflows/
│       └── cron.yml               # Scheduled maintenance workflow (Daily 03:00 UTC)
├── docs/                          # Comprehensive technical documentation & governance
│   ├── README.md                  # Master structural map and documentation index
│   ├── CHANGELOG.md               # Versioned engineering changelog (v1.0.0 through v1.23.0)
│   ├── TECHNICAL_DEBT_REGISTER.md # Living register of accepted debts and resolution history
│   ├── DOCUMENTATION_GUIDELINES.md# Rules for authoring, linking, and updating documentation
│   ├── architecture/              # Subsystem designs (sync, bidi, quota, streaming, security, etc.)
│   ├── foundation/                # Verbatim founding design records & DESIGN_VS_REALITY.md
│   ├── guides/                    # Operational how-tos (Stripe, AI models, Editor Bidi enhancements)
│   ├── reference/                 # API contracts, test isolation, and phase execution closure records
│   └── specs/                     # Living technical specifications and architectural blueprints
├── migrations/                    # Versioned Drizzle SQL migration files (0001–0005)
├── public/                        # Static brand assets (lugx-icon.svg, icon.svg)
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── api/                   # REST API endpoints (sync, AI stream, Stripe webhook, cron)
│   │   ├── (auth)/                # Login & OAuth callback routes
│   │   ├── (dashboard)/           # Workspace dashboard & file manager
│   │   ├── workspace/editor/      # Dedicated Markdown editor interface
│   │   ├── layout.tsx             # Root layout with bilingual typography and theme providers
│   │   └── globals.css            # Design tokens, Dark Glassmorphism, and Tailwind utilities
│   ├── components/                # Modular React UI components
│   │   ├── editor/                # Toolbar, direction menu, search-replace, streaming ghost widget
│   │   │   └── markdown/          # Standalone CodeMirror 6 editor, adapter, and Bidi plugins
│   │   ├── sync/                  # Conflict resolution split-diff dialog and sync status indicators
│   │   └── ui/                    # Base Radix UI primitives and modal dialogs
│   ├── config/                    # Static configuration (models.config.json, tiers.config.ts)
│   ├── hooks/                     # Custom React hooks (useSync, useEditorOrchestrator, useAIStream)
│   ├── lib/
│   │   ├── ai/                    # Gemini client, NDJSON stream handler, key rotation, prompts
│   │   ├── db/                    # Drizzle schema, Smart Hybrid Client, and transactional runner
│   │   ├── exporters/             # Pure Markdown and Plain Text file export strategies
│   │   ├── parsers/               # File import validators, stream parsers, and PDF/Text extractors
│   │   ├── stripe/                # Stripe client initialization and webhook handlers
│   │   └── sync/                  # IndexedDB manager, 3-way merge, GC, rollback, and ETag engine
│   ├── server/actions/            # Authenticated Next.js Server Actions (file-ops, ai-ops, ai-commit)
│   ├── test/                      # Database integration test harnesses, fixtures, and unit suites
│   └── proxy.ts                   # Next.js 16 Edge proxy for session validation and deep-link routing
├── vitest.config.ts                # Default unit/contract test runner (isolated, fast feedback)
├── vitest.live.config.ts           # LIVE integration test runner (isolated Neon test branch)
└── package.json
```

---

## Quickstart & Setup

### 1. Prerequisites

- **Node.js**: `v22.x LTS` (or `v20.x+`)
- **Package Manager**: `npm` (or `pnpm` / `yarn`)
- **Database**: PostgreSQL 14+ instance (Neon Cloud, local Docker, or Supabase)

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
# Database Connection (Neon Cloud or standard PostgreSQL)
DATABASE_URL="postgresql://user:password@ep-sample-pooler.region.neon.tech/neondb?sslmode=require"

# Supabase Authentication
NEXT_PUBLIC_SUPABASE_URL="https://your-project.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Upstash Redis (Rate limiting and key rotation circuit breaker)
UPSTASH_REDIS_REST_URL="https://your-redis.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-redis-token"

# Google Gemini AI (Supports multi-key pool with automated fallback)
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

### 3. Database Migrations

Deploy the Drizzle schema and database constraints:

```bash
npx drizzle-kit push
```

### 4. Running Development & Production

```bash
# Run local development server (with Turbopack)
npm run dev

# Compile production build
npm run build

# Start production server
npm run start
```

### 5. Automated Test Suite

The test suite is partitioned into two isolated tiers to prevent local tests from mutating live databases:

| Command | Scope | Characteristics |
|---|---|---|
| `npm run test` | Unit & Contract test suites | Zero external dependencies; runs in ~10–25s. |
| `npm run test:live` | LIVE Integration test suites | Executes against an isolated Neon test branch with fail-closed guards. |
| `npm run test:all` | Both suites sequentially | Comprehensive pre-deployment verification. |

```bash
# Execute unit/contract test suites (37 test files, 488 tests)
npm run test

# Execute live database integration test suites
npm run test:live

# Verify strict TypeScript typing
npx tsc --noEmit

# Execute ESLint verification
npm run lint
```

---

## Core Engineering Subsystems

### 1. Standalone Markdown Editor & Bidirectional (Bidi) Engine

LUGX operates exclusively on pure **UTF-8 Markdown strings** (normalized via Unicode NFC and LF line endings), completely eliminating intermediate HTML parsing, serialization, and sanitization.
- **Engine-Agnostic EditorAdapter (`src/components/editor/markdown/editor-adapter.ts`):** Encapsulates the underlying CodeMirror 6 instance, exposing clean transactional methods (`getValue`, `setValue`, `replaceRange`, `getSelection`, `setSelection`).
- **Live Preview Decorations:** Markdown syntax tokens are dynamically hidden or styled using non-destructive CodeMirror 6 `Decoration.mark` overlays without mutating the underlying document buffer.
- **Bidirectional (Bidi) Engine (`src/components/editor/markdown/bidi-line-plugin.ts`):**
  - Implements line-level text direction analysis with 3 selectable modes: `auto` (auto-detects first strong RTL/LTR character per paragraph), `rtl`, and `ltr`.
  - Enforces **Code Block LTR Locking** (`lockCodeBlocksLTR`): Fenced code blocks (` ``` `) and inline code segments are strictly locked to LTR rendering regardless of surrounding Arabic text.
  - Direction controls integrated seamlessly via `DirectionMenu` in the editor toolbar.
- **Multi-Range Atomic Transactions in Search & Replace (`src/components/editor/search-replace.tsx`):**
  - Searches operate over UTF-16 document offsets.
  - `Replace All` batches all mutation targets into a single CodeMirror `ChangeSpec[]` transaction, preventing offset shifting and preserving complete undo/redo history.

### 2. Offline-First Synchronization & 3-Way Merge Engine

```
[Local Edit in Editor] ──► [Save to IndexedDB (textai_db_${userId})] ──► [Append to Operation Log]
                                                                                │
[Background Sync Queue (Max 4 Workers)] ◄────────────────────────────────────────┘
       │
       ├──► Push to Server: PUT /api/files/:id (If-Match: local.etag)
       │        ├── 200 OK ──► Update Local ETag & Advance Monotonic Version Counter
       │        └── 412 Conflict ──► Fetch serverVersion ──► Execute 3-Way Line Merge
       │                                                          ├── Non-Overlapping ──► Auto-Commit
       │                                                          └── Overlapping ──► Interactive Diff Dialog
```

- **User-Partitioned IndexedDB (`src/lib/sync/indexeddb.ts`):** Client state is isolated per user (`textai_db_${userId}`), storing `files`, `operations`, and `sync_metadata`.
- **Deterministic 3-Way Merge Engine (`src/lib/sync/conflict-resolver.ts`):**
  - Compares Base Ancestor, Local Dirty State, and Server Remote State.
  - Non-overlapping line modifications are automatically merged and committed without user disruption.
  - Overlapping conflicts trigger the interactive visual split-diff dialog (`src/components/sync/conflict-dialog.tsx`).
- **Bounded Worker Queue & Resilience (`src/lib/sync/sync-manager.ts`):**
  - Concurrency is throttled to 4 parallel workers with adaptive exponential backoff and jitter.
  - Unrecoverable failures are isolated to the Dead-Letter Queue (DLQ).
  - Pre-operation rollback snapshots (`snapshot`) ensure that failed synchronization attempts safely restore previous document state.
- **Automatic Garbage Collection (`src/lib/sync/operations-gc.ts`):** Prunes synced operation logs older than 7 days and compacts historical edits into clean baseline snapshots.

### 3. Real-Time AI Streaming & Dual-Phase Atomic Quota Lifecycle

```
User AI Request ──► [1. Reserve Quota (ai_reservations Lease in PostgreSQL)]
                          │
                          ├── Insufficient Quota ──► Return HTTP 429
                          └── Quota Reserved ──► [2. Stream Gemini NDJSON via Route Handler]
                                                       │
         ┌─────────────────────────────────────────────┴─────────────────────────────────────────────┐
         ▼                                                                                           ▼
   [Stream Success]                                                                           [Stream Failure / Abort]
   Inline Ghost Preview Card (`CMStreamingGhostWidget`)                                       Atomic Quota Refund
   User Decision Trigger:                                                                     `GREATEST(usage - n, 0)`
   ├── [Accept / Apply] ──► Atomic Commit Server Transaction & Local Replace
   ├── [Reject] ──► Discard Preview (No Document Mutation)
   └── [Retry] ──► Release Lease & Re-trigger Stream
```

- **Dual-Phase Quota Reservation (`src/server/actions/ai-ops.ts`):**
  - Words are reserved prior to generation by creating an active lease in `ai_reservations` with a 60-second TTL.
  - Eliminates TOCTOU race conditions across distributed serverless functions.
  - Downstream stream failures, timeouts, or client aborts immediately trigger atomic, zero-bounded refunds (`GREATEST(column - n, 0)`).
- **Unified Inline Interactive Preview Card (`src/components/editor/markdown/streaming-ghost.ts`):**
  - Eliminates static top preview panels in favor of an inline CodeMirror 6 `WidgetType` positioned at the exact document mutation point.
  - Dynamic coordinate mapping via `tr.changes.mapPos` ensures preview decorations adjust smoothly to concurrent user edits.
  - Real-time action controls: `Stop Generation` during active streaming, followed by explicit decision buttons (`Accept`, `Reject`, `Retry`) upon stream completion.
- **Distributed Circuit Breaker & Key Pool (`src/lib/ai/key-rotation.ts`):**
  - 3-state circuit breaker (`CLOSED`, `OPEN`, `HALF-OPEN`) tracking failures in Upstash Redis.
  - Multi-key rotation pool with automated failover from `gemini-3.7-flash` (primary) to `gemini-3.6-flash` (fallback).

### 4. Smart Hybrid Database Client & Neon Isolated Test Infrastructure

- **Dual-Protocol Database Client (`src/lib/db/index.ts` & `src/lib/db/transactional.ts`):**
  - **Neon Serverless Protocol:** Uses `@neondatabase/serverless` over HTTP/WebSocket for ultra-low latency query execution in serverless edge runtimes.
  - **Node-Postgres Protocol:** Automatically falls back to standard `pg.Pool` over TCP when running in local Docker containers, CI pipelines, or non-Neon PostgreSQL environments, eliminating SSL connection pool mismatches.
- **Isolated Branching for Integration Tests (`src/test/test-db-guard.ts`):**
  - Live integration suites execute exclusively against a dedicated, isolated Neon test branch (`TEST_DATABASE_URL`).
  - Fail-closed runtime guards verify branch identity and refuse to boot against production databases.

### 5. Fail-Closed Stripe Subscription Lifecycle & State Machine

- **Exhaustive 8-State Mapping (`src/app/api/stripe/webhook/route.ts`):** Handles `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, and `paused`.
- **Zero False Entitlements:** Unrecognized webhook payloads fail closed, aborting transaction execution rather than granting unwarranted tier upgrades.
- **Database-Level Idempotency (`migrations/0004_stripe_constraints.sql`):** Partial unique index `idx_subscriptions_stripe_id_unique` guarantees that duplicate webhook deliveries cannot create duplicate active subscriptions for a single customer.
- **Atomic Audit Trail:** Webhook transactions record state transitions in `subscription_events` alongside user tier updates.

### 6. Scheduled Maintenance & Cron Automation

- **Automated Soft-Delete Purge (`src/app/api/cron/purge-deleted/route.ts`):** Permanently purges documents and folders marked as deleted (`deletedAt`) beyond the 30-day retention window.
- **Secure Dispatch:** Protected by Bearer token validation against `CRON_SECRET` and dispatched daily at 03:00 UTC via `.github/workflows/cron.yml`.

---

## Security Architecture

| Security Domain | Technical Implementation | Security Property Enforced |
|---|---|---|
| **Content Model Security** | Pure UTF-8 Markdown strings & AST token decorations | Zero HTML storage, zero `dangerouslySetInnerHTML`, total elimination of stored XSS vectors. |
| **Authentication & Proxy** | Next.js 16 Edge Proxy (`src/proxy.ts`) with Supabase SSR | Route protection on `/workspace`, `/dashboard`, `/account` with deep-link query preservation. |
| **Brute-Force & Rate Limiting** | Sliding window rate limiting on Upstash Redis | Per-user and per-endpoint sliding window limits on Auth, Sync, and AI routes. |
| **Tenant Resource Isolation** | SQL ownership predicates (`WHERE id = :id AND user_id = :userId`) | Prevents IDOR and resource enumeration by returning uniform `404 Not Found` for foreign IDs. |
| **Financial Webhook Security** | Cryptographic HMAC signature verification (`stripe.webhooks.constructEvent`) | Mitigates replay attacks and validates webhook payload authenticity before DB mutation. |
| **Database Injection Safety** | Drizzle ORM parameterized SQL queries | Eliminates SQL injection across all dynamic query and transaction paths. |

---

## Documentation Index

Comprehensive architectural designs, specifications, guides, and engineering records are maintained under [`docs/`](./docs). The complete map lives in the **[Documentation Master Index](./docs/README.md)**:

| Directory | Content Scope | Key Documents |
|---|---|---|
| [`docs/architecture/`](./docs/architecture/) | Subsystem architectural designs | [`sync-lifecycle-architecture.md`](./docs/architecture/sync-lifecycle-architecture.md), [`editor-sync-orchestration.md`](./docs/architecture/editor-sync-orchestration.md), [`ai-atomic-commit-architecture.md`](./docs/architecture/ai-atomic-commit-architecture.md), [`ai-quota-reservation-lifecycle.md`](./docs/architecture/ai-quota-reservation-lifecycle.md), [`ai-streaming-protocol.md`](./docs/architecture/ai-streaming-protocol.md), [`three-way-conflict-resolution.md`](./docs/architecture/three-way-conflict-resolution.md), [`security-and-rate-limiting.md`](./docs/architecture/security-and-rate-limiting.md) |
| [`docs/reference/`](./docs/reference/) | API contracts & phase closure records | [`SYNC_API.md`](./docs/reference/SYNC_API.md), [`test-database-isolation.md`](./docs/reference/test-database-isolation.md), [`phase-1` through `phase-14` closure reports](./docs/reference/) |
| [`docs/specs/`](./docs/specs/) | Living technical specifications | [`Plan for an improved synchronization system.md`](./docs/specs/Plan%20for%20an%20improved%20synchronization%20system.md), [`AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md`](./docs/specs/AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md), [`UI_STREAMING_ARCHITECTURE_REQUIREMENTS.md`](./docs/specs/UI_STREAMING_ARCHITECTURE_REQUIREMENTS.md) |
| [`docs/guides/`](./docs/guides/) | Developer & operational how-tos | [`STRIPE_INTEGRATION.md`](./docs/guides/STRIPE_INTEGRATION.md), [`STRIPE_SETUP.md`](./docs/guides/STRIPE_SETUP.md), [`AI_MODELS_CONFIG.md`](./docs/guides/AI_MODELS_CONFIG.md), [`Editor_UI_Enhancements.md`](./docs/guides/Editor_UI_Enhancements.md), [`Search_Replace_Feature.md`](./docs/guides/Search_Replace_Feature.md) |
| [`docs/foundation/`](./docs/foundation/) | Verbatim founding design & divergence log | [`DESIGN_VS_REALITY.md`](./docs/foundation/DESIGN_VS_REALITY.md), [`Project_Structure.md`](./docs/foundation/Project_Structure.md), [`LUGX platform subscription plans.md`](./docs/foundation/LUGX%20platform%20subscription%20plans.md) |
| Root Registers | Release history & debt tracking | [`CHANGELOG.md`](./docs/CHANGELOG.md), [`TECHNICAL_DEBT_REGISTER.md`](./docs/TECHNICAL_DEBT_REGISTER.md), [`DOCUMENTATION_GUIDELINES.md`](./docs/DOCUMENTATION_GUIDELINES.md) |

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

