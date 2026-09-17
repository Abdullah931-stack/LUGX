# LUGX Native Markdown Editor Migration Execution Plan

## Execution Scope

Each phase is executed in an independent engineering session. A session is never closed until all phase-specific automated tests pass and all modified files are strictly audited. The subsequent phase does not commence prior to achieving verified `CLOSED` status for the preceding phase.

---

## Final Technical Contract

```typescript
type MarkdownSource = string; // UTF-8 string normalized via Unicode NFC and LF line endings

interface EditorSnapshot {
  content: MarkdownSource;
  selection: { from: number; to: number };
  generation: number;
  isDirty: boolean;
}
```

### Deterministic Contract Invariants
- **Text Normalization:** Canonical normalization is enforced via `normalizeMarkdownSource(content)` (converting `\r\n` to `\n` and standardizing Unicode to NFC form).
- **Trailing Newline Policy:** Consistent single trailing newline preservation across storage and editor boundaries.
- **GFM Task Lists:** Full support for GitHub Flavored Markdown task list syntax (`- [ ]`, `- [x]`).
- **Raw HTML Policy:** Raw HTML embedded within Markdown is escaped or blocked in preview modes according to a uniform security policy; it is never executed inside the DOM.
- **ETag Computation:** Computed strictly from the final normalized and persisted `MarkdownSource` bytes, never derived from intermediate or rendered HTML.

---

## Phase 1: Building Standalone Markdown Editor

### Technical Objective
Construct an isolated `MarkdownEditor` operating directly on raw Markdown text using CodeMirror 6, featuring decoration-only Live Preview and native bidirectional (RTL) Arabic typography support, completely independent of TipTap, network calls, or persistence layers.

### Targeted Files and Components
- `src/components/editor/markdown/markdown-editor.tsx` (Core React wrapper and view management).
- `src/components/editor/markdown/editor-adapter.ts` (Framework-agnostic EditorAdapter contract).
- `src/components/editor/markdown/markdown-extensions.ts` (Bidi, Live Preview, and syntax extensions).
- `src/components/editor/markdown/markdown-theme.ts` (Quiet luxury dark styling and highlight tags).
- `package.json` (CodeMirror 6 language, commands, history, and search packages).

### Direct Implementation Steps
1. Bind CodeMirror's underlying state directly to raw `MarkdownSource`; strictly prohibit any parsing or serialization into HTML inside the component.
2. Implement standard editor contracts: `onChange`, `getValue`, `setValue(content, origin)`, `replaceRange`, `selection`, `focus`, and `undo/redo`.
3. Parse the Markdown syntax tree and generate dynamic decorations to visually fold inactive formatting tokens while revealing them when intersected by cursor or selection.
4. **Visual Inline Token Normalization for RTL:** Apply Live Preview inline decorations (e.g., bold, italic) using custom `Decoration.mark` with specialized CSS classes (`font-size: 0` or `opacity: 0` with `letter-spacing: -1ch`) when the cursor moves away. Strictly avoid destructive `Decoration.replace` widgets to prevent breaking Arabic character shaping/cursive joining and eliminate cursor caret jumping.
5. Enable CodeMirror's `bidiIsolated` extension to prevent line direction inversion when Markdown syntax markers or brackets appear at the start of Arabic RTL lines.
6. Retain Live Preview within the single editor state; never instantiate a secondary editor instance or dual content model.
7. Implement Source Mode purely as a decoration policy toggle, not an independent editor state or parallel storage path.
8. Support headings, nested lists, links, blockquotes, GFM task lists, inline code, and fenced code blocks; render unsupported syntax cleanly as raw text rather than silently dropping tokens.
9. Handle IME composition and selection mapping without mutating raw document text.
10. Ensure preview widgets remain strictly ephemeral; no widget is permitted to write into document source text.

### Exception & Edge Case Handling
- **Active IME Composition:** Suppress decoration recalculations that alter cursor positioning while IME composition is active.
- **Empty Document:** Empty text is valid `MarkdownSource` and must never be converted into placeholder HTML or stored as synthetic tags.
- **Incomplete Markdown Syntax:** Unclosed code fences or incomplete link brackets must remain exactly as authored by the user.
- **Embedded Raw HTML:** Raw HTML is either rendered as escaped text or suppressed according to preview policy; script execution within DOM is strictly blocked.

