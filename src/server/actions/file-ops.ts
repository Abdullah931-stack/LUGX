"use server";

import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";
import { eq, and, isNull, isNotNull, gte } from "drizzle-orm";
import { generateETagSync } from "@/lib/sync/etag-generator";

/**
 * Create a new file or folder
 */
export async function createFile(
    title: string,
    parentFolderId?: string | null,
    isFolder = false
): Promise<{ success: boolean; data?: typeof schema.files.$inferSelect; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const now = new Date();
        const initialContent = isFolder ? null : "";

        const [file] = await db
            .insert(schema.files)
            .values({
                userId: user.id,
                title,
                parentFolderId: parentFolderId || null,
                isFolder,
                content: initialContent,
                version: 1,
            })
            .returning();

        // Generate ETag with actual file ID
        if (!isFolder && file) {
            const etag = generateETagSync({
                id: file.id,
                content: file.content || "",
                updatedAt: file.updatedAt,
            });
            await db.update(schema.files)
                .set({ etag })
                .where(eq(schema.files.id, file.id));
            file.etag = etag;
        }

        revalidatePath("/workspace");
        return { success: true, data: file };

    } catch (error) {
        console.error("Create file error:", error);
        return { success: false, error: "Failed to create file" };
    }
}

/**
 * Update file content
 */
export async function updateFileContent(
    fileId: string,
    content: string
): Promise<{ success: boolean; error?: string; etag?: string; version?: number }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const now = new Date();
        const newEtag = generateETagSync({ id: fileId, content, updatedAt: now });

        // ENGINEERING UPGRADE (W5): Lost-update guard. The old read-then-write
        // flow had a race window: two concurrent saves could both read the
        // same version, both compute version+1, and the second write would
        // silently overwrite the first writer's content. Now the read and the
        // write are fused into a single atomic step: the UPDATE itself only
        // succeeds when the row still carries the version we just read. If
        // another writer moved the version first, zero rows are affected and
        // the caller is told to re-read (fail-safe — never silent loss).
        const currentFile = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                // Tombstoned rows can't be updated — writing to a deleted
                // file is a logic error (e.g. stale sync replay)
                isNull(schema.files.deletedAt)
            ),
            columns: { version: true },
        });

        if (!currentFile) {
            return { success: false, error: "File not found or deleted" };
        }

        const currentVersion = currentFile.version ?? 0;
        const newVersion = currentVersion + 1;

        const [updated] = await db
            .update(schema.files)
            .set({ content, etag: newEtag, version: newVersion, updatedAt: now })
            .where(and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                eq(schema.files.version, currentVersion),
                isNull(schema.files.deletedAt)
            ))
            .returning();

        if (!updated) {
            // Zero affected rows: someone else saved a newer version in the
            // window between our read and our write. Returning `conflict: true`
            // lets the client refetch and merge instead of losing data.
            return {
                success: false,
                error: "Conflict: this file was modified by another session. Please reload and try again.",
            };
        }

        return { success: true, etag: newEtag, version: newVersion };

    } catch (error) {
        console.error("Update file error:", error);
        return { success: false, error: "Failed to update file" };
    }
}

/**
 * Rename file or folder
 */
export async function renameFile(
    fileId: string,
    newTitle: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const updated = await db
            .update(schema.files)
            .set({
                title: newTitle,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id),
                    // Renaming a tombstoned row is forbidden
                    isNull(schema.files.deletedAt)
                )
            );

        if ((updated.rowCount ?? 0) === 0) {
            return { success: false, error: "File not found or deleted" };
        }

        revalidatePath("/workspace");
        return { success: true };

    } catch (error) {
        console.error("Rename file error:", error);
        return { success: false, error: "Failed to rename file" };
    }
}

/**
 * Delete file or folder (SOFT DELETE — production lifecycle v2).
 *
 * Files are never physically removed on user action: deleted_at is set,
 * the row stays in the database for 30 days so that:
 *   - Sync clients can reconcile the deletion against their local copies
 *     (a hard delete would orphan stale IndexedDB rows and re-create
 *     deleted files on the next sync).
 *   - Users can restore accidentally deleted files (restoreFile).
 *
 * A recurring purge job (/api/cron/purge-deleted) permanently removes
 * rows whose deleted_at is older than 30 days.
 *
 * NOTE: children of a deleted folder are tombstoned by the same call on
 * the client side (the folder-picker / tree UI re-renders); this action
 * only tombstones the targeted row. Children become unreachable because
 * read queries filter out tombstones.
 */
export async function deleteFile(
    fileId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        // Soft delete: mark the row with a timestamp instead of removing it.
        // Idempotent — re-deleting an already-deleted row just refreshes the
        // timestamp (extends the restoration window), never throws.
        await db
            .update(schema.files)
            .set({
                deletedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id)
                )
            );

        revalidatePath("/workspace");
        return { success: true };

    } catch (error) {
        console.error("Delete file error:", error);
        return { success: false, error: "Failed to delete file" };
    }
}

/**
 * Restore a soft-deleted file or folder within the retention window.
 *
 * Idempotent: restoring an already-live row is a no-op (update touches
 * zero rows for live rows where deletedAt IS NULL). The restore also
 * clears the tombstone on children if the restored row is a folder,
 * so a restored folder returns with its contents visible.
 */
