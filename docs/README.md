# LUGX Documentation — Master Structural Index

This index maps every document under `docs/`. It is a **structural map only**:
operational documentation rules live outside this file — see
[DOCUMENTATION_GUIDELINES.md](./DOCUMENTATION_GUIDELINES.md) for repository-visible
authoring standards (enforced locally via `.agents/rules/`). Source code and
automated tests remain the single source of truth for all technical claims.

---

## 1. Directory Tree Map

```
docs/
├── README.md                          ← you are here (structural master index)
├── DOCUMENTATION_GUIDELINES.md        ← repository-visible authoring standards & planning governance
├── CHANGELOG.md                       ← release history (v1.0.0 through v1.32.1)
├── TECHNICAL_DEBT_REGISTER.md         ← living technical debt & architectural decisions (TD-01 to TD-12)
│
├── architecture/                      ← subsystem designs, protocols, state machines
│   ├── sync/                          ← offline-first sync engine, concurrency & storage
│   ├── ai/                            ← Gemini LLM streaming, atomic commit & quota lifecycle
│   └── security/                      ← rate limiting, edge proxy, crypto workers & ZK log masking
│
├── reference/                         ← living API contracts, hooks & testing runner specifications
│   ├── sync-api.md                    ← REST contracts for /api/files/sync & client hook contracts
│   ├── ui-streaming-readiness.md      ← G1–G11 readiness-gate compliance matrix
│   └── test-database-isolation.md     ← isolated Neon test runner & fail-closed guard specification
│
├── guides/                            ← operational how-to guides & feature walkthroughs
│   ├── billing/                       ← Stripe products, webhooks & checkout lifecycle
│   ├── editor/                        ← CodeMirror 6 UI enhancements, search/replace & export guide
│   └── ai/                            ← decoupled Gemini model configuration via models.config.json
│
├── specs/                             ← living technical specifications & design blueprints
│   ├── ai-key-rotation-and-resilience.md
│   ├── offline-sync-blueprint.md      ← foundational blueprint for IndexedDB offline synchronization
│   └── ui-streaming-requirements.md
│
├── Plans/                             ← official tracked technical execution plans (English)
│   ├── TECHNICAL_EXECUTION_PLAN.md    ← code-based execution plan (Phases 1–20 closed)
│   ├── HYBRID_ENCRYPTION_AND_VAULT_PLAN.md ← zero-knowledge vault execution plan (closed)
│   ├── MARKDOWN_EDITOR_MIGRATION_PLAN.md   ← CodeMirror 6 migration plan (closed)
│   └── PRODUCTION_HARDENING_AND_REMEDIATION_PLAN_M6.md ← production hardening plan (M6 closed)
│
├── records/                           ← engineering records, incidents, audits & closures
│   ├── incidents/                     ← root-cause post-mortems (test-database-safety.md)
│   ├── audits/                        ← verification audit records (W10-Final-Closure-Round.md)
│   ├── closures/                      ← official milestone & phase closure dossiers (Phases 1–20)
│   │   ├── phase-01-to-06-markdown-editor/
│   │   ├── phase-11-to-15-core-infrastructure/
│   │   ├── phase-16-vault-encryption/
│   │   ├── phase-17-to-20-production-readiness/
│   │   └── extensions/                ← pdf worker extraction & vault import closure
│   └── archive/                       ← legacy development logs & superseded delivery snapshots
│
├── foundation/                        ← founding pre-implementation baseline record (strictly immutable)
│   ├── DESIGN_VS_REALITY.md           ← living divergence tracker measuring design vs reality
│   ├── Project_Structure.md
│   ├── System Architecture Design.md
│   ├── Product Requirements Document (PRD).md
│   ├── LUGX platform subscription plans.md
│   ├── UI_UX Guidelines.md
│   ├── Implementation_Master_Plan.md
│   └── Using AI/                      ← original prompt specs (AI Key Document, correct, improve...)
│
└── .Plans/                            ← internal candidate planning incubator (Arabic, untracked via .gitignore)
```

---

## 2. Document Index

### 2.1. Central Registers (`docs/`)

| Document | Scope & Purpose |
| :--- | :--- |
| [README.md](./README.md) | Structural master index mapping every document in the repository |
| [DOCUMENTATION_GUIDELINES.md](./DOCUMENTATION_GUIDELINES.md) | Policy on create/update/merge, nested directories, evidence discipline, and dual-track planning governance |
| [CHANGELOG.md](./CHANGELOG.md) | Append-only chronological release notes covering v1.0.0 through v1.32.1 |
| [TECHNICAL_DEBT_REGISTER.md](./TECHNICAL_DEBT_REGISTER.md) | Living register of accepted debts, mitigations, and resolution status (TD-01 to TD-12) |

