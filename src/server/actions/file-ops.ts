"use server";

import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";
import { eq, and, isNull, isNotNull, inArray } from "drizzle-orm";
import { generateETagSync } from "@/lib/sync/etag-generator";
import { randomUUID } from "crypto";

export interface UpdateFileOptions {
    expectedVersion?: number;
    expectedETag?: string;
    operationId?: string;
}

export interface FileOpResult<T = typeof schema.files.$inferSelect> {
    success: boolean;
    data?: T;
    error?: string;
    status?: "conflict" | "unauthorized" | "not_found" | "forbidden" | "error";
    etag?: string;
    version?: number;
    serverVersion?: {
        version?: number | null;
        etag?: string | null;
        updatedAt?: string;
        content?: string | null;
    };
}

import { generateRestoredTitle, generateCopyTitle } from "@/lib/utils/file-naming";

/**
 * Fetch all descendant IDs (children, grandchildren, etc.) of a folder
 */
async function getDescendantIds(folderId: string, userId: string): Promise<string[]> {
    const descendantIds: string[] = [];
    const queue: string[] = [folderId];
    const visited = new Set<string>([folderId]);

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        const children = await db.query.files.findMany({
            where: and(
                eq(schema.files.parentFolderId, currentId),
                eq(schema.files.userId, userId),
                isNull(schema.files.deletedAt)
            ),
            columns: { id: true, isFolder: true },
        });

        for (const child of children) {
            if (!visited.has(child.id)) {
                visited.add(child.id);
                descendantIds.push(child.id);
                if (child.isFolder) {
                    queue.push(child.id);
                }
            }
        }
    }

    return descendantIds;
}

/**
 * Create a new file or folder with strict server-side ownership and single-step atomic ETag generation
 */
export async function createFile(
    title: string,
    parentFolderId?: string | null,
    isFolder = false
): Promise<FileOpResult> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const sanitizedTitle = (title || "Untitled Document").trim().slice(0, 500);

        // Validate parent folder ownership and validity if specified
        if (parentFolderId) {
            const parent = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, parentFolderId),
                    eq(schema.files.userId, user.id)
                ),
            });

            if (!parent) {
                return { success: false, status: "not_found", error: "Parent folder not found" };
            }

            if (parent.deletedAt) {
                return { success: false, status: "conflict", error: "Cannot create item in a deleted folder" };
            }

            if (!parent.isFolder) {
                return { success: false, status: "error", error: "Parent destination must be a folder" };
            }
        }

        const newFileId = randomUUID();
        const now = new Date();
        const initialContent = isFolder ? null : "";

        // Single-step atomic ETag generation: eliminates the race window where ETag was briefly null
        const etag = isFolder
            ? null
            : generateETagSync({
                id: newFileId,
                content: initialContent || "",
                updatedAt: now,
            });

        const [file] = await db
            .insert(schema.files)
            .values({
                id: newFileId,
                userId: user.id,
                title: sanitizedTitle,
                parentFolderId: parentFolderId || null,
                isFolder,
                content: initialContent,
                etag,
                version: 1,
                createdAt: now,
                updatedAt: now,
            })
            .returning();

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore during standalone testing
        }

        return { success: true, data: file };

    } catch (error) {
        console.error("Create file error:", error);
        return { success: false, status: "error", error: "Failed to create file" };
    }
}

/**
 * Update file content with optimistic concurrency control (If-Match / expectedVersion)
 */
