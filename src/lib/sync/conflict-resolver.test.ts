/**
 * Conflict Resolver Tests
 * 
 * Phase 4 Comprehensive Tests for Three-Way Conflict Resolution:
 * - Rejection of merge when base snapshot is missing (manual_resolution_required)
 * - Three-way merge of non-overlapping changes with real base
 * - Explicit conflict markers generation on overlaps without silent overwrite
 * - Metadata & rename (title, parentFolderId) merging
 * - Delete vs update conflicts (remote deleted vs local modified, local deleted vs remote modified)
 * - All resolution strategies (local, server, merge, restore, delete)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictResolver, ResolutionStrategy } from './conflict-resolver';
import { IDBFile, SyncConflict } from './idb-types';

describe('Conflict Resolver - Phase 4 Three-Way Conflict Resolution', () => {
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
        it('should create SyncConflict object with baseVersion snapshot', () => {
            const localFile: IDBFile = {
                id: 'file-1',
                content: 'Local content',
                etag: 'local-etag',
                version: 2,
                title: 'Local Title',
                parentFolderId: null,
                isFolder: false,
                isDirty: true,
                lastModified: Date.now(),
                lastSyncedAt: Date.now() - 5000,
                baseSnapshot: {
                    content: 'Base content',
                    etag: 'base-etag',
                    version: 1,
                    title: 'Base Title',
                    parentFolderId: null,
                },
            };

            const serverData = {
                content: 'Server content',
                etag: 'server-etag',
                version: 2,
                title: 'Server Title',
                parentFolderId: null,
                updatedAt: new Date().toISOString(),
                deleted: false,
            };

            const conflict = resolver.createConflict(localFile, serverData);

            expect(conflict.fileId).toBe('file-1');
            expect(conflict.localVersion.content).toBe('Local content');
            expect(conflict.serverVersion.content).toBe('Server content');
            expect(conflict.baseVersion).toBeDefined();
            expect(conflict.baseVersion?.content).toBe('Base content');
            expect(conflict.baseVersion?.version).toBe(1);
            expect(conflict.type).toBe('content');
            expect(conflict.detectedAt).toBeDefined();
        });

        it('should mark conflict type as delete_conflict when server deleted the file', () => {
            const localFile: IDBFile = {
                id: 'file-1',
                content: 'Local edits on deleted file',
                etag: 'etag-1',
                version: 1,
                title: 'My Doc',
                parentFolderId: null,
                isFolder: false,
                isDirty: true,
                lastModified: Date.now(),
                lastSyncedAt: 0,
            };

            const serverData = {
                content: '',
                etag: 'etag-del',
                version: 2,
                updatedAt: new Date().toISOString(),
                deleted: true,
            };

            const conflict = resolver.createConflict(localFile, serverData);
            expect(conflict.type).toBe('delete_conflict');
            expect(conflict.serverVersion.deleted).toBe(true);
        });
    });

    describe('Base Snapshot Enforcement & Three-Way Content Merging', () => {
        it('should reject auto-merge when base is null or undefined (manual_resolution_required)', () => {
            const resultUndefined = resolver.attemptAutoMerge(undefined, 'Local text', 'Server text');
            expect(resultUndefined.success).toBe(false);
            expect(resultUndefined.status).toBe('manual_resolution_required');
            expect(resultUndefined.hasOverlaps).toBe(true);
            expect(resultUndefined.reason).toContain('Base snapshot missing');

            const resultNull = resolver.attemptAutoMerge(null, 'Local text', 'Server text');
            expect(resultNull.success).toBe(false);
            expect(resultNull.status).toBe('manual_resolution_required');

            const resultStructured = resolver.attemptThreeWayMerge({
                base: null,
                local: { content: 'Local text' },
                remote: { content: 'Server text' },
            });
            expect(resultStructured.success).toBe(false);
            expect(resultStructured.status).toBe('manual_resolution_required');
        });

        it('should successfully merge non-overlapping changes with real base snapshot', () => {
            const base = 'Heading\nLine 1\nLine 2\nFooter';
            const local = 'Heading modified\nLine 1\nLine 2\nFooter';
            const remote = 'Heading\nLine 1\nLine 2\nFooter modified';

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.hasOverlaps).toBe(false);
            expect(result.content).toContain('Heading modified');
            expect(result.content).toContain('Footer modified');
        });

        it('should detect overlapping changes and generate explicit conflict markers without silent overwrite', () => {
            const base = 'Section 1\nShared Line\nSection 3';
            const local = 'Section 1\nLocal Change\nSection 3';
            const remote = 'Section 1\nRemote Change\nSection 3';

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe('conflict_overlaps');
            expect(result.hasOverlaps).toBe(true);
            expect(result.conflictMarkers).toBeDefined();
            expect(result.conflictMarkers).toContain('<<<<<<< LOCAL');
            expect(result.conflictMarkers).toContain('Local Change');
            expect(result.conflictMarkers).toContain('=======');
            expect(result.conflictMarkers).toContain('Remote Change');
            expect(result.conflictMarkers).toContain('>>>>>>> REMOTE');
        });

        it('should resolve cleanly when both sides made identical modifications', () => {
            const base = 'Original Line';
            const local = 'Identical Modification';
            const remote = 'Identical Modification';

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.content).toBe('Identical Modification');
        });

        it('should handle HTML and TipTap paragraph blocks cleanly', () => {
            const base = '<p>Paragraph 1</p>\n<p>Paragraph 2</p>\n<p>Paragraph 3</p>';
            const local = '<p>Paragraph 1 modified</p>\n<p>Paragraph 2</p>\n<p>Paragraph 3</p>';
            const remote = '<p>Paragraph 1</p>\n<p>Paragraph 2</p>\n<p>Paragraph 3 added remote</p>';

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.content).toContain('<p>Paragraph 1 modified</p>');
            expect(result.content).toContain('<p>Paragraph 3 added remote</p>');
        });

        it('Adversarial Test: should merge cleanly when local inserts at top and remote edits at bottom without false positional conflict', () => {
            const baseLines: string[] = [];
            for (let i = 1; i <= 20; i++) {
                baseLines.push(`Paragraph ${i}: stable content`);
            }
            const base = baseLines.join('\n');

            // Local inserts a new header at line 0 (offsetting all subsequent lines)
            const local = `[NEW HEADER INSERTED AT TOP]\n${base}`;

            // Remote modifies only the last paragraph (line 20)
            const remoteLines = [...baseLines];
            remoteLines[19] = 'Paragraph 20: remote modified text at bottom';
            const remote = remoteLines.join('\n');

            const result = resolver.attemptThreeWayMerge({
                base: { content: base },
                local: { content: local },
                remote: { content: remote },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.hasOverlaps).toBe(false);
            expect(result.content).toContain('[NEW HEADER INSERTED AT TOP]');
            expect(result.content).toContain('Paragraph 1: stable content');
            expect(result.content).toContain('Paragraph 20: remote modified text at bottom');
        });
    });

    describe('Metadata & Rename Merging', () => {
        it('should accept local rename if remote did not change title', () => {
            const result = resolver.attemptThreeWayMerge({
                base: { content: 'Content', title: 'Original Title' },
                local: { content: 'Content', title: 'Local New Title' },
                remote: { content: 'Content', title: 'Original Title' },
            });

            expect(result.success).toBe(true);
            expect(result.title).toBe('Local New Title');
        });

        it('should accept remote rename if local did not change title', () => {
            const result = resolver.attemptThreeWayMerge({
                base: { content: 'Content', title: 'Original Title' },
                local: { content: 'Content', title: 'Original Title' },
                remote: { content: 'Content', title: 'Remote New Title' },
            });

            expect(result.success).toBe(true);
            expect(result.title).toBe('Remote New Title');
        });

        it('should flag conflict when both sides renamed title differently', () => {
            const result = resolver.attemptThreeWayMerge({
                base: { content: 'Content', title: 'Original Title' },
                local: { content: 'Content', title: 'Local New Title' },
                remote: { content: 'Content', title: 'Remote New Title' },
            });

            expect(result.success).toBe(false);
            expect(result.hasOverlaps).toBe(true);
            expect(result.status).toBe('conflict_overlaps');
        });

        it('should merge folder move when only one side moved', () => {
            const result = resolver.attemptThreeWayMerge({
                base: { content: 'Content', parentFolderId: 'folder-root' },
                local: { content: 'Content', parentFolderId: 'folder-archive' },
                remote: { content: 'Content', parentFolderId: 'folder-root' },
            });

            expect(result.success).toBe(true);
            expect(result.parentFolderId).toBe('folder-archive');
        });
    });

    describe('Delete vs Update Conflict Handling', () => {
        it('should detect remote delete vs local modification without silent overwrite', () => {
            const result = resolver.attemptThreeWayMerge({
                base: { content: 'Original text' },
                local: { content: 'Local modified text', deleted: false },
                remote: { content: '', deleted: true },
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe('delete_conflict');
            expect(result.deleteAction).toBe('remote_deleted_local_modified');
            expect(result.hasOverlaps).toBe(true);
        });

        it('should detect local delete vs remote modification', () => {
            const result = resolver.attemptThreeWayMerge({
                base: { content: 'Original text' },
                local: { content: '', deleted: true },
                remote: { content: 'Server updated text', deleted: false },
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe('delete_conflict');
            expect(result.deleteAction).toBe('local_deleted_remote_modified');
        });

        it('should resolve cleanly when both sides deleted the file', () => {
            const result = resolver.attemptThreeWayMerge({
                base: { content: 'Original text' },
                local: { content: '', deleted: true },
                remote: { content: '', deleted: true },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('merged_clean');
            expect(result.deleteAction).toBe('both_deleted');
        });
    });

    describe('resolveConflict Strategies', () => {
        const mockConflict: SyncConflict = {
            fileId: 'file-1',
            localVersion: {
                content: 'Local content',
                etag: 'local-etag',
                lastModified: Date.now(),
                version: 1,
                title: 'Local Title',
            },
            serverVersion: {
                content: 'Server content',
                etag: 'server-etag',
                lastModified: Date.now(),
                version: 2,
                title: 'Server Title',
            },
            operations: [],
            detectedAt: Date.now(),
        };

        it('should return local version when strategy is "local"', () => {
            const result = resolver.resolveConflict(mockConflict, 'local');

            expect(result.content).toBe('Local content');
            expect(result.title).toBe('Local Title');
            expect(result.version).toBe(3); // max(1,2) + 1
            expect(result.deleted).toBe(false);
        });

        it('should return server version when strategy is "server"', () => {
            const result = resolver.resolveConflict(mockConflict, 'server');

            expect(result.content).toBe('Server content');
            expect(result.title).toBe('Server Title');
            expect(result.version).toBe(2);
        });

        it('should accept merged content for "merge" strategy', () => {
            const result = resolver.resolveConflict(mockConflict, 'merge', 'Merged content', 'Merged Title');

            expect(result.content).toBe('Merged content');
            expect(result.title).toBe('Merged Title');
            expect(result.version).toBe(3);
        });

        it('should restore local content for "restore" strategy', () => {
            const result = resolver.resolveConflict(mockConflict, 'restore');

            expect(result.content).toBe('Local content');
            expect(result.version).toBe(3);
            expect(result.deleted).toBe(false);
        });

        it('should mark deleted for "delete" strategy', () => {
            const result = resolver.resolveConflict(mockConflict, 'delete');

            expect(result.deleted).toBe(true);
            expect(result.content).toBe('');
        });
    });
});

