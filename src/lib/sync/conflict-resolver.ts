/**
 * Conflict Resolver
 * 
 * Handles detection and resolution of sync conflicts between local, server, and base versions.
 * Implements deterministic Three-Way Merge for text, HTML, metadata, and handles delete/restore conflicts.
 */

import { IDBFile, SyncConflict, ConflictFileState } from './idb-types';

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
        serverVersion: number
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
     * Handles text, HTML, metadata (title, parentFolderId), and delete conflicts.
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

        const hasMetadataConflict = titleMerge.hasConflict || parentMerge.hasConflict;
        const hasOverlaps = contentMerge.hasOverlaps || hasMetadataConflict;
        const success = contentMerge.success && !hasMetadataConflict;

        return {
            success,
            status: success ? 'merged_clean' : 'conflict_overlaps',
            content: contentMerge.content,
            title: titleMerge.value,
            parentFolderId: parentMerge.value,
            hasOverlaps,
            diffs: contentMerge.diffs || this.computeVisualDiff(local.content, remote.content),
            conflictMarkers: contentMerge.conflictMarkers,
            reason: hasOverlaps ? 'Conflicting changes detected in content or metadata' : undefined,
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

        // Tokenize by lines / HTML blocks
        const isHtml = baseContent.includes('<p>') || baseContent.includes('<div>') || localContent.includes('<p>') || remoteContent.includes('<p>');
        const delimiter = isHtml ? '\n' : '\n';

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
     * Tokenize content into lines or top-level HTML blocks
     */
    private tokenizeContent(content: string): string[] {
        if (!content) return [];
        if (content.includes('\n')) {
            return content.split('\n');
        }
        // If minified HTML without newlines, split on block element boundaries
        if (/(?:<\/p>|<\/div>|<\/h[1-6]>|<\/li>)/i.test(content)) {
            return content
                .replace(/(<\/(?:p|div|h[1-6]|li)>)/gi, '$1\n')
                .split('\n')
                .filter(t => t.length > 0);
        }
        return [content];
    }

    /**
     * Compute Longest Common Subsequence (LCS) match indices with flat Int32Array
     */
    private computeLCS(a: string[], b: string[]): Array<[number, number]> {
        const m = a.length;
        const n = b.length;

        if (m === 0 || n === 0) return [];

        const stride = n + 1;
        const dp = new Int32Array((m + 1) * stride);

        for (let i = 1; i <= m; i++) {
            const iRow = i * stride;
            const prevRow = (i - 1) * stride;
            const aVal = a[i - 1];

            for (let j = 1; j <= n; j++) {
                if (aVal === b[j - 1]) {
                    dp[iRow + j] = dp[prevRow + (j - 1)] + 1;
                } else {
                    const top = dp[prevRow + j];
                    const left = dp[iRow + (j - 1)];
                    dp[iRow + j] = top >= left ? top : left;
                }
            }
        }

        // Backtrack to find matching index pairs
        const matches: Array<[number, number]> = [];
        let i = m;
        let j = n;

        while (i > 0 && j > 0) {
            const iRow = i * stride;
            const prevRow = (i - 1) * stride;

            if (a[i - 1] === b[j - 1]) {
                matches.unshift([i - 1, j - 1]);
                i--;
                j--;
            } else if (dp[prevRow + j] >= dp[iRow + (j - 1)]) {
                i--;
            } else {
                j--;
            }
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

        // Collect all boundary points along the base array [0..base.length]
        const boundaries = new Set<number>([0, base.length]);
        for (const c of localChunks) {
            boundaries.add(c.baseStart);
            boundaries.add(c.baseEnd);
        }
        for (const c of remoteChunks) {
            boundaries.add(c.baseStart);
            boundaries.add(c.baseEnd);
        }

        const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);
        const resultTokens: string[] = [];
        let hasOverlaps = false;

        // Helper to extract replacement tokens from chunks for a base range [start, end)
        const getReplacement = (chunks: Array<{ baseStart: number; baseEnd: number; modTokens: string[] }>, start: number, end: number, isBaseZero: boolean): string[] => {
            const tokens: string[] = [];
            for (const c of chunks) {
                if (start === end) {
                    // Pure insertion before base index
                    if (c.baseStart === start && c.baseEnd === end) {
                        tokens.push(...c.modTokens);
                    }
                } else if (c.baseStart >= start && c.baseEnd <= end) {
                    tokens.push(...c.modTokens);
                }
            }
            return tokens;
        };

        for (let b = 0; b < sortedBoundaries.length - 1; b++) {
            const start = sortedBoundaries[b];
            const end = sortedBoundaries[b + 1];
            const baseSlice = base.slice(start, end);

            // Find what local and remote did in this slice
            const localSlice = this.extractSliceForRange(localChunks, start, end, baseSlice);
            const remoteSlice = this.extractSliceForRange(remoteChunks, start, end, baseSlice);

            const localChanged = !this.areArraysEqual(localSlice, baseSlice);
            const remoteChanged = !this.areArraysEqual(remoteSlice, baseSlice);

            if (!localChanged && !remoteChanged) {
                // Neither changed -> keep base
                resultTokens.push(...baseSlice);
            } else if (localChanged && !remoteChanged) {
                // Only local changed -> apply local
                resultTokens.push(...localSlice);
            } else if (!localChanged && remoteChanged) {
                // Only remote changed -> apply remote
                resultTokens.push(...remoteSlice);
            } else if (this.areArraysEqual(localSlice, remoteSlice)) {
                // Both changed identically -> apply change
                resultTokens.push(...localSlice);
            } else {
                // Both changed differently -> Conflict!
                hasOverlaps = true;
                resultTokens.push('<<<<<<< LOCAL');
                resultTokens.push(...localSlice);
                resultTokens.push('=======');
                resultTokens.push(...remoteSlice);
                resultTokens.push('>>>>>>> REMOTE');
            }
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

// Export singleton instance
export const conflictResolver = new ConflictResolver();

