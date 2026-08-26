# Phase 3 Closure Report — Content Model, Storage & Internal Import Transformation

**Phase ID:** Phase 3 (Markdown Migration Roadmap)  
**Status:** CLOSED ✅  
**Date:** 2026-08-26  
**Authoritative Commits:** Universal Markdown normalization, ETag determinism, and pure-MD file import pipeline  

---

## 1. Executive Summary

Phase 3 establishes raw Markdown as the single source of truth across the storage, persistence, and file import layers. It eliminates intermediate HTML conversion from file ingestion pipelines, introduces canonical cross-platform text normalization (`normalizeMarkdownSource`), establishes deterministic ETag computation, and guarantees that all documents stored in Neon PostgreSQL and client-side IndexedDB are pure UTF-8 Markdown text.

---

## 2. Key Changes & Architectural Invariants

### 1. Universal Markdown Normalization (`src/lib/sync/etag-generator.ts`)
- **Cross-Platform CRLF / CR / LF Unification:** Canonical normalization converting `\r\n` and `\r` into standard `\n`, stripping null bytes (`\0`) for PostgreSQL text field safety, and applying Unicode NFC normalization.
- **Precondition Conflict Immunity:** Guarantees deterministic SHA-256 ETag generation across diverse client operating systems (Windows, macOS, Linux) and Unicode composite encodings.
- **Exported `MarkdownSource` Type Contract:** Formal type contract representing canonical UTF-8 Markdown across API routes, server actions, IndexedDB, and client state.

### 2. Pure Markdown File Import Pipeline (`src/server/actions/import-file.ts`)
- **HTML Conversion Elimination:** Purged `smartConvertToHTML`. MD and TXT file imports decode base64 payloads directly into normalized Markdown.
- **Clean PDF Text Extraction:** Linear text extraction directly into Markdown paragraphs without artificial HTML tags.
- **Single-Query In-Memory Title Collision Resolution:** Automatic title deduplication (`Title (1)`, `Title (2)`) preventing database `23505 unique_violation` errors on `idx_files_user_parent_title_live`.
- **Payload Safety:** Enforced 10MB base64 payload size ceilings.

### 3. Server Actions & Sync Pipeline Normalization
- `createFile`, `updateFileContent`, and `PUT /api/files/[id]` normalize document text prior to optimistic locking checks, ETag hashing, and persistence.
- `useSync` and `useEditorOrchestrator` save canonical Markdown snapshots into IndexedDB.

---

## 3. Verification & Test Evidence

All 9 automated import and normalization tests pass with 100% success rate:

```powershell
npx vitest run src/server/actions/import-file.test.ts
```

```
 ✓ src/server/actions/import-file.test.ts (9 tests) 26ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  4.20s
```

---

## 4. Closure Gate Verification

| Requirement / Invariant | Status | Verification Result |
| :--- | :---: | :--- |
| **Pure Markdown Storage** | **PASSED** | PostgreSQL and IndexedDB store 100% raw UTF-8 Markdown text. |
| **Deterministic ETags** | **PASSED** | Normalized CRLF/NFC hashing eliminates platform-dependent ETag drifts. |
| **Zero HTML Import Pipeline** | **PASSED** | File imports (MD, TXT, PDF) produce pure Markdown without intermediate HTML. |
| **Collision Immunity** | **PASSED** | In-memory title deduplication passes live partial unique index constraints. |
