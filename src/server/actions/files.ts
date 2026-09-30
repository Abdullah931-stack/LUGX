"use server";

import { revalidatePath } from "next/cache";
import { db, schema, type FileEncryptionMetadata } from "@/server/db";
import { requireAuthenticatedUser } from "@/server/auth/session";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { generateETagSync, normalizeMarkdownSource } from "@/lib/sync/etag-generator";
import { randomUUID } from "crypto";
import { generateRestoredTitle, generateCopyTitle } from "@/lib/utils/file-naming";
import { getDescendantIds, isDescendantOf } from "./folders";

export interface UpdateFileOptions {
    expectedVersion?: number;
    expectedETag?: string;
    operationId?: string;
}

export interface DeleteFileOptions {
    expectedVersion?: number;
    expectedETag?: string;
}

export interface FileOpResult<T = typeof schema.files.$inferSelect> {
    success: boolean;
    data?: T;
    error?: string;
    status?: "conflict" | "unauthorized" | "not_found" | "forbidden" | "error";
    etag?: string;
    version?: number;
    correlationId?: string;
    operationId?: string;
    serverVersion?: {
        version?: number | null;
        etag?: string | null;
        updatedAt?: string;
        content?: string | null;
        isEncrypted?: boolean | null;
        encryptionMetadata?: FileEncryptionMetadata | null;
    };
}

/**
 * Create a new file or folder with strict server-side ownership and atomic ETag generation.
 * Enforces title truncation at 500 characters to comply with PostgreSQL varchar(500) limit.
 */
export async function createFile(
    title: string,
    parentFolderId?: string | null,
    isFolder = false
): Promise<FileOpResult> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const sanitizedTitle = (title || "Untitled Document").trim().slice(0, 500);

        // Validate parent folder ownership and validity if specified
        if (parentFolderId) {
            const parent = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, parentFolderId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });

            if (!parent) {
                return { success: false, status: "not_found", error: "Parent folder not found" };
            }

            if (!parent.isFolder) {
                return { success: false, status: "error", error: "Target parent is not a folder" };
            }
        }

        const newId = randomUUID();
        const now = new Date();
        const initialEtag = generateETagSync({ id: newId, content: "", updatedAt: now });

        const [newFile] = await db
            .insert(schema.files)
            .values({
                id: newId,
                userId: user.id,
                title: sanitizedTitle,
                content: "",
                isFolder,
                parentFolderId: parentFolderId || null,
                etag: initialEtag,
                version: 1,
                createdAt: now,
                updatedAt: now,
            })
            .returning();

        try {
            revalidatePath("/workspace");
        } catch {
            // Standalone test context
        }

        return { success: true, data: newFile };

    } catch (error) {
        console.error("Create file error:", error);
        return { success: false, status: "error", error: "Failed to create file" };
    }
}

/**
 * Update file content with optimistic concurrency control (If-Match / expectedVersion).
 */
export async function updateFileContent(
    fileId: string,
    content: string,
    options?: UpdateFileOptions
): Promise<FileOpResult> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
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

        if (currentFile.isEncrypted) {
            return {
                success: false,
                status: "error",
                error: "Cannot directly update encrypted file with plaintext. Use toggleFileEncryption or encrypted envelope pipeline.",
            };
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
                    isEncrypted: currentFile.isEncrypted,
                    encryptionMetadata: currentFile.encryptionMetadata,
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
                    isEncrypted: currentFile.isEncrypted,
                    encryptionMetadata: currentFile.encryptionMetadata,
                },
            };
        }

        const normalizedContent = normalizeMarkdownSource(content);
        const baseVersion = options?.expectedVersion ?? currentVersion;
        const newVersion = baseVersion + 1;
        const now = new Date();
        const newEtag = generateETagSync({ id: fileId, content: normalizedContent, updatedAt: now });

        // Atomic update conditioned on holding the base version and row not deleted
        const [updated] = await db
            .update(schema.files)
            .set({ content: normalizedContent, etag: newEtag, version: newVersion, updatedAt: now })
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
                        isEncrypted: refreshed.isEncrypted,
                        encryptionMetadata: refreshed.encryptionMetadata,
                    },
                };
            }

            return { success: false, status: "not_found", error: "File not found or deleted during update" };
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Standalone test context
        }

        return {
            success: true,
            data: updated,
            etag: updated.etag || undefined,
            version: updated.version ?? undefined,
            operationId: options?.operationId,
        };

    } catch (error) {
        console.error("Update file content error:", error);
        return { success: false, status: "error", error: "Failed to update file content" };
    }
}

