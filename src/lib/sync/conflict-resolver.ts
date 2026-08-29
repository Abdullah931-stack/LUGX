/**
 * Conflict Resolver
 * 
 * Handles detection and resolution of sync conflicts between local, server, and base versions.
 * Implements deterministic Three-Way Merge for text, HTML, metadata, and handles delete/restore conflicts.
 */

import { IDBFile, SyncConflict } from './idb-types';

/**
 * Diff operation types
 */
export type DiffOp =
    | { type: 'equal'; value: string }
    | { type: 'insert'; value: string }
    | { type: 'delete'; value: string };

/**
 * Status of the merge execution
 */
export type MergeStatus =
    | 'merged_clean'
    | 'conflict_overlaps'
    | 'manual_resolution_required'
    | 'delete_conflict';

/**
 * Merge result
 */
export interface MergeResult {
    /** Whether merge was successful without any conflicts */
    success: boolean;
    /** Detailed status of the merge operation */
    status: MergeStatus;
    /** Merged content (if success or contains inline conflict markers) */
    content?: string;
    /** Merged title */
    title?: string;
    /** Merged parent folder id */
    parentFolderId?: string | null;
    /** Whether there are overlapping changes requiring manual resolution */
    hasOverlaps: boolean;
    /** Diff operations for visualization */
    diffs?: DiffOp[];
    /** Explicit conflict markers if overlaps were present */
    conflictMarkers?: string;
    /** Specific delete conflict classification */
    deleteAction?: 'remote_deleted_local_modified' | 'local_deleted_remote_modified' | 'both_deleted';
    /** Human-readable explanation */
    reason?: string;
}

/**
 * Input payload representing a file version state
 */
export interface ConflictFilePayload {
    content: string;
    etag?: string;
    version?: number;
    title?: string;
    parentFolderId?: string | null;
    deleted?: boolean;
    lastModified?: number;
}

/**
 * Three-Way Merge Input structure
 */
export interface ThreeWayMergeInput {
    base?: ConflictFilePayload | null;
    local: ConflictFilePayload;
    remote: ConflictFilePayload;
}

/**
 * Conflict resolution strategy
 */
export type ResolutionStrategy = 'local' | 'server' | 'merge' | 'restore' | 'delete';

/**
 * Conflict Resolver Class
 */
export class ConflictResolver {
    /**
     * Detect if there's a conflict between local and server versions
     */
    detectConflict(
        localFile: IDBFile,
        serverEtag: string,
        _serverVersion?: number
    ): boolean {
        // Conflict if ETags differ AND local has unsaved changes
        return localFile.isDirty && localFile.etag !== serverEtag;
    }

    /**
     * Create a SyncConflict object for UI display
     */
    createConflict(
        localFile: IDBFile,
        serverData: {
            content: string;
            etag: string;
            version: number;
            updatedAt: string;
            title?: string;
            parentFolderId?: string | null;
            deleted?: boolean;
        },
        baseData?: ConflictFilePayload
    ): SyncConflict {
        const baseSnapshot = baseData || (localFile.baseSnapshot ? {
            content: localFile.baseSnapshot.content,
            etag: localFile.baseSnapshot.etag,
            version: localFile.baseSnapshot.version,
            title: localFile.baseSnapshot.title,
            parentFolderId: localFile.baseSnapshot.parentFolderId,
            lastModified: localFile.lastSyncedAt || 0,
        } : undefined);

        const isDelete = !!serverData.deleted;

        return {
            fileId: localFile.id,
            localVersion: {
                content: localFile.content,
                etag: localFile.etag,
                lastModified: localFile.lastModified,
                version: localFile.version,
                title: localFile.title,
                parentFolderId: localFile.parentFolderId,
                deleted: false,
            },
            serverVersion: {
                content: serverData.content,
                etag: serverData.etag,
                lastModified: new Date(serverData.updatedAt).getTime(),
                version: serverData.version,
                title: serverData.title || localFile.title,
                parentFolderId: serverData.parentFolderId !== undefined ? serverData.parentFolderId : localFile.parentFolderId,
                deleted: isDelete,
            },
            baseVersion: baseSnapshot ? {
                content: baseSnapshot.content,
                etag: baseSnapshot.etag || '',
                lastModified: baseSnapshot.lastModified || 0,
                version: baseSnapshot.version || 0,
                title: baseSnapshot.title,
                parentFolderId: baseSnapshot.parentFolderId,
                deleted: !!baseSnapshot.deleted,
            } : undefined,
            operations: [],
            detectedAt: Date.now(),
            type: isDelete ? 'delete_conflict' : 'content',
        };
    }