export async function updateFileContent(
    fileId: string,
    content: string,
    options?: UpdateFileOptions
): Promise<FileOpResult> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const currentFile = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!currentFile) {
            return { success: false, status: "not_found", error: "File not found or deleted" };
        }

        if (currentFile.isFolder) {
            return { success: false, status: "error", error: "Cannot update content of a folder" };
        }

        const currentVersion = currentFile.version ?? 0;

        // Verify optimistic lock precondition if supplied
        if (options?.expectedVersion !== undefined && options.expectedVersion !== currentVersion) {
            return {
                success: false,
                status: "conflict",
                error: "Conflict: this file was modified by another session. Please reload and try again.",
                serverVersion: {
                    version: currentFile.version,
                    etag: currentFile.etag,
                    updatedAt: currentFile.updatedAt.toISOString(),
                    content: currentFile.content,
                },
            };
        }

        if (options?.expectedETag && currentFile.etag && options.expectedETag !== currentFile.etag) {
            return {
                success: false,
                status: "conflict",
                error: "Conflict: ETag mismatch detected.",
                serverVersion: {
                    version: currentFile.version,
                    etag: currentFile.etag,
                    updatedAt: currentFile.updatedAt.toISOString(),
                    content: currentFile.content,
                },
            };
        }

        const baseVersion = options?.expectedVersion ?? currentVersion;
        const newVersion = baseVersion + 1;
        const now = new Date();
        const newEtag = generateETagSync({ id: fileId, content, updatedAt: now });

        // Atomic update conditioned on holding the base version and row not deleted
        const [updated] = await db
            .update(schema.files)
            .set({ content, etag: newEtag, version: newVersion, updatedAt: now })
            .where(and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                eq(schema.files.version, baseVersion),
                isNull(schema.files.deletedAt)
            ))
            .returning();

        if (!updated) {
            // Concurrent writer raced ahead in the read-write window
            const refreshed = await db.query.files.findFirst({
                where: and(eq(schema.files.id, fileId), eq(schema.files.userId, user.id)),
            });

            if (refreshed && !refreshed.deletedAt) {
                return {
                    success: false,
                    status: "conflict",
                    error: "Conflict: this file was modified by another session. Please reload and try again.",
                    serverVersion: {
                        version: refreshed.version,
                        etag: refreshed.etag,
                        updatedAt: refreshed.updatedAt.toISOString(),
                        content: refreshed.content,
                    },
                };
            }

            return { success: false, status: "not_found", error: "File not found or deleted" };
        }

        return { success: true, etag: newEtag, version: newVersion, data: updated };

    } catch (error) {
        console.error("Update file error:", error);
        return { success: false, status: "error", error: "Failed to update file" };
    }
}

/**
 * Rename file or folder
 */
export async function renameFile(
    fileId: string,
    newTitle: string
): Promise<FileOpResult<null>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const sanitizedTitle = newTitle.trim().slice(0, 500);

        const updated = await db
            .update(schema.files)
            .set({
                title: sanitizedTitle,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                )
            );

        if ((updated.rowCount ?? 0) === 0) {
            return { success: false, status: "not_found", error: "File not found or deleted" };
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore during standalone testing
        }

        return { success: true };

    } catch (error) {
        console.error("Rename file error:", error);
        return { success: false, status: "error", error: "Failed to rename file" };
    }
}

/**
 * Delete file or folder with cascading tombstone propagation for all descendants.
 */
export async function deleteFile(
    fileId: string
): Promise<FileOpResult<null>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const target = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id)
            ),
        });

        if (!target) {
            return { success: false, status: "not_found", error: "File not found" };
        }

        const now = new Date();

        // 1. Tombstone target
        await db
            .update(schema.files)
            .set({
                deletedAt: now,
                updatedAt: now,
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id)
                )
            );

        // 2. If target is a folder, cascade soft-delete to all descendants
        if (target.isFolder) {
            const descendantIds = await getDescendantIds(fileId, user.id);
            if (descendantIds.length > 0) {
                await db
                    .update(schema.files)
                    .set({
                        deletedAt: now,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(schema.files.userId, user.id),
                            inArray(schema.files.id, descendantIds)
                        )
                    );
            }
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore during standalone testing
        }

        return { success: true };

    } catch (error) {
        console.error("Delete file error:", error);
        return { success: false, status: "error", error: "Failed to delete file" };
    }
}

/**
 * Restore a soft-deleted file or folder within the retention window.
 * Automatically resolves title collisions by appending `(Restored)` if a live duplicate exists.
 */