---

### 2.2. Architecture (`architecture/`) — Living Subsystem Documentation

#### Sync & Storage Engine (`architecture/sync/`)

| Document | Scope |
| :--- | :--- |
| [sync-lifecycle-architecture.md](./architecture/sync/sync-lifecycle-architecture.md) | Offline sync lifecycle, user-scoped partitioning, explicit `SyncStatus` state machine, cryptographic gateway (`SyncCryptoGateway`) |
| [queue-gc-rollback-architecture.md](./architecture/sync/queue-gc-rollback-architecture.md) | Operations queue, exponential backoff/dead-letter, state-safe GC, rollback isolation |
| [three-way-conflict-resolution.md](./architecture/sync/three-way-conflict-resolution.md) | 3-way merge engine, base snapshots, false-conflict elimination, encrypted inbound gateway, conflict dialog, and centralized syntax validation |
| [editor-sync-orchestration.md](./architecture/sync/editor-sync-orchestration.md) | Unified editor write controller: autosave gates, reconciliation, AI transaction guard, inbound remote decryption |
| [file-ownership-and-versioning.md](./architecture/sync/file-ownership-and-versioning.md) | Server-side ownership enforcement, hierarchy safety, optimistic locking (412/428) |
| [sync-architecture-overview.md](./architecture/sync/sync-architecture-overview.md) | Layered sync system overview with Mermaid architecture & sequence flows, actual `useSync` hook contract, Phase 23 quarantine backpressure & diagnostics governance |

#### AI LLM Subsystem (`architecture/ai/`)

| Document | Scope |
| :--- | :--- |
| [ai-streaming-protocol.md](./architecture/ai/ai-streaming-protocol.md) | NDJSON wire protocol, session FSM, adversarial hardening |
| [ai-quota-reservation-lifecycle.md](./architecture/ai/ai-quota-reservation-lifecycle.md) | AI quota reservations, deduplication, 24h key rotation, settlement matrix (§4-D) |
| [ai-atomic-commit-architecture.md](./architecture/ai/ai-atomic-commit-architecture.md) | Transactional AI commit binding file update + quota settlement + version guard |

#### Security & Rate Limiting (`architecture/security/`)

| Document | Scope |
| :--- | :--- |
| [security-and-rate-limiting.md](./architecture/security/security-and-rate-limiting.md) | Edge Proxy auth gating, rate limiter tiers, Markdown normalization & XSS sanitization, Dual-Tier Hybrid Encryption (AES-GCM-256 + PBKDF2 600K worker, BIP-39 recovery, WebAuthn PRF Hardware Biometrics & 6-digit PIN, AAD integrity, RAM sanitization, device trust revocation via migration 0009, AI opt-in via migration 0010, Zero-Knowledge log hygiene & volatile RAM zeroing), cron purge |

---

### 2.3. Reference (`reference/`) — Living Technical Contracts

| Document | Scope |
| :--- | :--- |
| [sync-api.md](./reference/sync-api.md) | REST contract for `/api/files/sync` and `/api/files/:id`, client-side sync events, cryptographic interfaces, `LogSanitizer`, `SyncErrorHandler` & `SyncPerformanceMonitor` contracts |
| [ui-streaming-readiness.md](./reference/ui-streaming-readiness.md) | G1–G11 readiness-gate compliance matrix, dual atomicity model, feature flags |
| [test-database-isolation.md](./reference/test-database-isolation.md) | Phase 10: isolated Neon test branch — fail-closed guard, `test` vs `test:live` split, CI multi-stage pipeline, closure evidence |

---

### 2.4. Guides (`guides/`) — Operational How-To Guides

#### Billing & Monetization (`guides/billing/`)

| Document | Scope |
| :--- | :--- |
| [stripe-setup.md](./guides/billing/stripe-setup.md) | Stripe products, webhooks, env vars, test cards, go-live checklist |
| [stripe-integration.md](./guides/billing/stripe-integration.md) | Payment flow, library functions, API routes, troubleshooting |

#### Markdown Editor & Ingestion (`guides/editor/`)

| Document | Scope |
| :--- | :--- |
| [editor-ui-enhancements.md](./guides/editor/editor-ui-enhancements.md) | UI restructuring, copy/move file ops, dynamic statistics, text direction management menu, code block LTR locking, unified typography |
| [search-replace-feature.md](./guides/editor/search-replace-feature.md) | Editor search/replace behavior, debounce logic, shortcuts |
| [data-export-guide.md](./guides/editor/data-export-guide.md) | Data export module architecture, Markdown & Plain Text strategies, factory patterns, and validation rules |

