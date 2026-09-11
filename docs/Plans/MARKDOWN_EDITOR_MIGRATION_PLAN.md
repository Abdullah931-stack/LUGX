# Native Markdown Editor Migration Plan

Status: ✅ CLOSED (100% Implemented & Verified) · Superseded: All legacy `@tiptap/*` packages eliminated

---

## 1. Scope & Execution Governance

This plan established the complete migration of the LUGX editor from TipTap / ProseMirror to a standalone native Markdown editor powered by CodeMirror 6. All phases have been implemented, verified, and closed.

### Canonical Data Contract

```typescript
type MarkdownSource = string; // UTF-8 normalized via Unicode NFC and LF line endings (\n)

interface EditorSnapshot {
    content: MarkdownSource;
    selection: { from: number; to: number };
    generation: number;
    isDirty: boolean;
}
```

The system contract mandates that `normalizeMarkdownSource` runs prior to ETag calculation, local IndexedDB caching, and PostgreSQL persistence. ETags are computed strictly from normalized raw Markdown bytes, completely eliminating cross-platform newline discrepancies (CRLF vs LF) and bogus 412 Precondition Failed conflicts.

---

## 2. Migration Phases Breakdown

### Phase 1: Standalone Markdown Editor Engine — Status: ✅ CLOSED
- **Technical Objective:** Build `MarkdownEditor` operating directly on raw Markdown strings using CodeMirror 6, with live decoration-based preview and bilingual bidirectional text support (RTL/LTR).
- **Implementation:** `src/components/editor/markdown/markdown-editor.tsx`, `bidi-line-plugin.ts`, and `editor-adapter.ts`.
- **Key Architecture:** Token decorations use `Decoration.mark` with CSS masking rather than destructive DOM replacement (`Decoration.replace`), preserving Arabic character joining and preventing cursor jumping.

### Phase 2: TipTap Replacement & Editing Toolchain Binding — Status: ✅ CLOSED
- **Technical Objective:** Rewire page container, search/replace, copy/paste, and toolbar tools to `EditorAdapter` and UTF-16 document offsets.
- **Implementation:** `src/components/editor/search-replace.tsx` executes atomic multi-range replacements via `ChangeSpec[]` transactions, preserving undo history and offset accuracy.
- **Verification:** ProseMirror dependencies and `getHTML()` / `setContent()` calls removed from editor paths.

### Phase 3: Persistence, Internal Storage & Content Normalization — Status: ✅ CLOSED
- **Technical Objective:** Make raw normalized Markdown the sole content format between editor, orchestrator, IndexedDB, and PostgreSQL.
- **Implementation:** `src/lib/sync/etag-generator.ts` (`normalizeMarkdownSource`), `src/server/actions/file-ops.ts`, and `src/server/actions/import-file.ts`.
- **Verification:** HTML sanitizers deleted; PDF text extraction directly emits normalized Markdown paragraphs.

### Phase 4: Sync Protocol, 3-Way Merge & Syntax Integrity Checks — Status: ✅ CLOSED
- **Technical Objective:** Execute push/pull synchronization and optimistic locking on raw Markdown, with structural post-merge syntax integrity guards.
- **Implementation:** `src/lib/sync/sync-manager.ts` and `conflict-resolver.ts`.
- **Key Architecture:** Post-merge syntax check verifies that automated 3-way Diff3 merges do not leave unclosed fenced code blocks or malformed GFM tables; if structural breakage is detected, automated merge is aborted and routed to manual `ConflictDialog`.

### Phase 5: AI Streaming, Dynamic Offset Tracking & Export Pipeline — Status: ✅ CLOSED
- **Technical Objective:** Stream AI token generation over raw Markdown ranges with dynamic offset tracking (`mapPos`) and native export formats.
- **Implementation:** `src/components/editor/markdown/streaming-ghost.ts` manages inline ghost widgets; `src/server/actions/ai-commit.ts` executes atomic range commits; `src/lib/exporters/` exports raw MD and TXT directly from stored buffers.

### Phase 6: TipTap Elimination & Final Verification — Status: ✅ CLOSED
- **Technical Objective:** Complete dead code elimination, remove `@tiptap/*` packages from `package.json`, and pass the full test suite.
- **Verification:** Zero TipTap references in `src/`; 53 test suites and 694 tests passing with 100% green status.

---

## 3. Final Architectural Decisions Matrix

| Decision Area | Adopted Implementation |
| :--- | :--- |
| **Source of Truth** | Raw normalized Markdown (`UTF-8`, `NFC`, `LF`) |
| **Editor Framework** | CodeMirror 6 via `EditorAdapter` with `bidiIsolated` bidirectional support |
| **Live Formatting** | CSS-styled mark decorations preserving Arabic cursive joining |
| **Persistence** | Direct Markdown storage; ETag calculated strictly on normalized Markdown bytes |
| **Synchronization** | Optimistic concurrency (`If-Match`) with post-merge syntax integrity validation |
| **AI Integration** | Dynamic ghost preview tracked via `tr.changes.mapPos()`, atomic single-transaction commit |
| **Export Engine** | Direct memory Blob creation from Markdown source |
| **HTML Role** | Ephemeral derived rendering only; never used as a canonical storage format |
| **Legacy TipTap Packages** | Completely eliminated from codebase and dependency tree |