export async function restoreFile(
    fileId: string
): Promise<FileOpResult<null>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        // Verify ownership + that the row still exists (not yet purged)
        const target = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id)
            ),
        });

        if (!target) {
            return { success: false, status: "not_found", error: "File not found or permanently deleted" };
        }

        let targetParentId = target.parentFolderId;

        // If target has a deleted or non-existent parent folder, reconnect restored file to root
        if (targetParentId) {
            const parent = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, targetParentId),
                    eq(schema.files.userId, user.id)
                ),
            });

            if (!parent || parent.deletedAt) {
                targetParentId = null;
            }
        }

        // ADV-01 FIX: Check for live name collisions in the destination folder
        let finalTitle = target.title;
        let collisionCounter = 1;

        while (true) {
            const existingLive = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.userId, user.id),
                    targetParentId
                        ? eq(schema.files.parentFolderId, targetParentId)
                        : isNull(schema.files.parentFolderId),
                    eq(schema.files.title, finalTitle),
                    isNull(schema.files.deletedAt)
                ),
            });

            if (!existingLive || existingLive.id === fileId) {
                break;
            }

            finalTitle = generateRestoredTitle(target.title, collisionCounter);
            collisionCounter++;
        }

        // Restore the target row with collision-free title and resolved parent
        const now = new Date();
        await db
            .update(schema.files)
            .set({
                title: finalTitle,
                parentFolderId: targetParentId,
                deletedAt: null,
                updatedAt: now,
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id)
                )
            );

        // If restoring a folder, restore its entire descendant tree as well —
        // symmetric with the cascading tombstone in `deleteFile` (which walks
        // the full recursion). The traversal intentionally does NOT filter by
        // `deletedAt`: after a folder deletion every descendant is tombstoned,
        // so filtering would stop the walk at the first level.
        if (target.isFolder) {
            const descendantIds: string[] = [];
            const queue: string[] = [fileId];
            const visited = new Set<string>([fileId]);

            while (queue.length > 0) {
                const currentId = queue.shift()!;
                const children = await db.query.files.findMany({
                    where: and(
                        eq(schema.files.parentFolderId, currentId),
                        eq(schema.files.userId, user.id)
                    ),
                    columns: { id: true, isFolder: true },
                });

                for (const child of children) {
                    if (!visited.has(child.id)) {
                        visited.add(child.id);
                        descendantIds.push(child.id);
                        if (child.isFolder) {
                            queue.push(child.id);
                        }
                    }
                }
            }

            if (descendantIds.length > 0) {
                await db
                    .update(schema.files)
                    .set({ deletedAt: null, updatedAt: now })
                    .where(
                        and(
                            inArray(schema.files.id, descendantIds),
                            eq(schema.files.userId, user.id)
                        )
                    );
            }
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore during standalone testing
        }

        return { success: true };

    } catch (error) {
        console.error("Restore file error:", error);
        return { success: false, status: "error", error: "Failed to restore file" };
    }
}

/**
 * Copy a file or folder with all its content (Deep Copy for folders)
 * Automatically resolves name collisions with `(Copy)` and enforces max recursion depth.
 */
export async function copyFile(
    fileId: string,
    newParentFolderId?: string | null,
    depth = 0
): Promise<FileOpResult> {
    try {
        const MAX_DEPTH = 20;
        if (depth > MAX_DEPTH) {
            return { success: false, status: "error", error: "Maximum folder nesting depth exceeded during copy" };
        }

        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        // Get original file/folder
        const originalResult = await getFile(fileId);
        if (!originalResult.success || !originalResult.data) {
            return { success: false, status: "not_found", error: "Original file not found" };
        }

        const original = originalResult.data;

        // Validate destination parent folder if specified
        const targetParentId = newParentFolderId !== undefined
            ? newParentFolderId
            : original.parentFolderId;

        if (targetParentId) {
            const destParent = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, targetParentId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });

            if (!destParent) {
                return { success: false, status: "not_found", error: "Destination folder not found" };
            }

            if (!destParent.isFolder) {
                return { success: false, status: "error", error: "Destination must be a folder" };
            }
        }

        // CRIT-02: Find first non-colliding copy title
        let copyTitle = generateCopyTitle(original.title, 1);
        let copyCounter = 1;

        while (true) {
            const existingLive = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.userId, user.id),
                    targetParentId
                        ? eq(schema.files.parentFolderId, targetParentId)
                        : isNull(schema.files.parentFolderId),
                    eq(schema.files.title, copyTitle),
                    isNull(schema.files.deletedAt)
                ),
            });

            if (!existingLive) break;
            copyCounter++;
            copyTitle = generateCopyTitle(original.title, copyCounter);
        }

        const newFileId = randomUUID();
        const now = new Date();

        // Single-step atomic ETag generation
        const etag = original.isFolder
            ? null
            : generateETagSync({
                id: newFileId,
                content: original.content || "",
                updatedAt: now,
            });

        const [copiedFile] = await db
            .insert(schema.files)
            .values({
                id: newFileId,
                userId: user.id,
                title: copyTitle,
                parentFolderId: targetParentId,
                isFolder: original.isFolder,
                content: original.isFolder ? null : original.content,
                etag,
                version: 1,
                createdAt: now,
                updatedAt: now,
            })
            .returning();

        // If it's a folder, recursively copy all children with depth guard
        if (original.isFolder && copiedFile) {
            const childrenResult = await getFolderChildren(fileId);
            if (childrenResult.success && childrenResult.data) {
                for (const child of childrenResult.data) {
                    await copyFile(child.id, copiedFile.id, depth + 1);
                }
            }
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore during standalone testing
        }

        return { success: true, data: copiedFile };

    } catch (error) {
        console.error("Copy file error:", error);
        return { success: false, status: "error", error: "Failed to copy file" };
    }
}

