# Founding Design vs. Implemented Reality — Divergence Record

> **Purpose:** this folder (`docs/foundation/`) preserves the project's founding
> design record **verbatim** — it documents how the pillars were established
> before any code existed, and is never updated to reflect current behavior.
> This companion file is the single place where divergences between that
> founding design and the implemented system are tracked. Every row below was
> verified against the current source tree (verification pointers inline).

---

## 1. Systems Added After the Founding Design

| System | Implementation | Founding-design status |
| :--- | :--- | :--- |
| Offline-first synchronization engine | `src/lib/sync/*` (IndexedDB manager, SHA-256 ETags, 3-way merge, operations queue with dead-letter, GC, rollback, cross-tab sync, reconciliation) | Absent. The architecture document only proposed periodic polling every 5–10 seconds as a Realtime workaround |
| AI NDJSON streaming + ephemeral ghost preview + explicit Accept/Reject/Retry decision | `src/app/api/ai/stream/route.ts`, `src/lib/ai/stream-*`, `src/lib/extensions/streaming-ghost-extension.ts` | Absent |
| Atomic quota reservations & idempotent settlement/refunds | `ai_reservations` table (`schema.ts`, migration `0005_ai_reservations.sql`), `src/server/actions/ai-ops.ts` | Absent — design only proposed a usage tracker wired to billing |
| Distributed circuit breaker + multi-tier model failover | `src/lib/ai/client.ts`, `src/lib/ai/key-rotation.ts` | Absent — design described simple circular rotation on errors |
| Soft delete (tombstones), Trash/restore surface, 30-day purge cron | `files.deletedAt` schema, `file-ops.ts`, `src/app/api/cron/purge-deleted/route.ts` | Absent |
| Per-user rate limiting (sliding window over Upstash Redis) | `src/lib/rate-limit.ts` | Recommended generically ("multi-level rate limiting"); implemented concretely per user/tier of endpoint |
| Content sanitization (XSS defense in depth) | `src/lib/sanitize.server.ts`, `src/lib/sanitize-client.ts` | Not specified |
| Unified editor write orchestration (autosave gates, local-first reconciliation) | `src/hooks/use-editor-orchestrator.ts` | Absent — design only mentioned auto-save with word count |
| Data export module (MD/TXT strategies) | `src/lib/exporters/*` | Partially anticipated (PRD listed exports); PDF export was **not** implemented — see §2 |
| Editor search & replace with debounced matching | `src/components/editor/search-replace.tsx` | Mentioned as a control tool only; no behavioral spec |

## 2. Design Elements Removed, Replaced, or Excluded

| Founding design | Implemented reality | Verification |
| :--- | :--- | :--- |
| File pipeline via Supabase Storage buckets isolated per user | File content lives in the Neon `files` table; `src/lib/supabase/storage.ts` survives as **dead code** (zero importers) | `git grep "supabase/storage" src/` → no hits |
| Payment channels: PayPal + credit cards + Apple Pay + Google Pay | Stripe Checkout exclusively (`src/lib/stripe/`, `src/app/api/stripe/*`) | `src/lib/stripe/index.ts` |
| Live updates via polling every 5–10 seconds | Superseded by the offline-first sync engine above | `src/lib/sync/sync-manager.ts` |
| Route groups `(auth)` / `(dashboard)` / `(workspace)` | Flat routes: `/login`, `/auth/callback`, `/dashboard`, `/workspace`, `/workspace/editor/[fileId]`, `/account` | `src/app/` tree |
| Components `ai-floating-menu.tsx`, `prompt-dialog.tsx`, `editor-canvas.tsx` | `ai-toolbar.tsx`, `ai-stream-preview.tsx`, `ai-stream-status.tsx`, `search-replace.tsx`; `editor-canvas` was deleted (CHANGELOG v1.5.x) | `src/components/editor/` |
| Models: `gemini-2.0-flash-lite`, `gemini-flash-lite-latest`, `Gemini 2.5 Flash-Lite`, `Gemini-3-flash-preview` | `gemini-3.7-flash` (primary) / `gemini-3.6-flash` (fallback) for all operations in `src/config/models.config.json` | `models.config.json` |
| Env naming `GEMINI_KEY_1`, `GEMINI_KEY_2`, … | `GEMINI_API_KEY` + `GEMINI_API_KEY_FALLBACK_1` / `_FALLBACK_2` | README env matrix |
| Planned file `config/ai-models.config.ts` | `src/config/models.config.json` (decoupled JSON) | `models.config.json` |
| Planned `server/services/subscription.ts` | `src/server/actions/subscription-actions.ts` + `src/lib/stripe/` | `src/server/actions/` |
| Top-level `src/types/` directory | Types are co-located with their modules; no `types/` directory exists | `src/` tree |

## 3. Preserved Continuities (design → code, unchanged)

| Founding decision | Current state | Verification |
| :--- | :--- | :--- |
| System prompt entities LPE / SEE / DCE / DSE / LBE | Implemented verbatim as `CORRECT_PROMPT` (LPE v2.0), `IMPROVE_PROMPT` (SEE v2.0), `SUMMARIZE_PROMPT` (DCE v2.0), `TO_PROMPT_PROMPT` (DSE v3.x), `TRANSLATE_PROMPT` (LBE v3.0) | `src/lib/ai/prompts.ts` |
| Tier quotas & pricing (Free 2,000 words/week; summarize 500 words 1/day; ToPrompt hidden. Pro $12 of $15 −20%: 20,000/day, 5,000×5/day, 10 prompts/day. Ultra $120 of $160 −25%: 250,000/day, 30,000×50/day, 500 prompts/day) | Encoded exactly in `TIER_LIMITS` | `src/config/tiers.config.ts`, `docs/foundation/LUGX platform subscription plans.md` |
| Tech stack: Vercel + Neon + Drizzle + Supabase Auth + Upstash Redis + Gemini | All six pillars present in the running stack | `package.json`, `src/lib/*` |
| Generation parameters per operation (e.g., Correct 0.1/0.75; Improve 0.7/0.95/0.2/0.5) | Carried into `models.config.json` hyperparameters (model identifiers evolved — see §2) | `src/config/models.config.json` |

> ⚠️ **Internal inconsistency inside the founding record itself:** the component table in
> `Project_Structure.md` summarizes quotas as "Free: 1k words, Pro: 20k, Ultra: 2M",
> which contradicts both the authoritative `LUGX platform subscription plans.md` and the
> implemented `tiers.config.ts`. The subscription-plans document is authoritative.

## 4. Reading Guidance

- Treat everything in this folder as a **historical methodology record**.
- For current behavior, always start from [`../README.md`](../README.md) and the living
  documents under `../architecture/` and `../reference/`.
- Never "fix" a founding document to match reality — record the divergence here instead.

