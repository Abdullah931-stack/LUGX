/**
 * Conflict Resolver
 * 
 * Handles detection and resolution of sync conflicts between local and server versions.
 * Implements Three-Way Merge for non-overlapping changes.
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
 * Merge result
 */
export interface MergeResult {
    /** Whether merge was successful without conflicts */
    success: boolean;
    /** Merged content (if success is true) */
    content?: string;
    /** Whether there are overlapping changes requiring manual resolution */
    hasOverlaps: boolean;
    /** Diff operations for visualization */
    diffs?: DiffOp[];
}

/**
 * Conflict resolution strategy
 */
export type ResolutionStrategy = 'local' | 'server' | 'merge';

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
        }
    ): SyncConflict {
        return {
            fileId: localFile.id,
            localVersion: {
                content: localFile.content,
                etag: localFile.etag,
                lastModified: localFile.lastModified,
                version: localFile.version,
            },
            serverVersion: {
                content: serverData.content,
                etag: serverData.etag,
                lastModified: new Date(serverData.updatedAt).getTime(),
                version: serverData.version,
            },
            operations: [],
            detectedAt: Date.now(),
        };
    }

    /**
     * Attempt automatic Three-Way Merge
     * Uses line-based diffing for text content
     */
    attemptAutoMerge(
        baseContent: string,
        localContent: string,
        serverContent: string
    ): MergeResult {
        // Split content into lines for line-based diffing
        const baseLines = baseContent.split('\n');
        const localLines = localContent.split('\n');
        const serverLines = serverContent.split('\n');

        // Find changes in local and server relative to base
        const localChanges = this.findLineChanges(baseLines, localLines);
        const serverChanges = this.findLineChanges(baseLines, serverLines);

        // Check for overlapping changes
        const overlaps = this.findOverlaps(localChanges, serverChanges);

        if (overlaps.length > 0) {
            // Has overlapping changes - needs manual resolution
            return {
                success: false,
                hasOverlaps: true,
                diffs: this.computeVisualDiff(localContent, serverContent),
            };
        }

        // No overlaps - can merge automatically
        try {
            const mergedLines = this.mergeChanges(baseLines, localChanges, serverChanges);
            return {
                success: true,
                content: mergedLines.join('\n'),
                hasOverlaps: false,
            };
        } catch {
            return {
                success: false,
                hasOverlaps: true,
                diffs: this.computeVisualDiff(localContent, serverContent),
            };
        }
    }

    /**
     * Find line-level changes between base and modified content
     */
    private findLineChanges(
        baseLines: string[],
        modifiedLines: string[]
    ): Map<number, { type: 'add' | 'remove' | 'change'; content: string }> {
        const changes = new Map<number, { type: 'add' | 'remove' | 'change'; content: string }>();

        // Simple line-by-line comparison
        const maxLen = Math.max(baseLines.length, modifiedLines.length);

        for (let i = 0; i < maxLen; i++) {
            const baseLine = baseLines[i];
            const modLine = modifiedLines[i];

            if (baseLine === undefined && modLine !== undefined) {
                // Line added
                changes.set(i, { type: 'add', content: modLine });
            } else if (baseLine !== undefined && modLine === undefined) {
                // Line removed
                changes.set(i, { type: 'remove', content: baseLine });
            } else if (baseLine !== modLine) {
                // Line changed
                changes.set(i, { type: 'change', content: modLine });
            }
        }

        return changes;
    }

    /**
     * Find overlapping changes between local and server
     */
    private findOverlaps(
        localChanges: Map<number, { type: string; content: string }>,
        serverChanges: Map<number, { type: string; content: string }>
    ): number[] {
        const overlaps: number[] = [];

        for (const lineNum of localChanges.keys()) {
            if (serverChanges.has(lineNum)) {
                const localChange = localChanges.get(lineNum)!;
                const serverChange = serverChanges.get(lineNum)!;

                // If both changed the same line to different values, it's an overlap
                if (localChange.content !== serverChange.content) {
                    overlaps.push(lineNum);
                }
            }
        }

        return overlaps;
    }

    /**
     * Merge non-overlapping changes
     */
    private mergeChanges(
        baseLines: string[],
        localChanges: Map<number, { type: string; content: string }>,
        serverChanges: Map<number, { type: string; content: string }>
    ): string[] {
        const result = [...baseLines];
        const allChanges = new Map<number, { type: string; content: string }>();

        // Combine changes (local takes precedence for same line)
        for (const [line, change] of serverChanges) {
            allChanges.set(line, change);
        }
        for (const [line, change] of localChanges) {
            allChanges.set(line, change);
        }

        // Apply changes
        const sortedLines = Array.from(allChanges.keys()).sort((a, b) => b - a);

        for (const lineNum of sortedLines) {
            const change = allChanges.get(lineNum)!;

            if (change.type === 'add') {
                result.splice(lineNum, 0, change.content);
            } else if (change.type === 'remove') {
                result.splice(lineNum, 1);
            } else {
                result[lineNum] = change.content;
            }
        }

        return result;
    }

    /**
     * Compute visual diff for UI display
     */
    private computeVisualDiff(localContent: string, serverContent: string): DiffOp[] {
        const diffs: DiffOp[] = [];
        const localLines = localContent.split('\n');
        const serverLines = serverContent.split('\n');

        let i = 0, j = 0;

        while (i < localLines.length || j < serverLines.length) {
            if (i >= localLines.length) {
                // Server has additional lines
                diffs.push({ type: 'insert', value: serverLines[j] });
                j++;
            } else if (j >= serverLines.length) {
                // Local has additional lines
                diffs.push({ type: 'delete', value: localLines[i] });
                i++;
            } else if (localLines[i] === serverLines[j]) {
                // Lines match
                diffs.push({ type: 'equal', value: localLines[i] });
                i++;
                j++;
            } else {
                // Lines differ
                diffs.push({ type: 'delete', value: localLines[i] });
                diffs.push({ type: 'insert', value: serverLines[j] });
                i++;
                j++;
            }
        }

        return diffs;
    }

    /**
     * Apply resolution strategy
     */
    resolveConflict(
        conflict: SyncConflict,
        strategy: ResolutionStrategy,
        mergedContent?: string
    ): { content: string; version: number } {
        switch (strategy) {
            case 'local':
                return {
                    content: conflict.localVersion.content,
                    version: Math.max(conflict.localVersion.version, conflict.serverVersion.version) + 1,
                };
            case 'server':
                return {
                    content: conflict.serverVersion.content,
                    version: conflict.serverVersion.version,
                };
            case 'merge':
                if (!mergedContent) {
                    throw new Error('Merged content required for merge strategy');
                }
                return {
                    content: mergedContent,
                    version: Math.max(conflict.localVersion.version, conflict.serverVersion.version) + 1,
                };
            default:
                throw new Error(`Unknown resolution strategy: ${strategy}`);
        }
    }
}

// Export singleton instance
export const conflictResolver = new ConflictResolver();
