/**
 * Markdown Syntax Integrity Validator
 *
 * Implements strict post-merge structural integrity verification for Markdown documents.
 * Ensures automated 3-way merges (Diff3) have not broken code fence boundaries,
 * mangled GFM tables, injected null bytes, or left unmerged conflict artifacts.
 */

import { SyntaxValidationResult } from './types/vault';
import { normalizeMarkdownSource } from './etag-generator';

export interface SyntaxValidatorOptions {
    /** Whether to strip null bytes and normalize line endings during validation (default: true) */
    sanitize?: boolean;
    /** Whether to forbid git/diff3 conflict markers in the content (default: true) */
    forbidConflictMarkers?: boolean;
}

/**
 * Validates Markdown syntax integrity after an automated diff3 merge.
 * Returns a deterministic SyntaxValidationResult.
 */
export function validateMarkdownSyntaxIntegrity(
    content: string,
    options: SyntaxValidatorOptions = {}
): SyntaxValidationResult {
    const { sanitize = true, forbidConflictMarkers = true } = options;
    const errors: string[] = [];

    // 1. Sanitize control chars and normalize source
    const sanitized = sanitize ? normalizeMarkdownSource(content) : content;

    // Check for null bytes if not sanitized
    if (!sanitize && /\0/.test(content)) {
        errors.push('Document contains forbidden null bytes (\\0)');
    }

    // 2. Check for unresolved conflict markers
    if (forbidConflictMarkers) {
        const conflictMarkerRegex = /^(<{7}[^\r\n]*|={7}|>{7}[^\r\n]*|\|{7}[^\r\n]*)$/m;
        if (conflictMarkerRegex.test(sanitized)) {
            errors.push('Unresolved conflict markers (<<<<<<<, =======, >>>>>>>) detected in document');
        }
    }

    const lines = sanitized.split('\n');

    let inCodeBlock = false;
    let codeFenceChar = '';
    let codeFenceLength = 0;
    let codeBlockStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 3. Fenced Code Block Detection
        const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
        if (fenceMatch) {
            const fence = fenceMatch[2];
            const char = fence[0];
            const length = fence.length;
            const rest = fenceMatch[3].trim();

            if (!inCodeBlock) {
                // Opening fence
                inCodeBlock = true;
                codeFenceChar = char;
                codeFenceLength = length;
                codeBlockStartLine = i + 1;
                continue;
            } else if (char === codeFenceChar && length >= codeFenceLength && rest === '') {
                // Closing fence
                inCodeBlock = false;
                codeFenceChar = '';
                codeFenceLength = 0;
                codeBlockStartLine = 0;
                continue;
            }
        }

        // Skip table checks if currently inside an active code block
        if (inCodeBlock) {
            continue;
        }

        // 4. GFM Table Delimiter Row Detection
        // Example: | :--- | ---: | :---: | or :--- | ---:
        const isTableDelimiter = /^\s*\|?(\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/.test(line) && line.includes('-');

        if (isTableDelimiter) {
            if (i === 0) {
                errors.push(`Malformed GFM table at line ${i + 1}: delimiter row appears at document start without header`);
            } else {
                const prevLine = lines[i - 1].trim();
                if (!prevLine || !prevLine.includes('|')) {
                    errors.push(`Malformed GFM table at line ${i + 1}: orphan delimiter row without preceding table header`);
                } else {
                    const getColumns = (row: string) => {
                        let s = row.trim();
                        if (s.startsWith('|')) s = s.slice(1);
                        if (s.endsWith('|')) s = s.slice(0, -1);
                        return s.split(/(?<=(?:^|[^\\])(?:\\\\)*)\|/).map(c => c.trim());
                    };

                    const headerCols = getColumns(prevLine);
                    const delimiterCols = getColumns(line);

                    if (headerCols.length !== delimiterCols.length) {
                        errors.push(
                            `Malformed GFM table at line ${i + 1}: column count mismatch (header: ${headerCols.length}, delimiter: ${delimiterCols.length})`
                        );
                    }
                }
            }
        }
    }

    // 5. Unclosed Code Block Detection
    if (inCodeBlock) {
        errors.push(
            `Unclosed fenced code block starting at line ${codeBlockStartLine} (${codeFenceChar.repeat(codeFenceLength)}) detected after merge`
        );
    }

    const isValid = errors.length === 0;

    return {
        isValid,
        sanitizedContent: sanitized,
        syntaxErrors: isValid ? undefined : errors,
    };
}