#### AI Configuration (`guides/ai/`)

| Document | Scope |
| :--- | :--- |
| [ai-models-config.md](./guides/ai/ai-models-config.md) | Decoupled Gemini model/hyperparameter configuration via `models.config.json` |

---

### 2.5. Specifications (`specs/`)

| Document | Scope |
| :--- | :--- |
| [offline-sync-blueprint.md](./specs/offline-sync-blueprint.md) | Original offline-first blueprint: storage engine, background sync, roadmap M1–M8 |
| [ai-key-rotation-and-resilience.md](./specs/ai-key-rotation-and-resilience.md) | Circuit breaker states, key lifecycle, streaming watchdogs & terminality contract |
| [ui-streaming-requirements.md](./specs/ui-streaming-requirements.md) | Requirements/invariants for ephemeral ghost preview & atomic undo |

---

### 2.6. Plans (`Plans/`) — Official Tracked Execution Plans (English)

| Document | Scope | Status |
| :--- | :--- | :--- |
| [TECHNICAL_EXECUTION_PLAN.md](./Plans/TECHNICAL_EXECUTION_PLAN.md) | Code-based technical execution plan covering all 20 phases | ✅ Closed |
| [HYBRID_ENCRYPTION_AND_VAULT_PLAN.md](./Plans/HYBRID_ENCRYPTION_AND_VAULT_PLAN.md) | Dual-tier hybrid encryption & zero-knowledge vault execution plan | ✅ Closed |
| [MARKDOWN_EDITOR_MIGRATION_PLAN.md](./Plans/MARKDOWN_EDITOR_MIGRATION_PLAN.md) | Native CodeMirror 6 Markdown editor migration plan (Phases 1–6) | ✅ Closed |
| [PRODUCTION_HARDENING_AND_REMEDIATION_PLAN_M6.md](./Plans/PRODUCTION_HARDENING_AND_REMEDIATION_PLAN_M6.md) | Concurrency hardening, distributed webhook locks, RAM purge & conflict quarantine | ✅ Closed |

> **Dual-Track Planning Policy:** The `.Plans/` directory in the repository root is an **internal candidate planning incubator** (written in Arabic, untracked in Git via `.gitignore`). It serves as a scratchpad for drafting, evaluating, and incubating future ideas. Once an engineering plan is approved and executed, its authoritative English edition is published and tracked here under `docs/Plans/`.

---

### 2.7. Records (`records/`) — Engineering Records, Audits & Milestone Closures

#### Incidents (`records/incidents/`)

| Document | Scope / Date |
| :--- | :--- |
| [test-database-safety.md](./records/incidents/test-database-safety.md) | Unscoped test delete incident record, root cause, placeholder UUID architecture & cleanup guards — closed 2026-08-23 |

#### Audits (`records/audits/`)

| Document | Scope / Date |
| :--- | :--- |
| [W10-Final-Closure-Round.md](./records/audits/W10-Final-Closure-Round.md) | Concurrency-window closure F1 (SQL optimistic locking on `PUT /api/files/:id`) & Vitest `singleFork` serialization — 2026-08-16 |

#### Milestone Closures (`records/closures/`)

| Directory | Scope |
| :--- | :--- |
| [phase-01-to-06-markdown-editor/](./records/closures/phase-01-to-06-markdown-editor/) | Phase 1 to Phase 6 closure dossiers: standalone CodeMirror 6 editor, adapter, Diff3 merge, streaming export, and TipTap purge |
| [phase-11-to-15-core-infrastructure/](./records/closures/phase-11-to-15-core-infrastructure/) | Phase 11 to Phase 15 closure dossiers: editor orchestration, auth ownership, Stripe webhooks, Supabase storage purge, and file sanitization |
| [phase-16-vault-encryption/](./records/closures/phase-16-vault-encryption/) | Phase 16 closure dossiers: isolated Crypto Worker, schemas, UI conversion engine, AI safety gates, and 10-point test matrix |
| [phase-17-to-20-production-readiness/](./records/closures/phase-17-to-20-production-readiness/) | Phase 17 to Phase 20 closure dossiers: dual-mode rate limiting, live multi-system integration, Playwright E2E testing, and production readiness dossier |
| [extensions/](./records/closures/extensions/) | PDF Worker extraction, spatial table reconstruction, Arabic normalizer, and vault import closure report |

#### Archive (`records/archive/`)