    /**
     * Attempt Three-Way Merge
     * 
     * Handles text, Markdown, metadata (title, parentFolderId), and delete conflicts.
     * Enforces base snapshot presence and post-merge Markdown syntax integrity verification.
     * Rejects automatic merge with 'manual_resolution_required' if base is missing.
     */
    attemptThreeWayMerge(input: ThreeWayMergeInput): MergeResult {
        const { base, local, remote } = input;

        // 1. Validate Base Snapshot presence
        if (base === undefined || base === null || typeof base.content !== 'string') {
            return {
                success: false,
                status: 'manual_resolution_required',
                hasOverlaps: true,
                diffs: this.computeVisualDiff(local.content, remote.content),
                reason: 'Base snapshot missing: automatic three-way merge requires a valid base version',
            };
        }

        // 2. Handle Delete Conflicts
        if (remote.deleted && !local.deleted) {
            return {
                success: false,
                status: 'delete_conflict',
                hasOverlaps: true,
                deleteAction: 'remote_deleted_local_modified',
                diffs: this.computeVisualDiff(local.content, ''),
                reason: 'File was deleted on the server while modified locally',
            };
        }

        if (local.deleted && !remote.deleted) {
            return {
                success: false,
                status: 'delete_conflict',
                hasOverlaps: true,
                deleteAction: 'local_deleted_remote_modified',
                diffs: this.computeVisualDiff('', remote.content),
                reason: 'File was deleted locally while modified on the server',
            };
        }

        if (local.deleted && remote.deleted) {
            return {
                success: true,
                status: 'merged_clean',
                hasOverlaps: false,
                deleteAction: 'both_deleted',
                content: '',
            };
        }

        // 3. Metadata Merge (Title & Parent Folder)
        const titleMerge = this.mergeMetadataField(base.title, local.title, remote.title);
        const parentMerge = this.mergeMetadataField(base.parentFolderId, local.parentFolderId, remote.parentFolderId);

        // 4. Content 3-Way Merge
        const contentMerge = this.mergeContentThreeWay(base.content, local.content, remote.content);

        // 5. Post-Merge Markdown Syntax Integrity Verification
        let syntaxIntegrityFailed = false;
        let syntaxFailureReason: string | undefined;

        if (contentMerge.success && contentMerge.content !== undefined) {
            const integrity = validateMarkdownSyntaxIntegrity(contentMerge.content);
            if (!integrity.valid) {
                syntaxIntegrityFailed = true;
                syntaxFailureReason = integrity.reason;
            }
        }

        const hasMetadataConflict = titleMerge.hasConflict || parentMerge.hasConflict;
        const hasOverlaps = contentMerge.hasOverlaps || hasMetadataConflict || syntaxIntegrityFailed;
        const success = contentMerge.success && !hasMetadataConflict && !syntaxIntegrityFailed;

        return {
            success,
            status: success ? 'merged_clean' : 'conflict_overlaps',
            content: contentMerge.content,
            title: titleMerge.value,
            parentFolderId: parentMerge.value,
            hasOverlaps,
            diffs: contentMerge.diffs || this.computeVisualDiff(local.content, remote.content),
            conflictMarkers: contentMerge.conflictMarkers || (syntaxIntegrityFailed ? contentMerge.content : undefined),
            reason: hasOverlaps
                ? (syntaxFailureReason || 'Conflicting changes detected in content or metadata')
                : undefined,
        };
    }

