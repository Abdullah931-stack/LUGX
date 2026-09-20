# Editor Features & Enhancements Summary

**Date:** 2026-01-28  
**Version:** 1.0  
**Focus:** UI Restructuring, File Management (Copy/Move), dynamic Statistics.

---

## 1. UI Restructuring
**Goal:** Simplify interface and consolidate status information.
- **Top Bar Removed:** Deleted the redundant header (title input, delete button).
- **Status Bar:** Moved file title, save stats, and indicators to the bottom bar.
- **Visuals:** Added dynamic save status (Spinner/Green Dot/Red Dot).

## 2. File Operations (Copy & Move)
**Goal:** Enable full file management capabilities.
- **Deep Copy:** Implemented `copyFile` server action (recursive copy for folders and children).
- **UI:** Added `FolderPickerModal` for destination selection.
- **Context Menu:** Enabled Copy/Move actions in `FileContextMenu`.

## 3. Sidebar Instant Refresh
**Goal:** Real-time updates without page reload.
- **Solution:** Implemented a callback chain (`Sidebar` → `FileTreeItem` → `FileContextMenu`).
- **Mechanism:** Passed `loadFiles` function down as `onRefresh` prop to trigger immediate sidebar re-fetch after operations.

## 4. Dynamic Statistics
**Goal:** Real-time metrics for full text and user selection.
- **Character Count:** Fast utility to compute characters (Unicode and RTL-safe).
- **Selection Tracking:** Editor listens to `EditorAdapter` selection changes (`onSelectionChange` / `adapter.getSelection()`).
- **Dynamic Display:** Stats bar toggles between:
  - **Default:** Total Words | Total Chars
  - **On Selection:** "Selected: [count] words | [count] chars" (highlighted)

## 5. Text Direction Management & Bidi Settings
**Goal:** Seamless bidirectional (Arabic/English) editing, viewport virtualization resilience, and explicit user direction controls.
- **Three Direction Modes:**
  1. **`auto` (Default):** Smart automatic line-by-line direction evaluation based on character analysis with stable in-memory document root direction (`bidiLinePlugin`).
  2. **`rtl` (Right-to-Left):** Globally forces right-to-left layout and alignment across document lines.
  3. **`ltr` (Left-to-Right):** Globally forces left-to-right layout and alignment across document lines.
- **Fenced Code Blocks LTR Locking:**
  - `lockCodeBlocksLTR` option in `DirectionSettings`: Keeps code block lines (`FencedCode`) locked to `LTR` and left-aligned even when the document is in `RTL` mode.
  - Dynamically togglable via the UI without reloading or state loss.
- **Direction Settings Dropdown Menu (`DirectionMenu`):**
  - Sleek Radix UI dropdown in the editor toolbar (`AIToolbar`) with visual badges, mode indicators, and a toggle switch for code block LTR locking.
  - Persists preference across sessions via `localStorage` (`lugx_editor_direction_pref`).
- **Global Keyboard Shortcut (`Ctrl + Alt + D` / `Cmd + Alt + D`):**
  - Window-level key listener with `e.repeat` throttling allowing instant circular mode switching (`auto` ➔ `rtl` ➔ `ltr` ➔ `auto`).
- **Unified Typography & Weight Consistency:**
  - Integrated font stack combining `IBM Plex Sans Arabic` and `Geist Sans` (`var(--font-ibm-plex-arabic), var(--font-geist-sans)`).
  - Explicit `fontWeight: "400"`, `fontSynthesis: "none"`, and `unicodeBidi: "isolate"` ensuring identical, crisp stroke weights across all direction modes with zero weight jumping.

## Key Files
- `src/components/editor/direction-menu.tsx`: Direction settings dropdown component.
- `src/components/editor/ai-toolbar.tsx`: Toolbar integration with `DirectionMenu`.
- `src/components/editor/markdown/markdown-extensions.ts`: Line-level `bidiLinePlugin`, direction compartments, and keymaps.
- `src/components/editor/markdown/markdown-theme.ts`: Unified font stack, bidi isolation classes, and dark theme tokens.
- `src/components/editor/markdown/types.ts`: `TextDirectionMode`, `DirectionSettings`, and `EditorAdapter` direction methods.
- `src/components/editor/markdown/editor-adapter.ts`: CodeMirror 6 adapter direction management implementation.
- `src/server/actions/file-ops.ts`: Core logic for `copyFile` (Deep Copy).
- `src/components/files/folder-picker-modal.tsx`: New folder selection UI.
- `src/app/workspace/editor/[fileId]/page.tsx`: Editor UI integration, global shortcuts, and stats logic.
- `src/components/layout/sidebar.tsx`: Refresh logic implementation.
