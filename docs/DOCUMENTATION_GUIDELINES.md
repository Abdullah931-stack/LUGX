# Documentation Guidelines & Governance

This is the binding policy for creating, updating, and retiring documentation
under `docs/`. Operational enforcement directives additionally live in the local
agent rules (`.agents/rules/docs-governance.md`) and take precedence during
execution sessions.

---

## 1. Single Source of Truth Rule

**The source code and its tests are the sole authority.** When any document
contradicts the code, the document is wrong by definition and must be corrected
— never the reverse. Every factual claim in a living document must be traceable
to a source file, route, migration, or test.

---

## 2. Directory Layout

| Folder | Content | Lifecycle |
| :--- | :--- | :--- |
| `docs/` (root) | `README.md` (master index), `DOCUMENTATION_GUIDELINES.md`, `CHANGELOG.md`, `TECHNICAL_DEBT_REGISTER.md` | Living |
| `architecture/` | Subsystem designs, protocols, state machines, invariants | Living — must track code |
| `reference/` | API references and implementation-level specifications | Living — must track code |
| `specs/` | Design blueprints and requirement specifications | Semi-living — updated when the design changes |
| `guides/` | How-to guides and feature walkthroughs | Living |
| `records/` | Dated engineering records, incident reports, execution logs | **Immutable history** — never rewrite content; only prepend status banners |
| `foundation/` | Founding pre-implementation design record (original architecture, PRD, UI/UX guidelines, AI model specs, system prompts) | **Immutable history** — preserved verbatim as historical methodology; never updated to reflect current behavior (see its `DESIGN_VS_REALITY.md` for divergences) |

---

## 3. Decision Policy: Create vs. Update vs. Merge

### Creating a NEW documentation file is FORBIDDEN unless ALL of the following hold:
1. A **major change** occurred in a software module.
2. That change is **not directly related to any existing documentation file**
   in the current sections.
In every other case, the relevant existing file MUST be edited exclusively —
no new files.

### Creating a NEW folder or main section is FORBIDDEN unless BOTH hold:
1. An entirely new infrastructure or technical system is being established
   whose tasks do not fall under any existing folder.
2. **Explicit prior approval from the user** has been obtained before the
   folder or section is adopted.

### Structure synchronization (mandatory):
- The approved design standards and the exact current organizational structure
  are documented in [`README.md`](./README.md).
- Whenever any folder is renamed or a new section is created, `README.md`
  MUST be updated **immediately** to reflect the latest structure.
- After any code change, all affected files MUST be traced and inspected to
  update any numbers, references, or technical documentation impacted by the
  change — fully synchronized within the same change.

### MERGE / RETIRE when:
1. Two files cover >60% overlapping scope — merge into the stronger one and
   leave a redirect note in `records/` if the merged content had historical value.
2. A documented component was deleted from the codebase: move the file to
   `records/` with a "Superseded/Removed" banner rather than deleting it outright,
   unless it contains no historical value.

---

## 4. Evidence Discipline (Mandatory)

Any published metric must be reproducible:

- Test counts / pass rates require: **date + branch or commit SHA + the exact
  command run** (e.g., `npx vitest run`), and ideally the raw output.
- Performance figures require methodology (dataset size, environment, iterations)
  or must be labeled *"historical observation — unbenchmarked"*.
- Never publish bare totals ("225 tests passing") as current truth; prefer
  "as of `<date>`" phrasing plus a verification command.
- Static counts (`grep`) are approximations; runtime output wins.

Historical documents that cannot be re-verified receive a point-in-time banner:

```markdown
> **Point-in-time record (<date>).** Metrics below reflect the repository state
> at that date; re-run `<command>` for current numbers.
```

---

## 5. Linking Rules

- **Relative links only.** Absolute paths (`file:///`, `/Users/...`, `D:\...`)
  are forbidden inside `docs/`.
- Link between related documents using their post-restructure locations, e.g.
  from this folder: [`SYNC_API`](./reference/SYNC_API.md); from a subfolder
  such as `architecture/` the same target is `../reference/SYNC_API.md`
  (paths inside link parentheses must start with `./` or `../`).
- Prefer linking to symbols/functions over line numbers; line references rot silently.
- References into `src/` use relative paths such as `../../src/lib/sync/sync-manager.ts`.

---

## 6. Document Template (Clean Markdown Standards)

```markdown
# <Title>

<One-paragraph scope statement>

---
## 1. Overview & Objectives
## 2. Architecture / Contract        <!-- tables + mermaid preferred -->
## 3. Implementation Details         <!-- anchored to src/ files -->
## 4. Verification & Test Evidence   <!-- evidence-discipline rules apply -->
## 5. Related Documentation          <!-- relative links -->
```

Conventions: English only; one H1 per file; fenced code blocks with language
tags; tables for matrices; mermaid for flows/state machines; no orphan sections.

---

## 7. Review Cadence

1. **With every code PR:** docs describing touched modules must be updated or
   the PR explains why no update is needed.
2. **With every release:** bump `CHANGELOG.md`; re-check `TECHNICAL_DEBT_REGISTER.md`
   entries; verify all index links in `README.md` resolve.
3. **Quarterly audit:** spot-check `reference/` contracts against routes
   (response shapes, status codes, rate limits) and `architecture/` diagrams
   against implementations.

---

## 8. Prohibitions

- Do not delete documentation sections without demonstrating they no longer map
  to existing code.
- Do not document planned behavior as if implemented — label it *planned* and
  link the tracking item.
- Do not copy test counts between documents; cite the owning record instead.
- Do not modify `records/` content retroactively (banners at the top only).
