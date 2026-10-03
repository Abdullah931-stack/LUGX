/**
 * Deterministic Three-Way Merge Engine (Diff3)
 * 
 * Implements a sequence-based Three-Way Merge algorithm based on Hunt & McIlroy (1976)
 * Longest Common Subsequence (LCS) and Khanna, Kunal, Pierce (2007) formal merge semantics.
 * 
 * Guarantees:
 * 1. Safe handling of duplicate lines (blank lines, markdown delimiters, repeated code blocks)
 *    without silent content erasure. (Remediates: LUGX-045)
 * 2. Proper preservation of non-overlapping changes across base, local, and remote versions.
 * 3. Deterministic conflict markers (<<<<<<< LOCAL, =======, >>>>>>> REMOTE) on true overlaps.
 * 4. Automatic resolution of false conflicts (identical modifications by both sides).
 */

export interface Diff3Hunk {
    oStart: number;
    oLength: number;
    abStart: number;
    abLength: number;
    ab: 'a' | 'b';
}

export interface Diff3Region {
    stable: boolean;
    buffer?: 'o' | 'a' | 'b';
    bufferStart?: number;
    bufferLength?: number;
    bufferContent?: string[];
    aStart?: number;
    aLength?: number;
    aContent?: string[];
    oStart?: number;
    oLength?: number;
    oContent?: string[];
    bStart?: number;
    bLength?: number;
    bContent?: string[];
}

export interface Diff3Block {
    ok?: string[];
    conflict?: {
        a: string[];
        aIndex: number;
        o: string[];
        oIndex: number;
        b: string[];
        bIndex: number;
    };
}

export interface Diff3Options {
    excludeFalseConflicts?: boolean;
    label?: {
        a?: string;
        o?: string;
        b?: string;
    };
}

export interface Diff3TextMergeResult {
    success: boolean;
    content: string;
    hasConflicts: boolean;
    conflictMarkers?: string;
}

interface LCSCandidate {
    buffer1index: number;
    buffer2index: number;
    chain: LCSCandidate | null;
}

/**
 * Computes Longest Common Subsequence (LCS) of two string arrays using Hunt-McIlroy algorithm.
 */
export function computeLCS(buffer1: string[], buffer2: string[]): LCSCandidate {
    const equivalenceClasses: Record<string, number[]> = Object.create(null);
    for (let j = 0; j < buffer2.length; j++) {
        const item = buffer2[j];
        if (equivalenceClasses[item]) {
            equivalenceClasses[item].push(j);
        } else {
            equivalenceClasses[item] = [j];
        }
    }

    const NULLRESULT: LCSCandidate = { buffer1index: -1, buffer2index: -1, chain: null };
    const candidates: LCSCandidate[] = [NULLRESULT];

    for (let i = 0; i < buffer1.length; i++) {
        const item = buffer1[i];
        const buffer2indices = equivalenceClasses[item] || [];
        let r = 0;
        let c = candidates[0];

        for (const j of buffer2indices) {
            let s: number;
            for (s = r; s < candidates.length; s++) {
                if (
                    candidates[s].buffer2index < j &&
                    (s === candidates.length - 1 || candidates[s + 1].buffer2index > j)
                ) {
                    break;
                }
            }

            if (s < candidates.length) {
                const newCandidate: LCSCandidate = { buffer1index: i, buffer2index: j, chain: candidates[s] };
                if (r === candidates.length) {
                    candidates.push(c);
                } else {
                    candidates[r] = c;
                }
                r = s + 1;
                c = newCandidate;
                if (r === candidates.length) {
                    break;
                }
            }
        }

        candidates[r] = c;
    }

    return candidates[candidates.length - 1];
}

/**
 * Generates array mismatch indices between buffer1 and buffer2 based on LCS.
 */
