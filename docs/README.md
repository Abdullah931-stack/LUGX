# LUGX Documentation — Master Index

This index maps every document under `docs/`. It is a **structural map only**:
operational documentation rules live outside this file — see
[DOCUMENTATION_GUIDELINES.md](./DOCUMENTATION_GUIDELINES.md) for the
repository-visible standards (enforced locally via `.agents/rules/`). Source
code and tests remain the single source of truth for all technical claims.

---

## 1. Directory Map

```
docs/
├── README.md                    ← you are here (structural master index)
├── DOCUMENTATION_GUIDELINES.md  ← repository-visible authoring standards
├── CHANGELOG.md                 ← release history
├── TECHNICAL_DEBT_REGISTER.md   ← living debt & decision register
├── architecture/                ← subsystem designs, protocols, state machines
├── reference/                   ← API references & implementation specs
├── specs/                       ← design blueprints & requirements
├── guides/                      ← how-to guides & feature walkthroughs
├── records/                     ← dated engineering records (immutable history)
└── foundation/                  ← founding pre-implementation design record (immutable)
```

---

## 2. Document Index

### Architecture (`architecture/`) — living subsystem documentation

| Document | Scope |
| :--- | :--- |
| [sync-lifecycle-architecture.md](./architecture/sync-lifecycle-architecture.md) | Offline sync lifecycle, user-scoped partitioning, explicit `SyncStatus` state machine |
| [queue-gc-rollback-architecture.md](./architecture/queue-gc-rollback-architecture.md) | Operations queue, exponential backoff/dead-letter, state-safe GC, rollback isolation |
| [three-way-conflict-resolution.md](./architecture/three-way-conflict-resolution.md) | 3-way merge engine, base snapshots, false-conflict elimination, conflict dialog |
| [file-ownership-and-versioning.md](./architecture/file-ownership-and-versioning.md) | Server-side ownership enforcement, hierarchy safety, optimistic locking (412/428) |
| [ai-quota-reservation-lifecycle.md](./architecture/ai-quota-reservation-lifecycle.md) | AI quota reservations, deduplication, 24h key rotation, settlement matrix (§4-D) |
| [ai-atomic-commit-architecture.md](./architecture/ai-atomic-commit-architecture.md) | Transactional AI commit binding file update + quota settlement + version guard |
| [editor-sync-orchestration.md](./architecture/editor-sync-orchestration.md) | Unified editor write controller: autosave gates, reconciliation, AI transaction guard |
| [ai-streaming-protocol.md](./architecture/ai-streaming-protocol.md) | NDJSON wire protocol, session FSM, adversarial hardening |
| [security-and-rate-limiting.md](./architecture/security-and-rate-limiting.md) | Middleware auth gating, rate limiter tiers, XSS sanitization, AES-GCM encryption, cron purge |

### Reference (`reference/`)

| Document | Scope |
| :--- | :--- |
| [SYNC_API.md](./reference/SYNC_API.md) | REST contract for `/api/files/sync` and `/api/files/:id` — verified against route sources |
| [SYNC_ARCHITECTURE.md](./reference/SYNC_ARCHITECTURE.md) | Layered sync system overview with actual `useSync` hook contract |
| [SYNC_SYSTEM.md](./reference/SYNC_SYSTEM.md) | Original sync delivery snapshot *(historical banner inside)* |
| [UI_STREAMING_ARCHITECTURE_IMPLEMENTATION.md](./reference/UI_STREAMING_ARCHITECTURE_IMPLEMENTATION.md) | G1–G10 readiness-gate compliance matrix, dual atomicity model, feature flags |
| [test-database-isolation.md](./reference/test-database-isolation.md) | Phase 10: isolated Neon test branch — fail-closed guard, `test` vs `test:live` split, closure evidence |

### Specifications (`specs/`)

| Document | Scope |
| :--- | :--- |
| [Plan for an improved synchronization system.md](./specs/Plan%20for%20an%20improved%20synchronization%20system.md) | Original offline-first blueprint: storage engine, background sync, roadmap M1–M8 |
| [AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md](./specs/AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md) | Circuit breaker states, key lifecycle, streaming watchdogs & terminality contract |
| [UI_STREAMING_ARCHITECTURE_REQUIREMENTS.md](./specs/UI_STREAMING_ARCHITECTURE_REQUIREMENTS.md) | Requirements/invariants for ephemeral ghost preview & atomic undo |

### Guides (`guides/`)

| Document | Scope |
| :--- | :--- |
| [STRIPE_SETUP.md](./guides/STRIPE_SETUP.md) | Stripe products, webhooks, env vars, test cards, go-live checklist |
| [STRIPE_INTEGRATION.md](./guides/STRIPE_INTEGRATION.md) | Payment flow, library functions, API routes, troubleshooting |
| [AI_MODELS_CONFIG.md](./guides/AI_MODELS_CONFIG.md) | Decoupled Gemini model/hyperparameter configuration via `models.config.json` |
| [Search_Replace_Feature.md](./guides/Search_Replace_Feature.md) | Editor search/replace behavior, debounce logic, shortcuts |
| [Editor_UI_Enhancements.md](./guides/Editor_UI_Enhancements.md) | UI restructuring, copy/move file ops, dynamic statistics |