/**
 * Move file or folder to a different folder with cycle and descendant protection
 */
export async function moveFile(
    fileId: string,
    newParentFolderId: string | null
): Promise<FileOpResult<null>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        // Cannot move a folder into itself
        if (fileId === newParentFolderId) {
            return { success: false, status: "conflict", error: "Cannot move a folder into itself" };
        }

        const target = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!target) {
            return { success: false, status: "not_found", error: "File not found or deleted" };
        }

        // Validate target parent folder if moving into a folder
        if (newParentFolderId !== null) {
            const parent = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, newParentFolderId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });

            if (!parent) {
                return { success: false, status: "not_found", error: "Target parent folder not found" };
            }

            if (!parent.isFolder) {
                return { success: false, status: "error", error: "Target destination is not a folder" };
            }

            // Descendant / cycle check: If target is a folder, verify parent is not inside target
            if (target.isFolder) {
                let currentAncestorId: string | null = parent.parentFolderId;
                const visited = new Set<string>([newParentFolderId]);
                let hops = 0;
                const MAX_HOPS = 50;

                while (currentAncestorId && hops < MAX_HOPS) {
                    hops++;
                    if (currentAncestorId === fileId) {
                        return {
                            success: false,
                            status: "conflict",
                            error: "Cannot move a folder into one of its descendants",
                        };
                    }
                    if (visited.has(currentAncestorId)) break;
                    visited.add(currentAncestorId);

                    const ancestor = await db.query.files.findFirst({
                        where: and(
                            eq(schema.files.id, currentAncestorId),
                            eq(schema.files.userId, user.id),
                            isNull(schema.files.deletedAt)
                        ),
                        columns: { parentFolderId: true },
                    });
                    currentAncestorId = ancestor?.parentFolderId ?? null;
                }
            }
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
                    isNull(schema.files.deletedAt)
                )
            );

        if ((updated.rowCount ?? 0) === 0) {
            return { success: false, status: "not_found", error: "File not found or deleted" };
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore during standalone testing
        }

        return { success: true };

    } catch (error) {
        console.error("Move file error:", error);
        return { success: false, status: "error", error: "Failed to move file" };
    }
}

/**
 * Get single file by ID
 */
export async function getFile(
    fileId: string
): Promise<FileOpResult> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const file = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!file) {
            return { success: false, status: "not_found", error: "File not found" };
        }

        return { success: true, data: file };

    } catch (error) {
        console.error("Get file error:", error);
        return { success: false, status: "error", error: "Failed to get file" };
    }
}

/**
 * Get all user files (for building tree structure on client)
 */
export async function getUserFiles(): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

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
        return { success: false, status: "error", error: "Failed to get files" };
    }
}

/**
 * Get root level files (no parent folder)
 */
export async function getRootFiles(): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                isNull(schema.files.parentFolderId),
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc, asc }) => [desc(files.isFolder), asc(files.title)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get root files error:", error);
        return { success: false, status: "error", error: "Failed to get files" };
    }
}

/**
 * Get children of a folder
 */
export async function getFolderChildren(
    folderId: string
): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                eq(schema.files.parentFolderId, folderId),
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc, asc }) => [desc(files.isFolder), asc(files.title)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get folder children error:", error);
        return { success: false, status: "error", error: "Failed to get folder contents" };
    }
}

/**
 * List soft-deleted (tombstoned) files and folders owned by the user.
 */
export async function getDeletedFiles(): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
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
        return { success: false, status: "error", error: "Failed to get deleted files" };
    }
}