### Closure Tests
- Invariant tests confirming raw Markdown source preservation.
- Keystroke typing, deletion, paste, undo/redo, and selection range mapping.
- IME composition handling.
- Pure Arabic RTL, pure English LTR, and mixed bilingual text rendering without broken cursive letter connectivity.
- GFM task lists, code fences, live decorations, and Source Mode toggling.
- Component re-renders without state loss or cursor reset.

### Closure Gate
`MarkdownEditor` returns verbatim Markdown, imports zero TipTap dependencies, makes zero network or persistence requests, and decorations never alter the document string or disrupt Arabic letter cursive joining.

---

## Phase 2: Replacing TipTap and Binding Editor Toolbars

### Technical Objective
Migrate the editor page, search-and-replace utilities, toolbar actions, and clipboard operations to interact exclusively via `EditorAdapter` using UTF-16 Markdown offsets.

### Targeted Files
- `src/app/workspace/editor/[fileId]/page.tsx`
- `src/components/editor/search-replace.tsx`
- `src/components/editor/ai-toolbar.tsx`
- `src/components/editor/ai-stream-preview.tsx`
- `src/hooks/use-editor-orchestrator.ts`

### Direct Implementation Steps
1. Replace `useEditor`, `EditorContent`, and TipTap `Editor` instances in the editor page with `MarkdownEditor`.
2. Convert `editor.on("update")` and `getHTML()` callbacks to `onChange(MarkdownSource)`, decoupling editor state updates from synchronous network calls.
3. Migrate search and replace mechanisms from ProseMirror node positions to standard UTF-16 document offsets utilized by CodeMirror.
4. **Safe Multi-Range Transaction:** Implement `replaceAll` by assembling all search match ranges into a single atomic `ChangeSpec[]` transaction with full undo history, preventing offset drift during iteration and preserving undo tree coherence.
5. Standardize clipboard copy policy: Copy raw Markdown by default, with optional plain-text extraction if explicitly requested; never rely on `getText()` as a silent fallback.
6. Refactor toolbar formatters (headings, lists, links, inline code) to wrap or prepend Markdown syntax around the current selection while maintaining active selection boundaries.
7. Derive word and character statistics directly from the raw Markdown string without HTML DOM parsing.
8. Adapt `useEditorOrchestrator` to accept `EditorAdapter` in place of TipTap `Editor`, preserving hydration, dirty tracking, generation counters, and write-state guards.

### Exception & Edge Case Handling
- **Empty Selection Toolbar Commands:** When toolbar actions are triggered with an empty selection, insert syntax markers and place the cursor at the exact insertion midpoint.
- **Replace All Structural Integrity:** Replace operations must execute across range boundaries in a single atomic transaction rather than re-synthesizing the entire document from plain text.
- **Re-render Stability:** Component re-renders and updated callbacks must not re-instantiate the CodeMirror editor state.
- **TipTap Isolation:** TipTap remains installed only as a fallback until all legacy call sites across all components are fully migrated.

### Closure Tests
- Page loading, typing, selection updates, search/replace, and clipboard operations.
- Toolbar actions, undo/redo stacks, and RTL/LTR direction toggles.
- Editor re-renders during loading, error, conflict dialog, and AI preview states without importing TipTap modules.

### Closure Gate
The editor page operates fully on `MarkdownEditor`, all visible editing tools use UTF-16 Markdown offsets, and zero references to `getHTML()`, `setContent()`, or ProseMirror commands remain in the page lifecycle.

---

## Phase 3: Content Model Conversion, Persistence & Internal Import

### Technical Objective
Establish `MarkdownSource` as the sole canonical data representation across the editor, orchestrator, IndexedDB, Server Actions, and PostgreSQL, enforcing consistent normalization to eliminate synthetic 412 conflicts.