export function diffIndices(buffer1: string[], buffer2: string[]): Array<{
    buffer1: [number, number];
    buffer1Content: string[];
    buffer2: [number, number];
    buffer2Content: string[];
}> {
    const lcs = computeLCS(buffer1, buffer2);
    const result: Array<{
        buffer1: [number, number];
        buffer1Content: string[];
        buffer2: [number, number];
        buffer2Content: string[];
    }> = [];
    let tail1 = buffer1.length;
    let tail2 = buffer2.length;

    for (let candidate: LCSCandidate | null = lcs; candidate !== null; candidate = candidate.chain) {
        const mismatchLength1 = tail1 - candidate.buffer1index - 1;
        const mismatchLength2 = tail2 - candidate.buffer2index - 1;
        tail1 = candidate.buffer1index;
        tail2 = candidate.buffer2index;

        if (mismatchLength1 > 0 || mismatchLength2 > 0) {
            result.push({
                buffer1: [tail1 + 1, mismatchLength1],
                buffer1Content: buffer1.slice(tail1 + 1, tail1 + 1 + mismatchLength1),
                buffer2: [tail2 + 1, mismatchLength2],
                buffer2Content: buffer2.slice(tail2 + 1, tail2 + 1 + mismatchLength2),
            });
        }
    }

    result.reverse();
    return result;
}

/**
 * Computes 3-way merge regions identifying stable matching spans and unstable conflict zones.
 */
export function diff3MergeRegions(a: string[], o: string[], b: string[]): Diff3Region[] {
    const hunks: Diff3Hunk[] = [];

    function addHunk(item: ReturnType<typeof diffIndices>[0], ab: 'a' | 'b') {
        hunks.push({
            ab,
            oStart: item.buffer1[0],
            oLength: item.buffer1[1],
            abStart: item.buffer2[0],
            abLength: item.buffer2[1],
        });
    }

    diffIndices(o, a).forEach(item => addHunk(item, 'a'));
    diffIndices(o, b).forEach(item => addHunk(item, 'b'));
    hunks.sort((x, y) => x.oStart - y.oStart);

    const results: Diff3Region[] = [];
    let currOffset = 0;

    function advanceTo(endOffset: number) {
        if (endOffset > currOffset) {
            results.push({
                stable: true,
                buffer: 'o',
                bufferStart: currOffset,
                bufferLength: endOffset - currOffset,
                bufferContent: o.slice(currOffset, endOffset),
            });
            currOffset = endOffset;
        }
    }

    while (hunks.length > 0) {
        let hunk = hunks.shift()!;
        const regionStart = hunk.oStart;
        let regionEnd = hunk.oStart + hunk.oLength;
        const regionHunks = [hunk];
        advanceTo(regionStart);

        while (hunks.length > 0) {
            const nextHunk = hunks[0];
            const nextHunkStart = nextHunk.oStart;
            const overlaps =
                nextHunkStart < regionEnd ||
                (nextHunkStart === regionEnd && regionStart === regionEnd && nextHunk.oLength === 0);

            if (!overlaps) break;

            regionEnd = Math.max(regionEnd, nextHunkStart + nextHunk.oLength);
            regionHunks.push(hunks.shift()!);
        }

        if (regionHunks.length === 1) {
            if (hunk.abLength > 0) {
                const buffer = hunk.ab === 'a' ? a : b;
                results.push({
                    stable: true,
                    buffer: hunk.ab,
                    bufferStart: hunk.abStart,
                    bufferLength: hunk.abLength,
                    bufferContent: buffer.slice(hunk.abStart, hunk.abStart + hunk.abLength),
                });
            }
        } else {
            const bounds = {
                a: [a.length, -1, o.length, -1],
                b: [b.length, -1, o.length, -1],
            };

            while (regionHunks.length > 0) {
                hunk = regionHunks.shift()!;
                const oStart = hunk.oStart;
                const oEnd = oStart + hunk.oLength;
                const abStart = hunk.abStart;
                const abEnd = abStart + hunk.abLength;
                const bound = bounds[hunk.ab];
                bound[0] = Math.min(abStart, bound[0]);
                bound[1] = Math.max(abEnd, bound[1]);
                bound[2] = Math.min(oStart, bound[2]);
                bound[3] = Math.max(oEnd, bound[3]);
            }

            const aStart = bounds.a[0] + (regionStart - bounds.a[2]);
            const aEnd = bounds.a[1] + (regionEnd - bounds.a[3]);
            const bStart = bounds.b[0] + (regionStart - bounds.b[2]);
            const bEnd = bounds.b[1] + (regionEnd - bounds.b[3]);

            results.push({
                stable: false,
                aStart,
                aLength: aEnd - aStart,
                aContent: a.slice(aStart, aEnd),
                oStart: regionStart,
                oLength: regionEnd - regionStart,
                oContent: o.slice(regionStart, regionEnd),
                bStart,
                bLength: bEnd - bStart,
                bContent: b.slice(bStart, bEnd),
            });
        }
        currOffset = regionEnd;
    }

    advanceTo(o.length);
    return results;
}