    /**
     * Backward-compatible overload for attemptAutoMerge
     */
    attemptAutoMerge(
        baseOrInput: string | null | undefined | ThreeWayMergeInput,
        localContent?: string,
        serverContent?: string
    ): MergeResult {
        if (typeof baseOrInput === 'object' && baseOrInput !== null) {
            return this.attemptThreeWayMerge(baseOrInput as ThreeWayMergeInput);
        }

        if (baseOrInput === undefined || baseOrInput === null) {
            return {
                success: false,
                status: 'manual_resolution_required',
                hasOverlaps: true,
                diffs: this.computeVisualDiff(localContent || '', serverContent || ''),
                reason: 'Base snapshot missing: automatic three-way merge requires a valid base version',
            };
        }

        return this.attemptThreeWayMerge({
            base: { content: baseOrInput },
            local: { content: localContent || '' },
            remote: { content: serverContent || '' },
        });
    }

    /**
     * Merge a scalar metadata field (like title or parentFolderId) across Base, Local, Remote
     */
    private mergeMetadataField<T>(
        baseVal: T | undefined,
        localVal: T | undefined,
        remoteVal: T | undefined
    ): { value: T | undefined; hasConflict: boolean } {
        // If local and remote match, choose either
        if (localVal === remoteVal) {
            return { value: localVal, hasConflict: false };
        }

        // If local didn't change relative to base, accept remote
        if (localVal === baseVal) {
            return { value: remoteVal, hasConflict: false };
        }

        // If remote didn't change relative to base, accept local
        if (remoteVal === baseVal) {
            return { value: localVal, hasConflict: false };
        }

        // Both changed differently: conflict
        return { value: localVal, hasConflict: true };
    }

    /**
     * Core 3-Way Content Merge algorithm with Sequence-Aligned LCS Diff3
     */
    private mergeContentThreeWay(
        baseContent: string,
        localContent: string,
        remoteContent: string
    ): { success: boolean; content?: string; hasOverlaps: boolean; diffs?: DiffOp[]; conflictMarkers?: string } {
        // Fast paths
        if (localContent === remoteContent) {
            return { success: true, content: localContent, hasOverlaps: false };
        }
        if (localContent === baseContent) {
            return { success: true, content: remoteContent, hasOverlaps: false };
        }
        if (remoteContent === baseContent) {
            return { success: true, content: localContent, hasOverlaps: false };
        }

        // Tokenize raw Markdown lines
        const baseTokens = this.tokenizeContent(baseContent);
        const localTokens = this.tokenizeContent(localContent);
        const remoteTokens = this.tokenizeContent(remoteContent);

        const mergeResult = this.diff3Merge(baseTokens, localTokens, remoteTokens);

        if (mergeResult.hasOverlaps) {
            return {
                success: false,
                content: mergeResult.content,
                hasOverlaps: true,
                diffs: this.computeVisualDiff(localContent, remoteContent),
                conflictMarkers: mergeResult.content,
            };
        }

        return {
            success: true,
            content: mergeResult.content,
            hasOverlaps: false,
        };
    }

    /**
     * Tokenize content into normalized lines
     */
    private tokenizeContent(content: string): string[] {
        if (!content) return [];
        return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    }