### Records (`records/`) — immutable dated history

| Document | Date / State |
| :--- | :--- |
| [test-database-safety.md](./records/test-database-safety.md) | Incident record & cleanup architecture — closed 2026-08-23 |
| [Technical Fix Documentation — Security & Architecture Hardening.md](./records/Technical%20Fix%20Documentation%20%E2%80%94%20Security%20&%20Architecture%20Hardening.md) | W1–W8 hardening record — 2026-08-16 |
| [Production Readiness Roadmap — M0-M5 Execution Record.md](./records/Production%20Readiness%20Roadmap%20%E2%80%94%20M0-M5%20Execution%20Record.md) | M0–M5 milestone record — 2026-08-16 |
| [W10-Final-Closure-Round.md](./records/W10-Final-Closure-Round.md) | Concurrency-window closure F1–F3 — 2026-08-16 |
| [SYNC_UNIT_TESTS_FIXES.md](./records/SYNC_UNIT_TESTS_FIXES.md) | Sync test-fix round — February 2026 |

### Foundation (`foundation/`) — founding pre-implementation design record

> **Immutable historical methodology record** — authored before any code was
> written. Preserved verbatim (Arabic originals retained alongside English
> translations where translated); it documents how the project's pillars were
> established, **not** the current system behavior. For divergences between this
> founding design and the implemented reality, see
> [`foundation/DESIGN_VS_REALITY.md`](./foundation/DESIGN_VS_REALITY.md).

| Document | Scope |
| :--- | :--- |
| [Product Requirements Document (PRD).md](./foundation/Product%20Requirements%20Document%20%28PRD%29.md) | Product requirements: portals, subscriptions, editor tools, localization *(translated to English)* |
| [System Architecture Design.md](./foundation/System%20Architecture%20Design.md) | Original architecture: IAM, data layer, key rotation system, tech stack, risk analysis *(translated to English)* |
| [Project_Structure.md](./foundation/Project_Structure.md) | Planned directory tree and component responsibilities |
| [Implementation_Master_Plan.md](./foundation/Implementation_Master_Plan.md) | Master implementation plan and build order |
| [LUGX platform subscription plans.md](./foundation/LUGX%20platform%20subscription%20plans.md) | Tier definitions, quotas, pricing |
| [UI_UX Guidelines.md](./foundation/UI_UX%20Guidelines.md) | Visual direction, design system, components, constraints *(translated to English)* |
| [Using AI/AI Key Document.md](./foundation/Using%20AI/AI%20Key%20Document.md) | AI model matrix & generation parameters per operation *(translated to English)* |
| [Using AI/correct.md](./foundation/Using%20AI/correct.md) · `improve` · `summarize` · `toPrompt` · `translate` | Original system prompts (source material for `src/lib/ai/prompts.ts`) |

### Root registers

| Document | Scope |
| :--- | :--- |
| [CHANGELOG.md](./CHANGELOG.md) | Notable changes per release (append-only) |
| [TECHNICAL_DEBT_REGISTER.md](./TECHNICAL_DEBT_REGISTER.md) | Known debt, accepted risks, decisions (TD-01 … TD-06) |

---

## 3. Suggested Reading Paths

- **Onboarding:** repo-root `README.md` → this index → [SYNC_ARCHITECTURE.md](./reference/SYNC_ARCHITECTURE.md) → [STRIPE_SETUP.md](./guides/STRIPE_SETUP.md)
- **Sync deep-dive:** `sync-lifecycle-architecture` → `queue-gc-rollback-architecture` → `three-way-conflict-resolution` → [SYNC_API.md](./reference/SYNC_API.md) → `editor-sync-orchestration`
- **AI deep-dive:** `ai-streaming-protocol` → `ai-quota-reservation-lifecycle` → `ai-atomic-commit-architecture` → [AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md](./specs/AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md)
- **Security review:** [security-and-rate-limiting.md](./architecture/security-and-rate-limiting.md) → `file-ownership-and-versioning` → [test-database-safety.md](./records/test-database-safety.md)

---

## 4. Verification Commands

```bash
npx vitest run          # full test suite (integration suites need DATABASE_URL)
npx tsc --noEmit        # type safety gate
npm run build           # production build gate
node scripts/db-testusers-probe.mjs   # test-account hygiene probe
```

When citing results anywhere under `docs/`, follow the Evidence Discipline rules
in [DOCUMENTATION_GUIDELINES.md §4](./DOCUMENTATION_GUIDELINES.md#4-evidence-discipline-mandatory).