### Targeted Files
- `src/lib/db/schema.ts` and migration files.
- `src/lib/sync/idb-types.ts` and `src/lib/sync/indexeddb.ts`.
- `src/hooks/use-sync.ts`.
- `src/hooks/use-editor-orchestrator.ts`.
- `src/server/actions/file-ops.ts`.
- `src/app/api/files/[id]/route.ts`.
- `src/server/actions/import-file.ts`.

### Direct Implementation Steps
1. Define `content` explicitly as `MarkdownSource` across TypeScript types, API payloads, and test fixtures (retaining PostgreSQL `text` column type).
2. **Content Normalization & ETag Determinism:** Apply `normalizeMarkdownSource` (converting `\r\n` to `\n` and enforcing Unicode NFC) prior to ETag calculation and storage in IndexedDB and PostgreSQL, eliminating phantom 412 conflicts across Windows, macOS, and Linux.
3. Ingest `.md` and `.txt` imports directly as raw Markdown without invoking `smartConvertToHTML`.
4. Extract PDF documents 100% on the client via Web Worker, converting text and tabular structures into canonical Markdown via 2D spatial clustering (`pdf-table-extractor.ts`) and Arabic Unicode normalization (`arabic-normalizer.ts`), eliminating intermediate HTML and server-side binary parsing.
5. Update `IDBFile`, base snapshots, queue items, and fixtures to designate content strictly as Markdown.
6. Compute ETags deterministically from normalized Markdown bytes; update version, ETag, base snapshot, and `isDirty` atomically.
7. Prohibit HTML sanitizers from running against stored Markdown; sanitization is restricted to ephemeral preview renderings.
8. Retain immediate local persistence to IndexedDB paired with debounced server synchronization; `onChange` must never block user typing.

### Exception & Edge Case Handling
- **Empty File or Textless PDF:** Process according to import contract without producing empty HTML wrapper tags.
- **Cross-Platform Line Endings:** Never re-normalize line endings after ETag computation unless governed by a versioned migration policy.

### Closure Tests
- IndexedDB save/load, page reload, offline editing, and server round-trips.
- ETag byte-for-byte consistency across differing operating systems.
- Import pipelines for `.md`, `.txt`, and `.pdf` files confirming complete absence of HTML tags in storage.
- Network interruption resilience with local state persistence.

### Closure Gate
All ingestion and internal persistence pipelines pass NFC/LF-normalized Markdown, ETags remain stable cross-platform, and no HTML transformations exist within the storage lifecycle.

---

## Phase 4: Sync, Conflict & Structural Integrity

### Technical Objective
Operate push/pull synchronization, optimistic locking, and conflict resolution directly on Markdown while preserving versioning, ETags, `If-Match` headers, dirty states, retry queues, and 412 precondition handling, safeguarding documents against syntax fragmentation.

### Targeted Files
- `src/lib/sync/sync-manager.ts`
- `src/lib/sync/reconciliation.ts`
- `src/lib/sync/conflict-resolver.ts`
- `src/hooks/use-sync.ts`
- `src/hooks/use-editor-orchestrator.ts`
- `src/app/api/files/sync/route.ts`
- `src/app/api/files/[id]/route.ts`
- `src/components/sync/conflict-dialog.tsx`

### Direct Implementation Steps
1. Transmit raw Markdown across push/pull network payloads and snapshots without intermediate HTML conversions.
2. Maintain the established synchronization decision matrix:
   - `local clean + server newer`: Fast-forward apply server state.
   - `local dirty + server changed`: Preserve local modifications and transition to reconciliation/conflict.
3. Introduce a `remote-update` event dispatched from `SyncManager` to `useEditorOrchestrator` ensuring verified pull updates reach the active editor instance, not just IndexedDB.
4. Apply remote content to the editor view via `setValue(content, "remote")` strictly when no newer uncommitted local edits exist.
5. Enforce generation counters, dirty flags, and pending operation guards to prevent stale pull responses from overwriting newer local edits.
6. Structure conflict objects to hold separate `localMarkdown`, `serverMarkdown`, and true `baseMarkdown` snapshots.
7. **Syntax Integrity Check Post-Merge:** Perform automated structural syntax validation following 3-way `diff3` merges on Markdown. If the merge produces unclosed code fences or broken GFM table syntax, abort automated resolution and route the document to `ConflictDialog` for manual resolution.
8. Exclude complex DAG/lineage models; maintain deterministic linear versioning unless business rules demand branch merges.