/**
 * Toggle file encryption status with zero-knowledge envelope validation.
 * Remediates LUGX-070: strictly rejects isEncrypted: true when encryptionMetadata lacks IV.
 */
export async function toggleFileEncryption(
    fileId: string,
    isEncrypted: boolean,
    content: string,
    encryptionMetadata: FileEncryptionMetadata | null,
    options?: UpdateFileOptions
): Promise<FileOpResult> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
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
            return { success: false, status: "error", error: "Cannot toggle encryption on a folder" };
        }

        const currentVersion = currentFile.version ?? 0;

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
                    isEncrypted: currentFile.isEncrypted,
                    encryptionMetadata: currentFile.encryptionMetadata,
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
                    isEncrypted: currentFile.isEncrypted,
                    encryptionMetadata: currentFile.encryptionMetadata,
                },
            };
        }

        const effectiveMetadata = isEncrypted
            ? (encryptionMetadata !== undefined && encryptionMetadata !== null ? encryptionMetadata : currentFile.encryptionMetadata)
            : null;

        // LUGX-070 remediation: Server must reject isEncrypted: true with missing IV
        if (isEncrypted && (!effectiveMetadata || !effectiveMetadata.iv)) {
            return {
                success: false,
                status: "error",
                error: "Encrypted files require valid encryptionMetadata with an IV",
            };
        }

        const now = new Date();
        const baseVersion = options?.expectedVersion ?? currentVersion;
        const newVersion = baseVersion + 1;

        // Never run markdown normalization on raw ciphertext
        const normalizedContent = isEncrypted ? content : normalizeMarkdownSource(content);

        const newEtag = generateETagSync({
            id: fileId,
            content: normalizedContent,
            updatedAt: now,
            isEncrypted,
            envelope: isEncrypted && effectiveMetadata ? {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: effectiveMetadata.keyId ?? 'master-v1',
                salt: effectiveMetadata.salt ?? '',
                iv: effectiveMetadata.iv,
                kdfIterations: effectiveMetadata.kdfIterations ?? 600000,
                ciphertext: normalizedContent,
            } : undefined,
        });

        const [updated] = await db
            .update(schema.files)
            .set({
                content: normalizedContent,
                isEncrypted,
                encryptionMetadata: effectiveMetadata,
                etag: newEtag,
                version: newVersion,
                updatedAt: now,
            })
            .where(and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                eq(schema.files.version, baseVersion),
                isNull(schema.files.deletedAt)
            ))
            .returning();

        if (!updated) {
            return { success: false, status: "conflict", error: "Conflict updating file encryption" };
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Standalone test context
        }

        return {
            success: true,
            data: updated,
            etag: updated.etag || undefined,
            version: updated.version ?? undefined,
            operationId: options?.operationId,
        };

    } catch (error) {
        console.error("Toggle file encryption error:", error);
        return { success: false, status: "error", error: "Failed to toggle file encryption" };
    }
}

/**
 * Rename a file or folder. Enforces title length within 500 characters (LUGX-138).
 */
export async function renameFile(
    fileId: string,
    newTitle: string
): Promise<FileOpResult> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const sanitizedTitle = (newTitle || "").trim().slice(0, 500);
        if (!sanitizedTitle) {
            return { success: false, status: "error", error: "Title cannot be empty" };
        }

        const current = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!current) {
            return { success: false, status: "not_found", error: "File not found or deleted" };
        }

        const now = new Date();
        const [updated] = await db
            .update(schema.files)
            .set({
                title: sanitizedTitle,
                updatedAt: now,
                version: (current.version || 0) + 1,
            })
            .where(and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ))
            .returning();

        try {
            revalidatePath("/workspace");
        } catch {
            // Standalone test context
        }

        return { success: true, data: updated };

    } catch (error) {
        console.error("Rename file error:", error);
        return { success: false, status: "error", error: "Failed to rename file" };
    }
}

/**
 * Delete file or folder with optimistic concurrency control and cascading tombstone propagation.
 * Remediates Phase 8 Step 4 by enforcing expectedVersion verification when provided.
 */
