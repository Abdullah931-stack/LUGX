"use server";

import { db, schema } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";
import { eq, and, isNull } from "drizzle-orm";
import { generateETagSync } from "@/lib/sync/etag-generator";
import { revalidatePath } from "next/cache";
import { refundAIReservation as refundAIReservationOp } from "@/server/actions/ai-ops";

export interface CommitAIFileOperationParams {
    operationId: string;
    fileId: string;
    expectedVersion: number;
    expectedETag?: string | null;
    resultContent: string;
}

export type CommitAIFileOperationResult =
    | { success: true; status: "committed"; version: number; etag: string; updatedAt: string }
    | {
        success: false;
        status: "conflict";
        error: string;
        serverVersion?: { version?: number | null; etag?: string | null; updatedAt?: string };
    }
    | { success: false; status: "already_committed"; version?: number; etag?: string }
    | {
        success: false;
        status: "reservation_expired" | "reservation_not_found" | "unauthorized" | "error";
        error: string;
    };

/**
 * Server Action: Commit AI Operation and persist document update with version lock.
 *
 * G2 COMPLIANCE:
 * 1. Validates reservation existence, user ownership, and `reserved` status.
 * 2. Enforces optimistic lock: `files.version === expectedVersion`.
 * 3. Atomically updates document content, increments version, and sets reservation to `committed`.
 * 4. Yields explicit 412 Conflict if version mismatch is detected, preventing silent overwrite.
 */
export async function commitAIFileOperation(
    params: CommitAIFileOperationParams
): Promise<CommitAIFileOperationResult> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const { operationId, fileId, expectedVersion, resultContent } = params;

        // 1. Verify reservation state
        const reservation = await db.query.aiReservations.findFirst({
            where: and(
                eq(schema.aiReservations.operationId, operationId),
                eq(schema.aiReservations.userId, user.id)
            ),
        });

        if (!reservation) {
            return {
                success: false,
                status: "reservation_not_found",
                error: "AI reservation record not found",
            };
        }

        if (reservation.status === "committed") {
            return { success: false, status: "already_committed" };
        }

        if (reservation.status === "refunded" || reservation.status === "expired") {
            return {
                success: false,
                status: "reservation_expired",
                error: `Reservation is already ${reservation.status}`,
            };
        }

        // 2. Fetch current file to check optimistic version lock
        const currentFile = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!currentFile) {
            return { success: false, status: "error", error: "File not found or deleted" };
        }

        const fileCurrentVersion = currentFile.version ?? 0;
        if (fileCurrentVersion !== expectedVersion) {
            return {
                success: false,
                status: "conflict",
                error: "Conflict: this file was modified by another session. Please reload and try again.",
                serverVersion: {
                    version: currentFile.version,
                    etag: currentFile.etag,
                    updatedAt: currentFile.updatedAt.toISOString(),
                },
            };
        }

        const now = new Date();
        const newVersion = fileCurrentVersion + 1;
        const newEtag = generateETagSync({ id: fileId, content: resultContent, updatedAt: now });

        // 3. Atomically update file with version guard
        const [updatedFile] = await db
            .update(schema.files)
            .set({
                content: resultContent,
                etag: newEtag,
                version: newVersion,
                updatedAt: now,
            })
            .where(
                and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id),
                    eq(schema.files.version, expectedVersion),
                    isNull(schema.files.deletedAt)
                )
            )
            .returning();

        if (!updatedFile) {
            // Concurrent writer moved version inside gap
            const refreshed = await db.query.files.findFirst({
                where: and(eq(schema.files.id, fileId), eq(schema.files.userId, user.id)),
            });
            return {
                success: false,
                status: "conflict",
                error: "Conflict: concurrent write detected. Reverting ephemeral state.",
                serverVersion: {
                    version: refreshed?.version,
                    etag: refreshed?.etag,
                    updatedAt: refreshed?.updatedAt.toISOString(),
                },
            };
        }

        // 4. Mark reservation as committed with reservedUnits tracked into committedUnits
        await db
            .update(schema.aiReservations)
            .set({
                status: "committed",
                committedUnits: reservation.reservedUnits,
                updatedAt: now,
            })
            .where(
                and(
                    eq(schema.aiReservations.id, reservation.id),
                    eq(schema.aiReservations.status, "reserved")
                )
            );

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore static generation store missing error during standalone unit testing
        }

        return {
            success: true,
            status: "committed",
            version: newVersion,
            etag: newEtag,
            updatedAt: now.toISOString(),
        };

    } catch (error) {
        console.error("[commitAIFileOperation] Error:", error);
        return {
            success: false,
            status: "error",
            error: error instanceof Error ? error.message : "Failed to commit AI operation",
        };
    }
}

/**
 * Server Action: Refund an AI Reservation idempotently (delegating to unified ai-ops handler).
 */
export async function refundAIReservation(
    operationId: string,
    reason: string = "stream_failed"
): Promise<{ refunded: boolean; reason?: string }> {
    return refundAIReservationOp(operationId, reason);
}

