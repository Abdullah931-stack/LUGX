/**
 * Dedicated Sub-Line Word/Token 3-Way Merge & Deletion Guard Unit Tests
 * 
 * Comprehensive edge case coverage for:
 * 1. Tokenization Edge Cases (Unicode Arabic, mixed emojis/symbols, whitespace variants, pure punctuation)
 * 2. Sub-Line Disjoint Merge Scenarios (disjoint words, Arabic text, insertions/appends, diff3MergeText integration)
 * 3. Sub-Line Overlapping Conflict Scenarios (same word modification, delete vs edit, simultaneous insert)
 * 4. Markdown Syntax Integrity Guard (Fail-Closed AST Protection for unclosed backticks, bold delimiters, code fences)
 * 5. Deletion Guard Edge Cases (prevent resurrection, remote modify vs local delete conflict, multi-line deletions)
 * 6. Visual Diff & WordSpan Precision (computeWordSpans micro-LCS tokens, computeVisualDiff modify op pairing)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tokenizeLine, trySubLineMerge, diff3MergeText, diff3Merge } from '@/lib/sync/diff3';
import { ConflictResolver } from '@/lib/sync/conflict-resolver';
import { validateMarkdownSyntaxIntegrity } from '@/lib/sync/syntax-validator';

describe('Sub-Line 3-Way Merge & Intra-Line Word Diff Test Suite', () => {
    let resolver: ConflictResolver;

    beforeEach(() => {
        resolver = new ConflictResolver();
    });

    // =========================================================================
    // 1. Tokenization Edge Cases (tokenizeLine)
    // =========================================================================
    describe('1. Tokenization Edge Cases (tokenizeLine)', () => {
        it('should tokenize Unicode Arabic text into words, spaces, and Arabic punctuation', () => {
            const arabicLine = 'مرحبا بكم، هل أنتم بخير؟';
            const tokens = tokenizeLine(arabicLine);

            expect(tokens).toEqual([
                'مرحبا', ' ', 'بكم', '،', ' ',
                'هل', ' ', 'أنتم', ' ', 'بخير', '؟',
            ]);
            // Reassembling tokens perfectly reconstructs the original string
            expect(tokens.join('')).toBe(arabicLine);
        });

        it('should tokenize mixed English, Arabic, numbers, symbols, and emojis with surrogate pairs', () => {
            const mixedLine = 'LUGX 2026: مرحبا 🎉 #sync @user $100 -> ok!';
            const tokens = tokenizeLine(mixedLine);

            expect(tokens).toContain('LUGX');
            expect(tokens).toContain('2026');
            expect(tokens).toContain('مرحبا');
            expect(tokens).toContain('🎉');
            expect(tokens).toContain('#');
            expect(tokens).toContain('@');
            expect(tokens).toContain('$');
            expect(tokens).toContain('100');
            expect(tokens).toContain('->');
            expect(tokens).toContain('ok');
            expect(tokens.join('')).toBe(mixedLine);
        });

        it('should preserve multiple whitespace variants (consecutive spaces, tabs, mixed)', () => {
            const whitespaceLine = 'alpha   \t  beta\t\tgamma    delta';
            const tokens = tokenizeLine(whitespaceLine);

            expect(tokens).toEqual([
                'alpha',
                '   \t  ',
                'beta',
                '\t\t',
                'gamma',
                '    ',
                'delta',
            ]);
            expect(tokens.join('')).toBe(whitespaceLine);
        });

        it('should tokenize pure punctuation or symbols without alphanumeric words', () => {
            const asterisks = '***';
            expect(tokenizeLine(asterisks)).toEqual(['***']);

            const dashes = '---';
            expect(tokenizeLine(dashes)).toEqual(['---']);

            const equals = '===';
            expect(tokenizeLine(equals)).toEqual(['===']);

            const mixedSymbols = '<!-- --> !== === && ||';
            const tokens = tokenizeLine(mixedSymbols);
            expect(tokens.join('')).toBe(mixedSymbols);
            expect(tokens).toContain('<!--');
            expect(tokens).toContain('!==');
        });

        it('should handle edge cases: empty string, pure whitespace, and single character', () => {
            expect(tokenizeLine('')).toEqual(['']);
            expect(tokenizeLine('   ')).toEqual(['   ']);
            expect(tokenizeLine('\t')).toEqual(['\t']);
            expect(tokenizeLine('a')).toEqual(['a']);
            expect(tokenizeLine('9')).toEqual(['9']);
            expect(tokenizeLine('.')).toEqual(['.']);
        });

        it('should handle Arabic diacritics / tashkeel without corrupting token alignment', () => {
            const diacriticsLine = 'كَتَبَ التِّلْمِيذُ الدَّرْسَ';
            const tokens = tokenizeLine(diacriticsLine);
            expect(tokens.join('')).toBe(diacriticsLine);
            expect(tokens.length).toBeGreaterThan(3);
        });

        it('should tokenize Eastern Arabic numerals (١٢٣) alongside Western Arabic numbers (123)', () => {
            const numLine = 'العدد ١٢٣ يقابل 123 في النظام العشري';
            const tokens = tokenizeLine(numLine);
            expect(tokens).toContain('١٢٣');
            expect(tokens).toContain('123');
            expect(tokens.join('')).toBe(numLine);
        });
    });

    // =========================================================================
    // 2. Sub-Line Disjoint Merge Scenarios
    // =========================================================================
    describe('2. Sub-Line Disjoint Merge Scenarios', () => {
        it('should cleanly merge when Local edits word at index 0 and Remote edits word at index 5', () => {
            const base = 'Alpha beta gamma delta epsilon zeta';
            const local = 'First beta gamma delta epsilon zeta'; // Word 0 changed
            const remote = 'Alpha beta gamma delta epsilon last'; // Word 5 changed

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(true);
            expect(subResult.line).toBe('First beta gamma delta epsilon last');
        });

        it('should cleanly merge when Local inserts word between words 1 and 2, and Remote appends at end', () => {
            const base = 'word1 word2 word3 word4';
            const local = 'word1 inserted word2 word3 word4';
            const remote = 'word1 word2 word3 word4 appended';

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(true);
            expect(subResult.line).toBe('word1 inserted word2 word3 word4 appended');
        });

        it('should cleanly merge Arabic sentence with disjoint word replacements', () => {
            const base = 'هذا النص مكتوب باللغة العربية الجميلة';
            const local = 'هذا المقال مكتوب باللغة العربية الجميلة'; // "النص" -> "المقال"
            const remote = 'هذا النص مكتوب باللغة العربية الحديثة'; // "الجميلة" -> "الحديثة"

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(true);
            expect(subResult.line).toBe('هذا المقال مكتوب باللغة العربية الحديثة');
        });

        it('should cleanly merge code syntax when Local modifies declaration and Remote modifies value', () => {
            const base = 'const counter = 0; // initial count';
            const local = 'let counter = 0; // initial count';
            const remote = 'const counter = 100; // initial count';

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(true);
            expect(subResult.line).toBe('let counter = 100; // initial count');
        });

        it('should resolve false conflicts when both Local and Remote perform identical modifications', () => {
            const base = 'The quick brown fox';
            const local = 'The fast brown fox';
            const remote = 'The fast brown fox';

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(true);
            expect(subResult.line).toBe('The fast brown fox');
        });

        it('should integrate cleanly in diff3MergeText on full documents with disjoint line edits', () => {
            const baseDoc = [
                '# Project Overview',
                'Status is pending in staging environment.',
                'Contact: admin@example.com for assistance.',
            ].join('\n');

            const localDoc = [
                '# Project Overview',
                'Status is active in staging environment.', // Local: pending -> active
                'Contact: admin@example.com for assistance.',
            ].join('\n');

            const remoteDoc = [
                '# Project Overview',
                'Status is pending in production environment.', // Remote: staging -> production
                'Contact: admin@example.com for assistance.',
            ].join('\n');

            const result = diff3MergeText(localDoc, baseDoc, remoteDoc, { subLineMerge: true });
            expect(result.success).toBe(true);
            expect(result.hasConflicts).toBe(false);
            expect(result.content).toBe([
                '# Project Overview',
                'Status is active in production environment.',
                'Contact: admin@example.com for assistance.',
            ].join('\n'));
        });

        it('should respect subLineMerge: false option by disabling intra-line merge and falling back to line conflict', () => {
            const base = 'Status is pending in staging';
            const local = 'Status is active in staging';
            const remote = 'Status is pending in production';

            const disabledResult = diff3MergeText(local, base, remote, { subLineMerge: false });
            expect(disabledResult.hasConflicts).toBe(true);
            expect(disabledResult.success).toBe(false);
            expect(disabledResult.content).toContain('<<<<<<< LOCAL');
            expect(disabledResult.content).toContain('Status is active in staging');
            expect(disabledResult.content).toContain('=======');
            expect(disabledResult.content).toContain('Status is pending in production');
            expect(disabledResult.content).toContain('>>>>>>> REMOTE');
        });

        it('should execute diff3Merge on line arrays directly with subLineMerge: true', () => {
            const a = ['Alpha beta'];
            const o = ['Alpha gamma'];
            const b = ['Delta gamma'];

            const blocks = diff3Merge(a, o, b, { subLineMerge: true });
            expect(blocks).toHaveLength(1);
            expect(blocks[0].ok).toEqual(['Delta beta']);
        });
    });

    // =========================================================================
    // 3. Sub-Line Overlapping Conflict Scenarios
    // =========================================================================
    describe('3. Sub-Line Overlapping Conflict Scenarios', () => {
        it('should declare conflict when both Local and Remote modify the exact same word', () => {
            const base = 'The quick brown fox';
            const local = 'The agile brown fox'; // "quick" -> "agile"
            const remote = 'The swift brown fox'; // "quick" -> "swift"

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);

            const result = diff3MergeText(local, base, remote);
            expect(result.hasConflicts).toBe(true);
            expect(result.success).toBe(false);
            expect(result.content).toContain('<<<<<<< LOCAL');
            expect(result.content).toContain('The agile brown fox');
            expect(result.content).toContain('=======');
            expect(result.content).toContain('The swift brown fox');
            expect(result.content).toContain('>>>>>>> REMOTE');
        });

        it('should declare conflict when Local deletes a word that Remote modified', () => {
            const base = 'The quick brown fox';
            const local = 'The brown fox'; // Local deleted "quick "
            const remote = 'The fast brown fox'; // Remote modified "quick" -> "fast"

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);

            const result = diff3MergeText(local, base, remote);
            expect(result.hasConflicts).toBe(true);
            expect(result.success).toBe(false);
        });

        it('should declare conflict when Local and Remote insert different words at the exact same position', () => {
            const base = 'Start End';
            const local = 'Start Left End';
            const remote = 'Start Right End';

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);

            const result = diff3MergeText(local, base, remote);
            expect(result.hasConflicts).toBe(true);
            expect(result.content).toContain('<<<<<<< LOCAL');
            expect(result.content).toContain('Start Left End');
            expect(result.content).toContain('=======');
            expect(result.content).toContain('Start Right End');
            expect(result.content).toContain('>>>>>>> REMOTE');
        });

        it('should declare conflict when Local modifies a word and Remote truncates the remainder of the line', () => {
            const base = 'Line header and trailing details';
            const local = 'Line header and modified details';
            const remote = 'Line header'; // Truncated trailing

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);
        });

        it('should declare conflict on overlapping Arabic word modifications', () => {
            const base = 'مدينة الرياض عاصمة المملكة';
            const local = 'مدينة دبي عاصمة المملكة'; // "الرياض" -> "دبي"
            const remote = 'مدينة جدة عاصمة المملكة'; // "الرياض" -> "جدة"

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);

            const mergeResult = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });
            expect(mergeResult.success).toBe(false);
            expect(mergeResult.status).toBe('conflict_overlaps');
            expect(mergeResult.hasOverlaps).toBe(true);
        });
    });

    // =========================================================================
    // 4. Markdown Syntax Integrity Guard (Fail-Closed AST Protection)
    // =========================================================================
    describe('4. Markdown Syntax Integrity Guard (Fail-Closed AST Protection)', () => {
        it('should reject automatic merge and declare conflict when merged line has unclosed backtick', () => {
            const base = 'This is an example statement here';
            const local = '`This is an example statement here'; // Local adds unmatched opening backtick
            const remote = 'This is an example statement now'; // Remote edits text elsewhere

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);

            const fullMerge = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });
            expect(fullMerge.success).toBe(false);
            expect(fullMerge.status).toBe('conflict_overlaps');
            expect(fullMerge.hasOverlaps).toBe(true);
        });

        it('should reject automatic merge when merged line contains an unclosed bold delimiter (**)', () => {
            const base = 'Important alert notification text';
            const local = '**Important alert notification text'; // Local added unclosed **
            const remote = 'Important alert notification message'; // Remote changed text

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);

            const fullMerge = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });
            expect(fullMerge.success).toBe(false);
            expect(fullMerge.status).toBe('conflict_overlaps');
        });

        it('should reject automatic merge when merged line forms an unclosed fenced code block', () => {
            const base = 'code block marker';
            const local = '```typescript marker';
            const remote = 'code block marker updated';

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);
        });

        it('should reject automatic merge when merged line is an orphan table delimiter row', () => {
            const base = 'Sample data row item';
            const local = '| :--- | :--- |'; // Becomes orphan delimiter row
            const remote = 'Sample data row modified';

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(false);
        });

        it('should cleanly accept sub-line merge when Markdown formatting is balanced and valid', () => {
            const base = 'Visit `api/v1` for documentation and [Guide](https://lugx.com)';
            const local = 'Visit `api/v2` for documentation and [Guide](https://lugx.com)';
            const remote = 'Visit `api/v1` for reference and [Guide](https://lugx.com)';

            const subResult = trySubLineMerge(local, base, remote);
            expect(subResult.success).toBe(true);
            expect(subResult.line).toBe('Visit `api/v2` for reference and [Guide](https://lugx.com)');

            const integrity = validateMarkdownSyntaxIntegrity(subResult.line!);
            expect(integrity.isValid).toBe(true);
        });
    });

    // =========================================================================
    // 5. Deletion Guard Edge Cases
    // =========================================================================
    describe('5. Deletion Guard Edge Cases', () => {
        it('should keep line deleted when user deleted line locally and remote left it untouched', () => {
            const base = 'Line 1\nLine 2 to be deleted\nLine 3';
            const local = 'Line 1\nLine 3'; // Deleted line 2
            const remote = 'Line 1\nLine 2 to be deleted\nLine 3'; // Remote untouched

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.hasOverlaps).toBe(false);
            expect(result.content).toBe('Line 1\nLine 3');
            expect(result.content).not.toContain('Line 2 to be deleted');
        });

        it('should declare conflict when user deleted line locally and remote modified that same line', () => {
            const base = 'Line 1\nImportant Config: original\nLine 3';
            const local = 'Line 1\nLine 3'; // Deleted
            const remote = 'Line 1\nImportant Config: updated_by_remote\nLine 3'; // Modified

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe('conflict_overlaps');
            expect(result.hasOverlaps).toBe(true);
            expect(result.conflictMarkers).toContain('Important Config: updated_by_remote');
        });

        it('should handle multiple non-contiguous lines deleted locally with interspersed remote changes', () => {
            const base = [
                'Item 1',
                'Del A',
                'Item 2',
                'Del B',
                'Item 3',
                'Del C',
                'Item 4',
            ].join('\n');

            const local = [
                'Item 1',
                'Item 2',
                'Item 3',
                'Item 4',
            ].join('\n'); // Deleted Del A, Del B, Del C

            const remote = [
                'Item 1 (remote mod)',
                'Del A',
                'Item 2',
                'Del B',
                'Item 3',
                'Del C',
                'Item 4 (remote mod)',
            ].join('\n'); // Modified Item 1 and Item 4

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.content).toBe([
                'Item 1 (remote mod)',
                'Item 2',
                'Item 3',
                'Item 4 (remote mod)',
            ].join('\n'));
            expect(result.content).not.toContain('Del A');
            expect(result.content).not.toContain('Del B');
            expect(result.content).not.toContain('Del C');
        });

        it('should merge cleanly when Base has 10 lines, Local deleted 5 lines, and Remote added 2 lines at end', () => {
            const baseLines = [
                'Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5',
                'Line 6', 'Line 7', 'Line 8', 'Line 9', 'Line 10',
            ];
            const base = baseLines.join('\n');

            // Local deletes even-numbered lines: 2, 4, 6, 8, 10
            const localLines = ['Line 1', 'Line 3', 'Line 5', 'Line 7', 'Line 9'];
            const local = localLines.join('\n');

            // Remote keeps all 10 lines and adds 2 at end
            const remoteLines = [...baseLines, 'Remote Extra 1', 'Remote Extra 2'];
            const remote = remoteLines.join('\n');

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.hasOverlaps).toBe(false);

            // Deleted lines must NOT be resurrected
            expect(result.content).not.toContain('Line 2');
            expect(result.content).not.toContain('Line 4');
            expect(result.content).not.toContain('Line 6');
            expect(result.content).not.toContain('Line 8');
            expect(result.content).not.toContain('Line 10');

            // Preserved local lines and remote additions must exist
            expect(result.content).toContain('Line 1');
            expect(result.content).toContain('Line 3');
            expect(result.content).toContain('Line 5');
            expect(result.content).toContain('Line 7');
            expect(result.content).toContain('Line 9');
            expect(result.content).toContain('Remote Extra 1');
            expect(result.content).toContain('Remote Extra 2');
        });

        it('should verify applyDeletionGuard standalone helper outputs accurate partitions', () => {
            const base = 'Base 1\nBase 2\nBase 3';
            const local = 'Base 1\nBase 3'; // Deleted Base 2
            const server = 'Base 1\nBase 2\nServer Add\nBase 3';

            const guard = resolver.applyDeletionGuard(base, local, server);
            expect(guard.deletedLines).toEqual(['Base 2']);
            expect(guard.addedLines).toEqual(['Server Add']);
            expect(guard.purgedServerContent).toBe('Base 1\nServer Add\nBase 3');
        });

        it('should handle deletion of multiple base lines while remote appends new lines at end', () => {
            const base = 'Line A\nLine B\nLine C';
            const local = 'Line A'; // User kept Line A, deleted B and C
            const remote = 'Line A\nLine B\nLine C\nLine D'; // Server added Line D

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.content).toBe('Line A\nLine D');
            expect(result.content).not.toContain('Line B');
            expect(result.content).not.toContain('Line C');
        });
    });

    // =========================================================================
    // 6. Visual Diff & WordSpan Precision
    // =========================================================================
    describe('6. Visual Diff & WordSpan Precision', () => {
        it('should produce exact tokens for single word change in middle of sentence via computeWordSpans', () => {
            const oldLine = 'The quick brown fox';
            const newLine = 'The fast brown fox';

            const spans = resolver.computeWordSpans(oldLine, newLine);
            expect(spans).toBeDefined();

            const delSpan = spans.find(s => s.type === 'delete');
            const insSpan = spans.find(s => s.type === 'insert');
            expect(delSpan?.value).toBe('quick');
            expect(insSpan?.value).toBe('fast');

            const equalJoined = spans.filter(s => s.type === 'equal').map(s => s.value).join('');
            expect(equalJoined).toBe('The  brown fox');
        });

        it('should return modify type with exact spans when lines are paired in computeVisualDiff', () => {
            const local = 'User status: pending';
            const remote = 'User status: active';

            const diffs = resolver.computeVisualDiff(local, remote);
            expect(diffs).toHaveLength(1);
            expect(diffs[0].type).toBe('modify');

            if (diffs[0].type === 'modify') {
                expect(diffs[0].oldValue).toBe(local);
                expect(diffs[0].newValue).toBe(remote);

                const del = diffs[0].spans.find(s => s.type === 'delete');
                const ins = diffs[0].spans.find(s => s.type === 'insert');
                expect(del?.value).toBe('pending');
                expect(ins?.value).toBe('active');
            }
        });

        it('should compute fine-grained spans for Arabic text modification', () => {
            const oldLine = 'مرحبا بالعالم الجميل';
            const newLine = 'أهلا بالعالم الجميل';

            const spans = resolver.computeWordSpans(oldLine, newLine);
            const delSpan = spans.find(s => s.type === 'delete');
            const insSpan = spans.find(s => s.type === 'insert');

            expect(delSpan?.value).toBe('مرحبا');
            expect(insSpan?.value).toBe('أهلا');

            const equalSpanText = spans.filter(s => s.type === 'equal').map(s => s.value).join('');
            expect(equalSpanText).toBe(' بالعالم الجميل');
        });

        it('should accurately handle word insertions and word deletions within sentence', () => {
            const oldLine = 'alpha beta gamma';
            const newLine = 'alpha inserted beta'; // inserted "inserted", deleted "gamma"

            const spans = resolver.computeWordSpans(oldLine, newLine);
            expect(spans.some(s => s.type === 'insert' && s.value === 'inserted')).toBe(true);
            expect(spans.some(s => s.type === 'delete' && s.value === 'gamma')).toBe(true);
        });

        it('should pair multi-line modifications into 1-to-1 modify diff ops with individual spans', () => {
            const local = 'Line 1: red car\nLine 2: blue sky';
            const remote = 'Line 1: green car\nLine 2: dark sky';

            const diffs = resolver.computeVisualDiff(local, remote);
            expect(diffs).toHaveLength(2);
            expect(diffs[0].type).toBe('modify');
            expect(diffs[1].type).toBe('modify');

            if (diffs[0].type === 'modify' && diffs[1].type === 'modify') {
                expect(diffs[0].spans.find(s => s.type === 'delete')?.value).toBe('red');
                expect(diffs[0].spans.find(s => s.type === 'insert')?.value).toBe('green');
                expect(diffs[1].spans.find(s => s.type === 'delete')?.value).toBe('blue');
                expect(diffs[1].spans.find(s => s.type === 'insert')?.value).toBe('dark');
            }
        });

        it('should mark locally deleted base lines as delete ops rather than remote insert ops when baseContent is provided', () => {
            const base = 'Start\nDeleted Line\nEnd';
            const local = 'Start\nEnd';
            const remote = 'Start\nDeleted Line\nEnd';

            // When baseContent is passed:
            const diffsWithBase = resolver.computeVisualDiff(local, remote, base);
            const hasDelete = diffsWithBase.some(d => d.type === 'delete' && d.value === 'Deleted Line');
            const hasInsert = diffsWithBase.some(d => d.type === 'insert' && d.value === 'Deleted Line');

            expect(hasDelete).toBe(true);
            expect(hasInsert).toBe(false);
        });
    });
});