export async function deleteFile(
    fileId: string,
    options?: DeleteFileOptions
): Promise<FileOpResult<null>> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const target = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!target) {
            return { success: false, status: "not_found", error: "File not found or already deleted" };
        }

        // Optimistic concurrency precondition check
        if (options?.expectedVersion !== undefined && target.version !== options.expectedVersion) {
            return {
                success: false,
                status: "conflict",
                error: "Conflict: file version mismatch during deletion",
                serverVersion: {
                    version: target.version,
                    etag: target.etag,
                    updatedAt: target.updatedAt.toISOString(),
                },
            };
        }

        if (options?.expectedETag && target.etag && target.etag !== options.expectedETag) {
            return {
                success: false,
                status: "conflict",
                error: "Conflict: ETag mismatch during deletion",
                serverVersion: {
                    version: target.version,
                    etag: target.etag,
                    updatedAt: target.updatedAt.toISOString(),
                },
            };
        }

        const now = new Date();
        const newVersion = (target.version || 0) + 1;

        // 1. Tombstone target atomically
        await db
            .update(schema.files)
            .set({
                deletedAt: now,
                updatedAt: now,
                version: newVersion,
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
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
            // Standalone test context
        }

        return { success: true };

    } catch (error) {
        console.error("Delete file error:", error);
        return { success: false, status: "error", error: "Failed to delete file" };
    }
}

/**
 * Restore a soft-deleted file or folder within the retention window.
 * Resolves title collisions and detaches to root if parent folder was deleted.
 */
export async function restoreFile(
    fileId: string
): Promise<FileOpResult> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
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

        if (!target.deletedAt) {
            return { success: false, status: "error", error: "File is not deleted" };
        }

        // Validate parent folder status; if parent is deleted or missing, detach to root
        let finalParentId = target.parentFolderId;
        if (finalParentId) {
            const parent = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, finalParentId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });
            if (!parent) {
                finalParentId = null;
            }
        }

        // Resolve title collisions against live files
        let finalTitle = target.title;
        let collisionCounter = 1;

        while (true) {
            const duplicate = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.userId, user.id),
                    finalParentId
                        ? eq(schema.files.parentFolderId, finalParentId)
                        : isNull(schema.files.parentFolderId),
                    eq(schema.files.title, finalTitle),
                    isNull(schema.files.deletedAt)
                ),
            });

            if (!duplicate) break;
            finalTitle = generateRestoredTitle(target.title, collisionCounter);
            collisionCounter++;
        }

        const now = new Date();
        const [restored] = await db
            .update(schema.files)
            .set({
                title: finalTitle,
                parentFolderId: finalParentId,
                deletedAt: null,
                updatedAt: now,
                version: (target.version || 0) + 1,
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id)
                )
            )
            .returning();

        // If target is a folder, restore its descendants
        if (target.isFolder) {
            const descendantIds = await getDescendantIds(fileId, user.id);
            if (descendantIds.length > 0) {
                await db
                    .update(schema.files)
                    .set({ deletedAt: null, updatedAt: now })
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
            // Standalone test context
        }

        return { success: true, data: restored };

    } catch (error) {
        console.error("Restore file error:", error);
        return { success: false, status: "error", error: "Failed to restore file" };
    }
}

/**
 * Copy file or folder to a target destination.
 * Remediates LUGX-072:
 * 1. Hardcodes depth internally to avoid negative depth bypass attacks.
 * 2. Prohibits copying a folder into itself or into any of its subfolders.
 * 3. Enforces title truncation within 500 characters (LUGX-138).
 */