### Exception & Edge Case Handling
- **Incoming Remote Snapshot During IME or Active Transaction:** Defer application until the local editor transaction stabilizes.
- **Document Becomes Dirty Post-Pull Initiation:** Reject incoming pull application and retain the operation in the reconciliation queue.
- **HTTP 412 Precondition Failed:** Disallow unconditional overwrite; emit conflict state populated with server, base, and local copies.
- **Remote Tombstone with Local Dirty Edits:** Retain local edits; do not delete local state on server tombstone.
- **Cross-Tab Storage Events:** External tab updates must not override the active tab's dirty editing state.

### Closure Tests
- Clean fast-forward sync, dirty conflict detection, 412 responses, and identical content no-op sync.
- Offline reconnection, background pull during continuous typing, and stale generation guard enforcement.
- Cross-tab synchronization, queue retries, and rollback operations.
- 3-way merge validation covering table columns, lists, and unclosed code block detection.

### Closure Gate
Synchronization operates on raw Markdown, typing latency is unaffected during background network cycles, remote updates apply reliably without clobbering, and merges abort safely upon syntax corruption.

---

## Phase 5: AI Streaming, Dynamic Ghost Offset Mapping & Export

### Technical Objective
Enable AI streaming over Markdown document ranges with ephemeral inline preview and dynamic offset tracking, committing results via server-side atomic transactions; ensure Markdown export outputs verbatim source bytes.

### Targeted Files
- `src/hooks/use-ai-stream.ts`
- `src/lib/ai/stream-session.ts`
- `src/lib/ai/stream-handler.ts`
- `src/app/api/ai/stream/route.ts`
- `src/lib/ai-transaction.ts` and `src/server/actions/ai-commit.ts`
- `src/components/editor/markdown/streaming-ghost.ts`
- `src/lib/parsers/stream-markdown.ts`
- `src/lib/exporters/index.ts`
- `src/lib/exporters/strategies/markdown-exporter.ts`
- `src/lib/exporters/strategies/text-exporter.ts`

### Direct Implementation Steps
1. Re-architect session states from HTML-based tracking to `originalMarkdown` and `resultMarkdown`.
2. Extract input text and selection ranges from `EditorAdapter` as Markdown UTF-16 offsets; eliminate all ProseMirror position conversions.
3. Retain existing NDJSON transport framing, quota reservations, abort mechanisms, operation IDs, expected versions, and ETags.
4. **Dynamic Ghost Preview Range Mapping:** Store the ghost preview range within a CodeMirror `StateField` and dynamically map its boundary offsets across concurrent user keystrokes using `tr.changes.mapPos(pos)`. This guarantees that user acceptance commits text at the exact updated coordinates, eliminating `RangeError: Position out of bounds`.
5. Strictly isolate `previewText` from `documentValue`; ghost preview text never enters document history or storage prior to explicit user acceptance.
6. Replace HTML stream formatting with strict Markdown output validation; generated text is validated as raw Markdown.
7. Upon Accept, execute a server-side atomic commit on Markdown followed by a single local transaction replacing the targeted range under generation and version guards.
8. Ensure Reject, Cancel, or Retry operations leave the document unmutated, cleaning up ghost widgets, quota reservations, and pending states.
9. Refactor `MarkdownExporter` to construct file downloads directly from stored Markdown bytes without stripping or intermediate parsing.
10. Update import and export contracts and test fixtures to establish Markdown as the canonical format.

