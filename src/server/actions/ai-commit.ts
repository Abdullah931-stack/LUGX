"use server";

import { db, schema } from "@/lib/db";
import { txDb } from "@/lib/db/transactional";
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
    | { success: true; status: "already_committed"; version?: number; etag?: string; updatedAt?: string }
    | {
        success: false;
        status: "conflict";
        error: string;
        serverVersion?: { version?: number | null; etag?: string | null; updatedAt?: string };
    }
    | { success: false; status: "already_committed"; version?: number; etag?: string; updatedAt?: string }
    | {
        success: false;
        status: "reservation_expired" | "reservation_not_found" | "unauthorized" | "error";
        error: string;
    };

/**
 * Server Action: Commit AI Operation and persist document update with version lock and transactional settlement.
 *
 * G2 & PHASE 8 COMPLIANCE:
 * 1. Validates authenticated user session.
 * 2. Enforces reservation existence, user ownership, and file association.
 * 3. Enforces idempotency via `operationId` (returns committed file state upon retry).
 * 4. Verifies optimistic version and expectedETag preconditions before executing transactions.
 * 5. Atomically executes file content update and reservation settlement within a single database transaction.
 * 6. Yields explicit 412 Conflict if version or ETag mismatch is detected, preventing silent overwrite.
 */
export async function commitAIFileOperation(
    params: CommitAIFileOperationParams
): Promise<CommitAIFileOperationResult> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const { operationId, fileId, expectedVersion, expectedETag, resultContent } = params;

        if (!operationId || !fileId || typeof expectedVersion !== "number") {
            return {
                success: false,
                status: "error",
                error: "Invalid commit parameters provided",
            };
        }

        // 1. Verify reservation state & user ownership
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

        // Reservation file association check
        if (reservation.fileId && reservation.fileId !== fileId) {
            return {
                success: false,
                status: "error",
                error: "AI reservation is assigned to a different file",
            };
        }

        // Idempotency: If already committed, return the existing file state
        if (reservation.status === "committed") {
            const currentFile = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, fileId),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });

            return {
                success: true,
                status: "already_committed",
                version: currentFile?.version ?? undefined,
                etag: currentFile?.etag ?? undefined,
                updatedAt: currentFile?.updatedAt?.toISOString(),
            };
        }

        if (reservation.status === "refunded" || reservation.status === "expired") {
            return {
                success: false,
                status: "reservation_expired",
                error: `Reservation is already ${reservation.status}`,
            };
        }

        if (reservation.status !== "reserved") {
            return {
                success: false,
                status: "error",
                error: `Invalid reservation status: ${reservation.status}`,
            };
        }

        // 2. Fetch current file to check optimistic version lock & ETag
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

        // ETag verification
        if (expectedETag && currentFile.etag && expectedETag !== currentFile.etag) {
            return {
                success: false,
                status: "conflict",
                error: "Conflict: ETag mismatch detected.",
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

        // Enforce transactional safety in production
        if (process.env.NODE_ENV !== "test" && typeof (txDb as any)?.transaction !== "function") {
            throw new Error("Transactional DB client is unavailable. Atomic commit requires txDb.transaction().");
        }

        // 3. Atomically update file and settle reservation in a single transaction
        const targetDb = txDb && typeof (txDb as any).transaction === "function" ? txDb : db;

        let updatedFile: typeof currentFile | undefined;

        if (typeof (targetDb as any).transaction === "function") {
            const txResult = await (targetDb as any).transaction(async (tx: any) => {
                const [f] = await tx
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

                if (!f) {
                    return { conflict: true };
                }

                const [res] = await tx
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
                    )
                    .returning();

                if (!res) {
                    throw new Error("Failed to settle AI reservation during commit");
                }

                return { conflict: false, file: f };
            });

            if (txResult.conflict) {
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
                        updatedAt: refreshed?.updatedAt?.toISOString(),
                    },
                };
            }

            updatedFile = txResult.file;
        } else {
            // Fallback for drivers without interactive transactions (strictly in test environment)
            const [f] = await db
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

            if (!f) {
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
                        updatedAt: refreshed?.updatedAt?.toISOString(),
                    },
                };
            }

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

            updatedFile = f;
        }

        try {
            revalidatePath("/workspace");
        } catch {
            // Ignore static generation store missing error during standalone unit testing
        }

        return {
            success: true,
            status: "committed",
            version: updatedFile?.version ?? newVersion,
            etag: updatedFile?.etag ?? newEtag,
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