    /**
     * Compute Longest Common Subsequence (LCS) match indices with flat Int32Array
     * Optimized with linear Common Prefix & Suffix trimming for high-load / massive documents.
     */
    private computeLCS(a: string[], b: string[]): Array<[number, number]> {
        const m = a.length;
        const n = b.length;

        if (m === 0 || n === 0) return [];

        // 1. Fast linear Common Prefix trimming
        let start = 0;
        while (start < m && start < n && a[start] === b[start]) {
            start++;
        }

        // If entire smaller array is a prefix of the other
        if (start === m || start === n) {
            const matches: Array<[number, number]> = [];
            for (let k = 0; k < start; k++) {
                matches.push([k, k]);
            }
            return matches;
        }

        // 2. Fast linear Common Suffix trimming
        let endA = m - 1;
        let endB = n - 1;
        while (endA >= start && endB >= start && a[endA] === b[endB]) {
            endA--;
            endB--;
        }

        // Prefix matches
        const matches: Array<[number, number]> = [];
        for (let k = 0; k < start; k++) {
            matches.push([k, k]);
        }

        // 3. Compute DP matrix ONLY for the mutated middle slice
        const midA = a.slice(start, endA + 1);
        const midB = b.slice(start, endB + 1);
        const midM = midA.length;
        const midN = midB.length;

        if (midM > 0 && midN > 0) {
            const stride = midN + 1;
            const dp = new Int32Array((midM + 1) * stride);

            for (let i = 1; i <= midM; i++) {
                const iRow = i * stride;
                const prevRow = (i - 1) * stride;
                const aVal = midA[i - 1];

                for (let j = 1; j <= midN; j++) {
                    if (aVal === midB[j - 1]) {
                        dp[iRow + j] = dp[prevRow + (j - 1)] + 1;
                    } else {
                        const top = dp[prevRow + j];
                        const left = dp[iRow + (j - 1)];
                        dp[iRow + j] = top >= left ? top : left;
                    }
                }
            }

            // Backtrack to find matching index pairs in middle slice
            const midMatches: Array<[number, number]> = [];
            let i = midM;
            let j = midN;

            while (i > 0 && j > 0) {
                const iRow = i * stride;
                const prevRow = (i - 1) * stride;

                if (midA[i - 1] === midB[j - 1]) {
                    midMatches.unshift([start + i - 1, start + j - 1]);
                    i--;
                    j--;
                } else if (dp[prevRow + j] >= dp[iRow + (j - 1)]) {
                    i--;
                } else {
                    j--;
                }
            }

            matches.push(...midMatches);
        }

        // 4. Append Suffix matches
        const suffixLen = m - 1 - endA;
        for (let k = 0; k < suffixLen; k++) {
            matches.push([endA + 1 + k, endB + 1 + k]);
        }

        return matches;
    }

    /**
     * 2-Way Diff: partition base into chunks with replacements in modified
     */
    private diff2Way(base: string[], modified: string[]): Array<{
        baseStart: number;
        baseEnd: number;
        modTokens: string[];
    }> {
        const matches = this.computeLCS(base, modified);
        const chunks: Array<{ baseStart: number; baseEnd: number; modTokens: string[] }> = [];

        let baseIdx = 0;
        let modIdx = 0;

        for (const [matchBase, matchMod] of matches) {
            // Gap before match: change in base [baseIdx..matchBase) replaced by modified [modIdx..matchMod)
            if (baseIdx < matchBase || modIdx < matchMod) {
                chunks.push({
                    baseStart: baseIdx,
                    baseEnd: matchBase,
                    modTokens: modified.slice(modIdx, matchMod),
                });
            }

            // Equal match chunk: base [matchBase..matchBase+1) equals modified [matchMod..matchMod+1)
            chunks.push({
                baseStart: matchBase,
                baseEnd: matchBase + 1,
                modTokens: [base[matchBase]],
            });

            baseIdx = matchBase + 1;
            modIdx = matchMod + 1;
        }

        // Trailing gap after last match
        if (baseIdx < base.length || modIdx < modified.length) {
            chunks.push({
                baseStart: baseIdx,
                baseEnd: base.length,
                modTokens: modified.slice(modIdx),
            });
        }

        return chunks;
    }