export async function copyFile(
    fileId: string,
    newParentFolderId?: string | null,
    depth = 0,
    encryptedOverride?: {
        newFileId?: string;
        content?: string;
        encryptionMetadata?: FileEncryptionMetadata | null;
    }
): Promise<FileOpResult> {
    try {
        const MAX_DEPTH = 20;
        // Clamp depth to positive integer preventing bypass via negative numbers
        const sanitizedDepth = Math.max(0, depth);
        if (sanitizedDepth > MAX_DEPTH) {
            return { success: false, status: "error", error: "Maximum folder nesting depth exceeded during copy" };
        }

        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        // Get original file/folder
        const original = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!original) {
            return { success: false, status: "not_found", error: "Original file not found" };
        }

        // Zero-knowledge security guard: If file is encrypted and no client-side re-encrypted payload is provided, block copy
        if (original.isEncrypted && !encryptedOverride) {
            return {
                success: false,
                status: "error",
                error: "Encrypted files require client-side re-encryption with a unique authentication tag. Please copy via the workspace UI.",
            };
        }

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

            // LUGX-072: Prevent copying folder into itself or any of its descendants
            if (original.isFolder) {
                if (targetParentId === fileId) {
                    return { success: false, status: "conflict", error: "Cannot copy a folder into itself" };
                }
                const isDescendant = await isDescendantOf(targetParentId, fileId, user.id);
                if (isDescendant) {
                    return { success: false, status: "conflict", error: "Cannot copy a folder into one of its descendants" };
                }
            }
        }

        // Find first non-colliding copy title
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

        const newFileId = (original.isEncrypted && encryptedOverride?.newFileId)
            ? encryptedOverride.newFileId
            : randomUUID();
        const now = new Date();

        const finalContent = original.isFolder
            ? null
            : (encryptedOverride?.content !== undefined ? encryptedOverride.content : (original.content || ""));

        const finalMetadata = original.isEncrypted
            ? (encryptedOverride?.encryptionMetadata !== undefined ? encryptedOverride.encryptionMetadata : original.encryptionMetadata)
            : null;

        const newEtag = original.isFolder
            ? generateETagSync({ id: newFileId, content: "", updatedAt: now })
            : generateETagSync({
                id: newFileId,
                content: finalContent || "",
                updatedAt: now,
                isEncrypted: original.isEncrypted,
                envelope: original.isEncrypted && finalMetadata ? {
                    version: 1,
                    algorithm: 'AES-GCM-256',
                    keyId: finalMetadata.keyId ?? 'master-v1',
                    salt: finalMetadata.salt ?? '',
                    iv: finalMetadata.iv,
                    kdfIterations: finalMetadata.kdfIterations ?? 600000,
                    ciphertext: finalContent || '',
                } : undefined,
            });

        const [copiedFile] = await db
            .insert(schema.files)
            .values({
                id: newFileId,
                userId: user.id,
                title: copyTitle,
                content: finalContent,
                isFolder: original.isFolder,
                parentFolderId: targetParentId,
                isEncrypted: original.isEncrypted,
                encryptionMetadata: finalMetadata,
                etag: newEtag,
                version: 1,
                createdAt: now,
                updatedAt: now,
            })
            .returning();

        // If copying a folder, copy direct children recursively
        if (original.isFolder) {
            const children = await db.query.files.findMany({
                where: and(
                    eq(schema.files.parentFolderId, fileId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });

            for (const child of children) {
                if (child.isEncrypted) {
                    continue; // Skip encrypted children in bulk server copy without client keys
                }
                await copyFile(child.id, copiedFile.id, sanitizedDepth + 1);
            }
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Standalone test context
        }

        return { success: true, data: copiedFile };

    } catch (error) {
        console.error("Copy file error:", error);
        return { success: false, status: "error", error: "Failed to copy file" };
    }
}

/**
 * Get single file by ID for authenticated user.
 */
export async function getFile(fileId: string): Promise<FileOpResult> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
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
        return { success: false, status: "error", error: "Failed to fetch file" };
    }
}

/**
 * Get all active files and folders for authenticated user.
 */
export async function getUserFiles(): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc }) => [desc(files.isFolder), desc(files.updatedAt)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get user files error:", error);
        return { success: false, status: "error", error: "Failed to fetch files" };
    }
}

/**
 * Get root level files and folders for authenticated user.
 */
export async function getRootFiles(): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                isNull(schema.files.parentFolderId),
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc }) => [desc(files.isFolder), desc(files.updatedAt)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get root files error:", error);
        return { success: false, status: "error", error: "Failed to fetch root files" };
    }
}

/**
 * Get all soft-deleted files for authenticated user.
 */
export async function getDeletedFiles(): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const files = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                // isNotNull(deletedAt)
                eq(schema.files.deletedAt, schema.files.deletedAt)
            ),
            orderBy: (files, { desc }) => [desc(files.deletedAt)],
        });

        // Filter out null deletedAt in memory if necessary or query with isNotNull
        const filtered = files.filter(f => f.deletedAt !== null);

        return { success: true, data: filtered };

    } catch (error) {
        console.error("Get deleted files error:", error);
        return { success: false, status: "error", error: "Failed to fetch deleted files" };
    }
}
