"use server";

import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";
import { eq, and, isNull } from "drizzle-orm";
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

        const currentFile = await db.query.files.findFirst({
            where: and(eq(schema.files.id, fileId), eq(schema.files.userId, user.id)),
            columns: { version: true },
        });
        const newVersion = (currentFile?.version || 0) + 1;

        await db
            .update(schema.files)
            .set({ content, etag: newEtag, version: newVersion, updatedAt: now })
            .where(and(eq(schema.files.id, fileId), eq(schema.files.userId, user.id)));

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

        await db
            .update(schema.files)
            .set({
                title: newTitle,
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
        console.error("Rename file error:", error);
        return { success: false, error: "Failed to rename file" };
    }
}

/**
 * Delete file or folder
 */
export async function deleteFile(
    fileId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        // Delete file (cascade will handle children for folders)
        await db
            .delete(schema.files)
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

        await db
            .update(schema.files)
            .set({
                parentFolderId: newParentFolderId,
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
                eq(schema.files.userId, user.id)
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

        // Get ALL files (not just root) - client will build tree structure
        const files = await db.query.files.findMany({
            where: eq(schema.files.userId, user.id),
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
                isNull(schema.files.parentFolderId)
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
                eq(schema.files.parentFolderId, folderId)
            ),
            orderBy: (files, { desc, asc }) => [desc(files.isFolder), asc(files.title)],
        });

        return { success: true, data: files };

    } catch (error) {
        console.error("Get folder children error:", error);
        return { success: false, error: "Failed to get folder contents" };
    }
}