| Document | Scope |
| :--- | :--- |
| [production-readiness-roadmap-m0-m5.md](./records/archive/production-readiness-roadmap-m0-m5.md) | Early milestone M0–M5 execution record (branch `production-readiness`, 2026-08-16) |
| [technical-fix-documentation-security-hardening.md](./records/archive/technical-fix-documentation-security-hardening.md) | Early W1–W8 hardening record (branch `merge`, 2026-08-16) |
| [sync-unit-tests-fixes.md](./records/archive/sync-unit-tests-fixes.md) | Early sync unit test fixes snapshot (February 2026) |
| [sync-system-legacy-snapshot.md](./records/archive/sync-system-legacy-snapshot.md) | Legacy initial sync delivery snapshot with historical deprecation banner |

---

### 2.8. Foundation (`foundation/`) — Founding Baseline Record

> **Immutable historical methodology record** — authored before any code was
> written. Preserved verbatim; it documents how the project's pillars were
> established, **not** the current system behavior. For divergences between this
> founding design and the implemented reality, see
> [`foundation/DESIGN_VS_REALITY.md`](./foundation/DESIGN_VS_REALITY.md).

| Document | Scope |
| :--- | :--- |
| [DESIGN_VS_REALITY.md](./foundation/DESIGN_VS_REALITY.md) | **Living Divergence Tracker:** Documents every architectural divergence between founding design and implemented reality |
| [Product Requirements Document (PRD).md](./foundation/Product%20Requirements%20Document%20%28PRD%29.md) | Founding product requirements |
| [System Architecture Design.md](./foundation/System%20Architecture%20Design.md) | Original architecture: IAM, data layer, key rotation, risk analysis |
| [Project_Structure.md](./foundation/Project_Structure.md) | Planned directory tree and component responsibilities |
| [Implementation_Master_Plan.md](./foundation/Implementation_Master_Plan.md) | Founding master implementation plan |
| [LUGX platform subscription plans.md](./foundation/LUGX%20platform%20subscription%20plans.md) | Tier definitions, quotas, pricing |
| [UI_UX Guidelines.md](./foundation/UI_UX%20Guidelines.md) | Visual direction, design system, components |
| [Using AI/AI Key Document.md](./foundation/Using%20AI/AI%20Key%20Document.md) | AI model matrix & generation parameters per operation |
| [Using AI/correct.md](./foundation/Using%20AI/correct.md) · `improve` · `summarize` · `toPrompt` · `translate` | Original system prompts (source material for `src/lib/ai/prompts.ts`) |

---

## 3. Suggested Reading Paths

- **Onboarding:** repo-root `README.md` → this index → [sync-architecture-overview.md](./architecture/sync/sync-architecture-overview.md) → [stripe-setup.md](./guides/billing/stripe-setup.md)
- **Sync deep-dive:** `sync-lifecycle-architecture` → `queue-gc-rollback-architecture` → `three-way-conflict-resolution` → [sync-api.md](./reference/sync-api.md) → `editor-sync-orchestration`
- **AI deep-dive:** `ai-streaming-protocol` → `ai-quota-reservation-lifecycle` → `ai-atomic-commit-architecture` → [ai-key-rotation-and-resilience.md](./specs/ai-key-rotation-and-resilience.md)
- **Security review:** [security-and-rate-limiting.md](./architecture/security/security-and-rate-limiting.md) → `file-ownership-and-versioning` → [test-database-safety.md](./records/incidents/test-database-safety.md)

---

## 4. Verification Commands

```bash
npm run lint            # static analysis & ESLint 9 code quality gate
npx tsc --noEmit        # strict TypeScript type-checking (0 errors)
npm audit --audit-level=high # dependency security audit (zero high/critical vulnerabilities)
npm run test            # pure unit, contract, and vault cryptographic test suites (67 files, 820 tests via vitest.config.mts)
npm run test:live       # live database integration suites against isolated test PostgreSQL/Neon (19 files, 89 tests via vitest.live.config.mts)
npm run test:e2e        # browser-driven E2E user journeys (14 specs, 15 scenarios via Playwright / Chromium)
npm run test:all        # full suite execution (unit + live)
npm run build           # Next.js 16 production bundle compilation
act push --pull=false   # local containerized execution of the 7-stage CI workflow
node scripts/verify-migrations.mjs     # test database migration & schema verification
```

When citing results anywhere under `docs/`, follow the Evidence Discipline rules
in [DOCUMENTATION_GUIDELINES.md §4](./DOCUMENTATION_GUIDELINES.md#4-evidence-discipline-mandatory).
