#!/usr/bin/env node
/**
 * Deterministic Markdown Internal Link Checker for LUGX.
 *
 * Verifies that all internal links across repository Markdown documentation files
 * resolve to existing files or directories on disk, while strictly isolating CI
 * from external networks (bypassing http/https).
 *
 * Enforces:
 *   1. Zero broken local file/directory links.
 *   2. Zero URL-encoded whitespace/parentheses (%20, %28, %29); standard Markdown
 *      angle bracket paths `<...>` must be used instead.
 *   3. Zero dummy/placeholder link destinations (e.g. `url`).
 *   4. Proper isolation: skips fenced code blocks and inline code spans.
 *
 * Usage:
 *   node scripts/check-markdown-links.mjs
 *   node scripts/check-markdown-links.mjs --verbose
 *   node scripts/check-markdown-links.mjs --file=docs/README.md
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const isVerbose = args.includes("--verbose");
const fileArg = args.find((a) => a.startsWith("--file="));
const singleFile = fileArg ? fileArg.split("=")[1] : null;

/**
 * Discovers markdown files to check.
 * Prioritizes `git ls-files "*.md"`, falling back to recursive directory traversal.
 */
function getMarkdownFiles() {
  if (singleFile) {
    const full = path.resolve(ROOT, singleFile);
    if (!fs.existsSync(full)) {
      console.error(`[check-markdown-links] Error: Specified file not found: ${singleFile}`);
      process.exit(1);
    }
    return [path.relative(ROOT, full).replace(/\\/g, "/")];
  }

  try {
    const output = execSync('git ls-files "*.md"', { cwd: ROOT, encoding: "utf8" });
    const tracked = output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (tracked.length > 0) {
      return tracked;
    }
  } catch {
    // Fallback if git is not available
  }

  const ignoredDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".agents", ".Plans"]);
  const results = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(path.relative(ROOT, path.join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  }

  walk(ROOT);
  return results.sort();
}

/**
 * Regular expression matching Markdown links and images:
 *   [text](dest)
 *   ![alt](dest)
 * Supports angle brackets `<destination with spaces>` and optional titles.
 */