function areArraysEqual(arr1?: string[], arr2?: string[]): boolean {
    if (!arr1 || !arr2) return arr1 === arr2;
    if (arr1.length !== arr2.length) return false;
    for (let i = 0; i < arr1.length; i++) {
        if (arr1[i] !== arr2[i]) return false;
    }
    return true;
}

/**
 * Executes a 3-way merge on string arrays (local/a, base/o, remote/b).
 */
export function diff3Merge(
    a: string[],
    o: string[],
    b: string[],
    options?: Diff3Options
): Diff3Block[] {
    const excludeFalseConflicts = options?.excludeFalseConflicts ?? true;
    const regions = diff3MergeRegions(a, o, b);
    const results: Diff3Block[] = [];
    let okBuffer: string[] = [];

    function flushOk() {
        if (okBuffer.length > 0) {
            results.push({ ok: okBuffer });
        }
        okBuffer = [];
    }

    for (const region of regions) {
        if (region.stable) {
            okBuffer.push(...(region.bufferContent || []));
        } else {
            if (excludeFalseConflicts && areArraysEqual(region.aContent, region.bContent)) {
                okBuffer.push(...(region.aContent || []));
            } else {
                flushOk();
                results.push({
                    conflict: {
                        a: region.aContent || [],
                        aIndex: region.aStart || 0,
                        o: region.oContent || [],
                        oIndex: region.oStart || 0,
                        b: region.bContent || [],
                        bIndex: region.bStart || 0,
                    },
                });
            }
        }
    }

    flushOk();
    return results;
}

/**
 * Executes a full 3-way text merge on Markdown string documents.
 */
export function diff3MergeText(
    localContent: string,
    baseContent: string,
    remoteContent: string,
    options?: Diff3Options
): Diff3TextMergeResult {
    // Fast path: if local matches remote, identical converged state
    if (localContent === remoteContent) {
        return { success: true, content: localContent, hasConflicts: false };
    }
    // Fast path: if local matches base, cleanly take remote updates
    if (localContent === baseContent) {
        return { success: true, content: remoteContent, hasConflicts: false };
    }
    // Fast path: if remote matches base, cleanly retain local updates
    if (remoteContent === baseContent) {
        return { success: true, content: localContent, hasConflicts: false };
    }

    const aLines = localContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const oLines = baseContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const bLines = remoteContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    const blocks = diff3Merge(aLines, oLines, bLines, options);

    const aLabel = options?.label?.a || 'LOCAL';
    const bLabel = options?.label?.b || 'REMOTE';

    let hasConflicts = false;
    const resultLines: string[] = [];

    for (const block of blocks) {
        if (block.ok) {
            resultLines.push(...block.ok);
        } else if (block.conflict) {
            hasConflicts = true;
            resultLines.push(`<<<<<<< ${aLabel}`);
            resultLines.push(...block.conflict.a);
            resultLines.push('=======');
            resultLines.push(...block.conflict.b);
            resultLines.push(`>>>>>>> ${bLabel}`);
        }
    }

    const mergedContent = resultLines.join('\n');

    return {
        success: !hasConflicts,
        content: mergedContent,
        hasConflicts,
        conflictMarkers: hasConflicts ? mergedContent : undefined,
    };
}