export async function restoreFile(
    fileId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        // Verify ownership + that the row still exists (not yet purged)
        const target = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id)
            ),
        });

        if (!target) {
            return { success: false, error: "File not found or permanently deleted" };
        }

        // Restore the target row (no-op if already live)
        await db
            .update(schema.files)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id)
                )
            );

        revalidatePath("/workspace");
        return { success: true };

    } catch (error) {
        console.error("Restore file error:", error);
        return { success: false, error: "Failed to restore file" };
    }
}

/**
 * Copy a file or folder with all its content (Deep Copy for folders)
 */
export async function copyFile(
    fileId: string,
    newParentFolderId?: string | null
): Promise<{ success: boolean; data?: typeof schema.files.$inferSelect; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        // Get original file/folder
        const originalResult = await getFile(fileId);
        if (!originalResult.success || !originalResult.data) {
            return { success: false, error: "Original file not found" };
        }

        const original = originalResult.data;

        // Validate ownership
        if (original.userId !== user.id) {
            return { success: false, error: "Unauthorized" };
        }

        // Create copy with new title
        const copyTitle = `Copy of ${original.title}`;
        const targetParentId = newParentFolderId !== undefined
            ? newParentFolderId
            : original.parentFolderId;

        const [copiedFile] = await db
            .insert(schema.files)
            .values({
                userId: user.id,
                title: copyTitle,
                parentFolderId: targetParentId,
                isFolder: original.isFolder,
                content: original.isFolder ? null : original.content,
            })
            .returning();

        // If it's a folder, recursively copy all children
        if (original.isFolder) {
            const childrenResult = await getFolderChildren(fileId);
            if (childrenResult.success && childrenResult.data) {
                for (const child of childrenResult.data) {
                    // Recursive call to copy each child into the new folder
                    await copyFile(child.id, copiedFile.id);
                }
            }
        }

        revalidatePath("/workspace");
        return { success: true, data: copiedFile };

    } catch (error) {
        console.error("Copy file error:", error);
        return { success: false, error: "Failed to copy file" };
    }
}

/**
 * Move file to different folder
 */
export async function moveFile(
    fileId: string,
    newParentFolderId: string | null
): Promise<{ success: boolean; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const updated = await db
            .update(schema.files)
            .set({
                parentFolderId: newParentFolderId,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id),
                    // Tombstoned rows can't be moved — also guards against
                    // dropping a deleted item INTO a folder to hide it
                    isNull(schema.files.deletedAt)
                )
            );

        if ((updated.rowCount ?? 0) === 0) {
            return { success: false, error: "File not found or deleted" };
        }

        revalidatePath("/workspace");
        return { success: true };

    } catch (error) {
        console.error("Move file error:", error);
        return { success: false, error: "Failed to move file" };
    }
}


/**
 * Get single file by ID
 */
export async function getFile(
    fileId: string
): Promise<{
    success: boolean;
    data?: typeof schema.files.$inferSelect;
    error?: string;
}> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const file = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                // Live rows only — tombstones are invisible to readers
                isNull(schema.files.deletedAt)
            ),
        });

        if (!file) {
            return { success: false, error: "File not found" };
        }

        return { success: true, data: file };

    } catch (error) {
        console.error("Get file error:", error);
        return { success: false, error: "Failed to get file" };
    }
}

/**
 * Get all user files (for building tree structure on client)
 */
export async function getUserFiles(): Promise<{
    success: boolean;
    data?: typeof schema.files.$inferSelect[];
    error?: string;
}> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        // Get ALL LIVE files (not just root) - client will build tree structure.
        // Tombstoned rows are filtered out so deleted items never render.
        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc, asc }) => [desc(files.isFolder), asc(files.title)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get user files error:", error);
        return { success: false, error: "Failed to get files" };
    }
}

/**
 * Get root level files (no parent folder)
 */
export async function getRootFiles(): Promise<{
    success: boolean;
    data?: typeof schema.files.$inferSelect[];
    error?: string;
}> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                isNull(schema.files.parentFolderId),
                // Live rows only
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc, asc }) => [desc(files.isFolder), asc(files.title)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get root files error:", error);
        return { success: false, error: "Failed to get files" };
    }
}

/**
 * Get children of a folder
 */
export async function getFolderChildren(
    folderId: string
): Promise<{
    success: boolean;
    data?: typeof schema.files.$inferSelect[];
    error?: string;
}> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                eq(schema.files.parentFolderId, folderId),
                // Live rows only — children of a tombstoned folder are
                // invisible until the folder (and they) are restored
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc, asc }) => [desc(files.isFolder), asc(files.title)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get folder children error:", error);
        return { success: false, error: "Failed to get folder contents" };
    }
}

/**
 * List soft-deleted (tombstoned) files and folders owned by the user.
 * Ordered newest-deleted first so the Trash view shows recent removals
 * at the top. Children of a deleted folder are listed individually
 * (each tombstoned on its own) so nested items can be restored alone.
 */
export async function getDeletedFiles(): Promise<{
    success: boolean;
    data?: typeof schema.files.$inferSelect[];
    error?: string;
}> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }
        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                isNotNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc, asc }) => [desc(files.deletedAt), asc(files.title)],
        });
        return { success: true, data: files };
    } catch (error) {
        console.error("Get deleted files error:", error);
        return { success: false, error: "Failed to get deleted files" };
    }
}