const LINK_REGEX = /!?\[([^\]]*)\]\((<[^>]+>|[^)\s]+(?:\s+(?:"[^"]*"|'[^']*'))?)\)/g;

/**
 * Strips inline code spans from a line, replacing them with whitespace
 * to preserve character indexing while preventing false-positive link matches.
 */
function stripInlineCode(line) {
  return line.replace(/`([^`]+)`/g, (_match, inner) => " ".repeat(inner.length + 2));
}

function runLinkCheck() {
  const files = getMarkdownFiles();
  console.log(`[check-markdown-links] Scanning ${files.length} Markdown files for link validity...`);

  let totalLinks = 0;
  let skippedExternal = 0;
  let skippedAnchor = 0;
  let checkedLocal = 0;
  const violations = [];

  for (const relFile of files) {
    const absFile = path.join(ROOT, relFile);
    if (!fs.existsSync(absFile)) continue;

    const content = fs.readFileSync(absFile, "utf8");
    const lines = content.split(/\r?\n/);
    let inFencedBlock = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const originalLine = lines[lineIndex];
      const trimmed = originalLine.trim();

      // Check fenced code block boundaries
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inFencedBlock = !inFencedBlock;
        continue;
      }
      if (inFencedBlock) continue;

      // Strip inline code spans
      const lineToScan = stripInlineCode(originalLine);

      let match;
      while ((match = LINK_REGEX.exec(lineToScan)) !== null) {
        totalLinks++;
        const linkText = match[1];
        let rawDest = match[2].trim();

        // Unwrap angle brackets if present
        let dest = rawDest;
        if (dest.startsWith("<") && dest.endsWith(">")) {
          dest = dest.slice(1, -1).trim();
        } else {
          // Strip optional title suffix if present
          const titleMatch = dest.match(/^(\S+)\s+(?:"[^"]*"|'[^']*')$/);
          if (titleMatch) {
            dest = titleMatch[1];
          }
        }

        // 1. External URLs: strictly bypass (zero network calls)
        if (/^(https?:\/\/|mailto:|tel:|ftp:\/\/)/i.test(dest)) {
          skippedExternal++;
          continue;
        }

        // 2. Anchor-only links in same file: valid local anchors
        if (dest.startsWith("#")) {
          skippedAnchor++;
          continue;
        }

        checkedLocal++;

        // 3. Reject Windows-style backslashes in markdown paths
        if (dest.includes("\\")) {
          violations.push({
            file: relFile,
            line: lineIndex + 1,
            text: linkText,
            dest,
            reason: "Windows-style backslash ('\\') detected in link destination. Use standard forward slash ('/') instead.",
          });
          continue;
        }

        // 4. Reject URL-encoded characters in markdown paths (%20, %28, %29)
        if (dest.includes("%20") || dest.includes("%28") || dest.includes("%29")) {
          violations.push({
            file: relFile,
            line: lineIndex + 1,
            text: linkText,
            dest,
            reason: "URL-encoded path detected (%20, %28, %29). Use standard Markdown angle bracket path `<...>` instead.",
          });
          continue;
        }

        // 5. Reject dummy placeholder destinations
        if (dest === "url" || dest === "placeholder") {
          violations.push({
            file: relFile,
            line: lineIndex + 1,
            text: linkText,
            dest,
            reason: "Placeholder dummy link target detected ('url'). Must be a real local path or valid URL.",
          });
          continue;
        }

        // 6. Separate target path from hash anchor and query parameters
        const [cleanPathWithQuery] = dest.split("#");
        const [targetPath] = cleanPathWithQuery.split("?");
        if (!targetPath) {
          // If anchor or query only
          continue;
        }

        // 7. Resolve local file/directory path
        let resolvedTarget;
        if (targetPath.startsWith("/")) {
          resolvedTarget = path.join(ROOT, targetPath);
        } else {
          resolvedTarget = path.resolve(path.dirname(absFile), targetPath);
        }

        // 8. Prevent path traversal outside repository root
        const relToRoot = path.relative(ROOT, resolvedTarget);
        if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
          violations.push({
            file: relFile,
            line: lineIndex + 1,
            text: linkText,
            dest,
            reason: `Path traversal detected: destination escapes repository root (${relToRoot.replace(/\\/g, "/")}).`,
          });
          continue;
        }

        if (!fs.existsSync(resolvedTarget)) {
          violations.push({
            file: relFile,
            line: lineIndex + 1,
            text: linkText,
            dest,
            resolvedTarget: path.relative(ROOT, resolvedTarget).replace(/\\/g, "/"),
            reason: `Target path does not exist on filesystem: ${path.relative(ROOT, resolvedTarget).replace(/\\/g, "/")}`,
          });
        } else if (isVerbose) {
          console.log(`  [OK] ${relFile}:${lineIndex + 1} -> ${dest}`);
        }
      }
    }
  }

  console.log(`\n=== Markdown Link Verification Summary ===`);
  console.log(`Total files scanned:       ${files.length}`);
  console.log(`Total links analyzed:      ${totalLinks}`);
  console.log(`External links (bypassed): ${skippedExternal}`);
  console.log(`Anchor links (same-file):  ${skippedAnchor}`);
  console.log(`Local paths verified:      ${checkedLocal}`);
  console.log(`Broken / Invalid links:    ${violations.length}`);

  if (violations.length > 0) {
    console.error(`\n❌ FAILED: Found ${violations.length} invalid or broken Markdown link(s):\n`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}`);
      console.error(`    Text:        [${v.text}]`);
      console.error(`    Destination: (${v.dest})`);
      console.error(`    Reason:      ${v.reason}\n`);
    }
    process.exit(1);
  }

  console.log(`\n✅ SUCCESS: 100% of internal Markdown links are valid and resolvable on disk.\n`);
  process.exit(0);
}

runLinkCheck();
