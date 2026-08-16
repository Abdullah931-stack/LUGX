/**
 * Conflict Resolver Tests
 * Tests for conflict detection and resolution strategies
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictResolver, MergeResult, ResolutionStrategy } from './conflict-resolver';
import { IDBFile, SyncConflict } from './idb-types';

describe('Conflict Resolver', () => {
    let resolver: ConflictResolver;

    beforeEach(() => {
        resolver = new ConflictResolver();
    });

    describe('detectConflict', () => {
        it('should detect conflict when ETags differ and file is dirty', () => {
            const localFile: IDBFile = {
                id: 'file-1',
                content: 'Local content',
                etag: 'local-etag',
                isDirty: true,
                version: 1,
            } as IDBFile;

            const hasConflict = resolver.detectConflict(localFile, 'server-etag', 2);

            expect(hasConflict).toBe(true);
        });

        it('should not detect conflict when file is not dirty', () => {
            const localFile: IDBFile = {
                id: 'file-1',
                content: 'Content',
                etag: 'local-etag',
                isDirty: false,
                version: 1,
            } as IDBFile;

            const hasConflict = resolver.detectConflict(localFile, 'server-etag', 2);

            expect(hasConflict).toBe(false);
        });

        it('should not detect conflict when ETags match', () => {
            const localFile: IDBFile = {
                id: 'file-1',
                content: 'Content',
                etag: 'same-etag',
                isDirty: true,
                version: 1,
            } as IDBFile;

            const hasConflict = resolver.detectConflict(localFile, 'same-etag', 1);

            expect(hasConflict).toBe(false);
        });
    });

    describe('createConflict', () => {
        it('should create SyncConflict object', () => {
            const localFile: IDBFile = {
                id: 'file-1',
                content: 'Local content',
                etag: 'local-etag',
                version: 1,
                lastModified: Date.now(),
            } as IDBFile;

            const serverData = {
                content: 'Server content',
                etag: 'server-etag',
                version: 2,
                updatedAt: new Date().toISOString(),
            };

            const conflict = resolver.createConflict(localFile, serverData);

            expect(conflict.fileId).toBe('file-1');
            expect(conflict.localVersion.content).toBe('Local content');
            expect(conflict.serverVersion.content).toBe('Server content');
            expect(conflict.detectedAt).toBeDefined();
        });
    });

    describe('attemptAutoMerge', () => {
        it('should successfully merge non-overlapping changes', () => {
            const base = 'Line 1\nLine 2\nLine 3';
            const local = 'Line 1 modified\nLine 2\nLine 3';
            const server = 'Line 1\nLine 2\nLine 3 modified';

            const result = resolver.attemptAutoMerge(base, local, server);

            expect(result.success).toBe(true);
            expect(result.hasOverlaps).toBe(false);
            expect(result.content).toContain('Line 1 modified');
            expect(result.content).toContain('Line 3 modified');
        });

        it('should detect overlapping changes', () => {
            const base = 'Line 1\nLine 2\nLine 3';
            const local = 'Line 1\nLine 2 local\nLine 3';
            const server = 'Line 1\nLine 2 server\nLine 3';

            const result = resolver.attemptAutoMerge(base, local, server);

            expect(result.success).toBe(false);
            expect(result.hasOverlaps).toBe(true);
        });

        it('should handle additions', () => {
            const base = 'Line 1\nLine 2';
            const local = 'Line 1\nLine 2\nLine 3 local';
            const server = 'Line 1\nLine 2';

            const result = resolver.attemptAutoMerge(base, local, server);

            expect(result.success).toBe(true);
        });

        it('should handle empty strings', () => {
            const result = resolver.attemptAutoMerge('', '', '');

            expect(result.success).toBe(true);
            expect(result.content).toBe('');
        });

        it('should return diffs when there are overlaps', () => {
            const base = 'Line 1';
            const local = 'Local line';
            const server = 'Server line';

            const result = resolver.attemptAutoMerge(base, local, server);

            expect(result.hasOverlaps).toBe(true);
            expect(result.diffs).toBeDefined();
            expect(result.diffs!.length).toBeGreaterThan(0);
        });
    });

    describe('resolveConflict', () => {
        const mockConflict: SyncConflict = {
            fileId: 'file-1',
            localVersion: {
                content: 'Local content',
                etag: 'local-etag',
                lastModified: Date.now(),
                version: 1,
            },
            serverVersion: {
                content: 'Server content',
                etag: 'server-etag',
                lastModified: Date.now(),
                version: 2,
            },
            operations: [],
            detectedAt: Date.now(),
        };

        it('should return local version when strategy is "local"', () => {
            const result = resolver.resolveConflict(mockConflict, 'local');

            expect(result.content).toBe('Local content');
            expect(result.version).toBe(3); // max(1,2) + 1
        });

        it('should return server version when strategy is "server"', () => {
            const result = resolver.resolveConflict(mockConflict, 'server');

            expect(result.content).toBe('Server content');
            expect(result.version).toBe(2);
        });

        it('should require merged content for "merge" strategy', () => {
            expect(() => resolver.resolveConflict(mockConflict, 'merge'))
                .toThrow('Merged content required');
        });

        it('should accept merged content for "merge" strategy', () => {
            const result = resolver.resolveConflict(mockConflict, 'merge', 'Merged content');

            expect(result.content).toBe('Merged content');
            expect(result.version).toBe(3);
        });

        it('should throw for unknown strategy', () => {
            expect(() => resolver.resolveConflict(mockConflict, 'unknown' as ResolutionStrategy))
                .toThrow('Unknown resolution strategy');
        });
    });
});