    /**
     * Deterministic Diff3 sequence alignment & merge
     */
    private diff3Merge(
        base: string[],
        local: string[],
        remote: string[]
    ): { content: string; hasOverlaps: boolean } {
        const localChunks = this.diff2Way(base, local);
        const remoteChunks = this.diff2Way(base, remote);

        // Identify non-equal change intervals in local and remote
        const rawChangeIntervals: Array<{ start: number; end: number }> = [];

        for (const c of localChunks) {
            const baseSub = base.slice(c.baseStart, c.baseEnd);
            if (!this.areArraysEqual(c.modTokens, baseSub)) {
                rawChangeIntervals.push({ start: c.baseStart, end: c.baseEnd });
            }
        }

        for (const c of remoteChunks) {
            const baseSub = base.slice(c.baseStart, c.baseEnd);
            if (!this.areArraysEqual(c.modTokens, baseSub)) {
                rawChangeIntervals.push({ start: c.baseStart, end: c.baseEnd });
            }
        }

        // Sort intervals by start index
        rawChangeIntervals.sort((a, b) => a.start - b.start || a.end - b.end);

        // Merge overlapping change intervals
        const mergedIntervals: Array<{ start: number; end: number }> = [];
        for (const interval of rawChangeIntervals) {
            if (mergedIntervals.length === 0) {
                mergedIntervals.push({ ...interval });
            } else {
                const prev = mergedIntervals[mergedIntervals.length - 1];
                const isOverlapping = interval.start < prev.end || interval.start === prev.start;
                if (isOverlapping) {
                    prev.end = Math.max(prev.end, interval.end);
                } else {
                    mergedIntervals.push({ ...interval });
                }
            }
        }

        const resultTokens: string[] = [];
        let hasOverlaps = false;
        let lastEnd = 0;

        for (const region of mergedIntervals) {
            // Unchanged gap before this region
            if (region.start > lastEnd) {
                resultTokens.push(...base.slice(lastEnd, region.start));
            }

            const baseSlice = base.slice(region.start, region.end);
            const localSlice = this.extractSliceForRange(localChunks, region.start, region.end, baseSlice);
            const remoteSlice = this.extractSliceForRange(remoteChunks, region.start, region.end, baseSlice);

            const localChanged = !this.areArraysEqual(localSlice, baseSlice);
            const remoteChanged = !this.areArraysEqual(remoteSlice, baseSlice);

            if (!localChanged && !remoteChanged) {
                resultTokens.push(...baseSlice);
            } else if (localChanged && !remoteChanged) {
                resultTokens.push(...localSlice);
            } else if (!localChanged && remoteChanged) {
                resultTokens.push(...remoteSlice);
            } else if (this.areArraysEqual(localSlice, remoteSlice)) {
                resultTokens.push(...localSlice);
            } else {
                hasOverlaps = true;
                resultTokens.push('<<<<<<< LOCAL');
                resultTokens.push(...localSlice);
                resultTokens.push('=======');
                resultTokens.push(...remoteSlice);
                resultTokens.push('>>>>>>> REMOTE');
            }

            lastEnd = region.end;
        }

        // Trailing unchanged gap
        if (lastEnd < base.length) {
            resultTokens.push(...base.slice(lastEnd, base.length));
        }

        return {
            content: resultTokens.join('\n'),
            hasOverlaps,
        };
    }

    /**
     * Extract modified tokens covering a base interval [start, end)
     */
    private extractSliceForRange(
        chunks: Array<{ baseStart: number; baseEnd: number; modTokens: string[] }>,
        start: number,
        end: number,
        baseSlice: string[]
    ): string[] {
        const matchingChunks = chunks.filter(c => 
            (c.baseStart >= start && c.baseEnd <= end) ||
            (start === end && c.baseStart === start && c.baseEnd === end)
        );

        if (matchingChunks.length === 0) {
            return baseSlice;
        }

        const res: string[] = [];
        for (const c of matchingChunks) {
            res.push(...c.modTokens);
        }
        return res;
    }

    /**
     * Compare two string arrays for exact equality
     */
    private areArraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    /**
     * Compute visual diff using Longest Common Subsequence
     */
    public computeVisualDiff(localContent: string, serverContent: string): DiffOp[] {
        const localLines = this.tokenizeContent(localContent);
        const serverLines = this.tokenizeContent(serverContent);
        const matches = this.computeLCS(localLines, serverLines);

        const diffs: DiffOp[] = [];
        let localIdx = 0;
        let serverIdx = 0;

        for (const [matchLocal, matchServer] of matches) {
            // Deletions from local
            while (localIdx < matchLocal) {
                diffs.push({ type: 'delete', value: localLines[localIdx] });
                localIdx++;
            }
            // Insertions from server
            while (serverIdx < matchServer) {
                diffs.push({ type: 'insert', value: serverLines[serverIdx] });
                serverIdx++;
            }
            // Matching equal line
            diffs.push({ type: 'equal', value: localLines[localIdx] });
            localIdx++;
            serverIdx++;
        }

        // Trailing deletions
        while (localIdx < localLines.length) {
            diffs.push({ type: 'delete', value: localLines[localIdx] });
            localIdx++;
        }
        // Trailing insertions
        while (serverIdx < serverLines.length) {
            diffs.push({ type: 'insert', value: serverLines[serverIdx] });
            serverIdx++;
        }

        return diffs;
    }

