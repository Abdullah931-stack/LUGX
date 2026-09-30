"use server";

import { revalidatePath } from "next/cache";
import { db, schema } from "@/server/db";
import { requireAuthenticatedUser } from "@/server/auth/session";
import { eq, and, isNull } from "drizzle-orm";
import type { FileOpResult } from "./files";

/**
 * Fetch all descendant IDs (children, grandchildren, etc.) of a folder recursively.
 */
export async function getDescendantIds(folderId: string, userId: string): Promise<string[]> {
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
 * Verifies whether a candidate folder is a descendant of a given ancestor folder.
 */
export async function isDescendantOf(
    candidateFolderId: string,
    ancestorFolderId: string,
    userId: string
): Promise<boolean> {
    if (candidateFolderId === ancestorFolderId) return true;

    let currentAncestorId: string | null = candidateFolderId;
    const visited = new Set<string>();

    while (currentAncestorId) {
        if (currentAncestorId === ancestorFolderId) {
            return true;
        }
        if (visited.has(currentAncestorId)) {
            break;
        }
        visited.add(currentAncestorId);

        const node: { parentFolderId: string | null } | undefined = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, currentAncestorId),
                eq(schema.files.userId, userId),
                isNull(schema.files.deletedAt)
            ),
            columns: { parentFolderId: true },
        });

        currentAncestorId = node?.parentFolderId ?? null;
    }

    return false;
}

/**
 * Move file or folder to a different parent folder with strict cycle detection and descendant validation.
 * Remediates LUGX-073 by replacing artificial hop caps with full cycle traversal and isolation.
 */
export async function moveFile(
    fileId: string,
    newParentFolderId: string | null
): Promise<FileOpResult<null>> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
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

        // Validate target parent folder if moving into a subfolder
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

            // Descendant / cycle check: If target is a folder, verify destination is not inside target
            if (target.isFolder) {
                let currentAncestorId: string | null = parent.parentFolderId;
                const visited = new Set<string>([newParentFolderId]);

                while (currentAncestorId) {
                    if (currentAncestorId === fileId) {
                        return {
                            success: false,
                            status: "conflict",
                            error: "Cannot move a folder into one of its descendants",
                        };
                    }
                    if (visited.has(currentAncestorId)) {
                        return {
                            success: false,
                            status: "conflict",
                            error: "Circular hierarchy detected in folder structure",
                        };
                    }
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
            // Standalone test environments lack Next.js page context
        }

        return { success: true };

    } catch (error) {
        console.error("Move file error:", error);
        return { success: false, status: "error", error: "Failed to move file" };
    }
}

/**
 * Get children files and folders of a specific parent folder.
 */
export async function getFolderChildren(
    folderId: string | null
): Promise<FileOpResult<typeof schema.files.$inferSelect[]>> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const children = await db.query.files.findMany({
            where: and(
                eq(schema.files.userId, user.id),
                folderId
                    ? eq(schema.files.parentFolderId, folderId)
                    : isNull(schema.files.parentFolderId),
                isNull(schema.files.deletedAt)
            ),
            orderBy: (files, { desc }) => [desc(files.isFolder), desc(files.updatedAt)],
        });

        return { success: true, data: children };

    } catch (error) {
        console.error("Get folder children error:", error);
        return { success: false, status: "error", error: "Failed to fetch folder children" };
    }
}