### Exception & Edge Case Handling
- **Concurrent Stream Requests:** Reject overlapping generation requests via active session mutex.
- **Duplicate Done or Post-Termination Chunks:** Ignore duplicate terminal events or out-of-order chunks received after stream closure.
- **Stream Failures (JSON Corruption, Provider Errors, Disconnects, Aborts):** Transition session to terminal error state, clear ghost preview, and execute single quota refund.
- **Concurrent User Edits Altering Document Version During Stream:** Disallow blind commit if version increments; prompt user with retry option rather than overwriting manual text.
- **Malformed Markdown Output:** Validate syntax before atomic commit; reject corrupted AI outputs.
- **Export Integrity:** Prohibit HTML-to-plaintext conversion or Markdown token stripping in Markdown export routes.

### Closure Tests
- NDJSON stream chunk parsing, delta reconstitution, and first-chunk ghost rendering.
- Ghost preview offset tracking (`mapPos`) during concurrent typing.
- User action flows: Accept, Reject, Retry, and Cancel.
- Abort handling, unmount cleanup, version conflict rejection, and quota settlement.
- Markdown export byte-matching and TXT export conversion fidelity.

### Closure Gate
AI inline preview is visually stable, dynamically adjusts coordinates during user typing, commits atomically to the exact range on acceptance, and exported `.md` files match the stored document byte-for-byte.

---

## Phase 6: TipTap Elimination & Final Verification

### Technical Objective
Permanently remove legacy TipTap modules, types, and dependencies only after establishing empirical proof that Markdown is the sole canonical format and all integrations function without regression.

### Direct Implementation Steps
1. Perform exhaustive static codebase search for residual references to `@tiptap`, `useEditor`, `EditorContent`, `getHTML`, `setContent`, `insertContent`, `StarterKit`, `Placeholder`, and `StreamingGhostExtension`.
2. Delete orphaned helpers and remove TipTap dependencies from `package.json` and lockfiles.
3. Remove legacy HTML conversion scripts (`text-to-html.server.ts`) from content generation pathways.
4. Update seeds, test fixtures, and documentation to reflect native Markdown architecture.
5. Execute full verification suite: strict TypeScript type checking (`tsc --noEmit`), linting (`npm run lint`), test suite execution (`npm test`), and production build (`npm run build`).
6. Validate browser automation workflows covering file opening, rapid typing, background synchronization, offline/reconnect, conflict resolution, AI streaming ghost preview, and file import/export.

### Final Verification Gates
- Markdown is the sole data format in the editor, IndexedDB, server database, AI pipeline, and export modules.
- Zero TipTap imports or HTML canonical paths remain in the repository.
- Zero typing loss during background sync, streaming preview, or page refresh.
- 100% test pass rate across sync, conflict, AI, export, and bilingual Arabic typography suites.
- Zero unused imports or dead dependencies.

---

## Architectural Decisions Reference Table

| Architectural Domain | Approved Standard |
| :--- | :--- |
| **Source of Truth** | Verbatim UTF-8 `MarkdownSource` (NFC + LF normalized) |
| **Editor Runtime** | CodeMirror 6 via `EditorAdapter` with `bidiIsolated` extension |
| **Live Preview** | Ephemeral `Decoration.mark` styling without destructive token removal |
| **Persistence** | Direct Markdown storage; ETag calculated from normalized Markdown bytes |
| **Synchronization** | Optimistic concurrency with post-merge syntax integrity validation |
| **AI Integration** | Markdown streaming with dynamic `mapPos` range tracking and atomic commits |
| **Export Strategy** | Direct binary Blob generation from raw Markdown source |
| **HTML Role** | Rendered strictly as an ephemeral preview derivative; never stored |
| **TipTap Status** | Completely decommissioned and purged from dependencies |

---

## Critical Files Bound by Markdown Contract
- `src/app/workspace/editor/[fileId]/page.tsx`
- `src/hooks/use-editor-orchestrator.ts`
- `src/hooks/use-ai-stream.ts`
- `src/server/actions/import-file.ts`
- `src/lib/exporters/index.ts`
- `src/lib/exporters/strategies/markdown-exporter.ts`
- `src/components/editor/search-replace.tsx`
- `src/lib/sync/sync-manager.ts`
- `src/lib/sync/reconciliation.ts`
- `src/lib/ai/stream-handler.ts`
- `src/server/actions/ai-commit.ts`