    /**
     * Apply resolution strategy
     */
    resolveConflict(
        conflict: SyncConflict,
        strategy: ResolutionStrategy,
        customContent?: string,
        customTitle?: string
    ): { content: string; version: number; title?: string; deleted?: boolean } {
        const maxVersion = Math.max(conflict.localVersion.version || 0, conflict.serverVersion.version || 0);

        switch (strategy) {
            case 'local':
                return {
                    content: conflict.localVersion.content,
                    version: maxVersion + 1,
                    title: conflict.localVersion.title,
                    deleted: false,
                };
            case 'server':
                return {
                    content: conflict.serverVersion.content,
                    version: conflict.serverVersion.version,
                    title: conflict.serverVersion.title,
                    deleted: conflict.serverVersion.deleted,
                };
            case 'merge':
                if (customContent === undefined) {
                    throw new Error('Merged content required for merge strategy');
                }
                return {
                    content: customContent,
                    version: maxVersion + 1,
                    title: customTitle || conflict.localVersion.title || conflict.serverVersion.title,
                    deleted: false,
                };
            case 'restore':
                return {
                    content: conflict.localVersion.content,
                    version: maxVersion + 1,
                    title: conflict.localVersion.title,
                    deleted: false,
                };
            case 'delete':
                return {
                    content: '',
                    version: maxVersion + 1,
                    deleted: true,
                };
            default:
                throw new Error(`Unknown resolution strategy: ${strategy}`);
        }
    }
}

/**
 * Markdown Syntax Integrity Validator
 * 
 * Verifies that automated three-way merges did not produce structurally corrupt Markdown,
 * specifically checking for:
 * 1. Unclosed fenced code blocks (``` or ~~~)
 * 2. Malformed / broken GFM tables (orphan delimiters, column count mismatches)
 */
export function validateMarkdownSyntaxIntegrity(content: string): { valid: boolean; reason?: string } {
    if (!content) return { valid: true };

    const lines = content.split('\n');

    let inCodeBlock = false;
    let codeFenceChar = '';
    let codeFenceLength = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 1. Code Fence Detection
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
                continue;
            } else if (char === codeFenceChar && length >= codeFenceLength && rest === '') {
                // Closing fence
                inCodeBlock = false;
                codeFenceChar = '';
                codeFenceLength = 0;
                continue;
            }
        }

        // If inside a code block, skip table structure checks
        if (inCodeBlock) {
            continue;
        }

        // 2. GFM Table Delimiter Detection
        // GFM table delimiter row: consists of pipes, dashes, colons, spaces, e.g. | :--- | ---: | :---: |
        const isTableDelimiter = /^\s*\|?(\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/.test(line) && line.includes('-');

        if (isTableDelimiter) {
            // Must have a preceding header line
            if (i === 0) {
                return {
                    valid: false,
                    reason: 'Malformed GFM table: delimiter row appears at document start without header',
                };
            }

            const prevLine = lines[i - 1].trim();
            if (!prevLine || !prevLine.includes('|')) {
                return {
                    valid: false,
                    reason: 'Malformed GFM table: orphan delimiter row without preceding table header',
                };
            }

            // Count columns in header vs delimiter (respecting escaped pipes \|)
            const getColumns = (row: string) => {
                let s = row.trim();
                if (s.startsWith('|')) s = s.slice(1);
                if (s.endsWith('|')) s = s.slice(0, -1);
                return s.split(/(?<!\\)\|/).map(c => c.trim());
            };

            const headerCols = getColumns(prevLine);
            const delimiterCols = getColumns(line);

            if (headerCols.length !== delimiterCols.length) {
                return {
                    valid: false,
                    reason: `Malformed GFM table: column count mismatch (header: ${headerCols.length}, delimiter: ${delimiterCols.length})`,
                };
            }
        }
    }

    if (inCodeBlock) {
        return {
            valid: false,
            reason: `Unclosed fenced code block (${codeFenceChar.repeat(codeFenceLength)}) detected after merge`,
        };
    }

    return { valid: true };
}

// Export singleton instance
export const conflictResolver = new ConflictResolver();

