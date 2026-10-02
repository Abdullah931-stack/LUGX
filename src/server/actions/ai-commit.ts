"use server";

import { db } from "@/server/db";
import { txDb } from "@/server/db/transactional";
import * as schema from "@/server/db/schema";
import { getUser } from "@/lib/supabase/server";
import { eq, and, isNull } from "drizzle-orm";
import { generateETagSync, normalizeMarkdownSource } from "@/lib/sync/etag-generator";
import { revalidatePath } from "next/cache";
import { refundAIReservation } from "@/server/services/ai-settlement-service";

export interface CommitAIFileOperationParams {
    operationId: string;
    fileId: string;
    expectedVersion: number;
    expectedETag?: string | null;
    resultContent: string;
    encryptionMetadata?: {
        version: number;
        algorithm: string;
        keyId: string;
        salt: string;
        iv: string;
        kdfIterations?: number;
    } | null;
    originalContent?: string;
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
 * Server Action: Commit AI Operation to persist document update with version lock.
 *
 * PHASE 11 & G2 COMPLIANCE:
 * 1. Validates authenticated user session and file ownership.
 * 2. Decoupled from active pending reservation lock: accepts server-authoritative committed reservations.
 * 3. Enforces document idempotency: if file already contains target content at current version, returns already_committed.
 * 4. Verifies optimistic version and expectedETag preconditions before executing update.
 * 5. Yields explicit 412 Conflict if version or ETag mismatch is detected.
 * 6. Financial quota management is handled strictly server-side in ai-settlement-service.
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

        // 1. Verify reservation existence & user/file association
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

        if (reservation.status === "refunded" || reservation.status === "expired") {
            return {
                success: false,
                status: "reservation_expired",
                error: `Reservation is already ${reservation.status}`,
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

        // Idempotency: If reservation was committed and file has already advanced past expectedVersion,
        // or if current file content already matches target content at or above expectedVersion.
        if (
            reservation.status === "committed" &&
            ((currentFile.version ?? 0) > expectedVersion || currentFile.content === resultContent)
        ) {
            return {
                success: true,
                status: "already_committed",
                version: currentFile.version ?? undefined,
                etag: currentFile.etag ?? undefined,
                updatedAt: currentFile.updatedAt?.toISOString(),
            };
        }

        // Zero-Knowledge AI Gatekeeper Defense:
        if (currentFile.isEncrypted) {
            if (typeof db.query?.userVaultProfiles?.findFirst === "function") {
                const vaultProfile = await db.query.userVaultProfiles.findFirst({
                    where: eq(schema.userVaultProfiles.userId, user.id),
                });
                if (!vaultProfile?.allowAIOnEncryptedFiles) {
                    await refundAIReservation(operationId, user.id).catch(() => {});
                    return {
                        success: false,
                        status: "unauthorized",
                        error: "AI_PROHIBITED_ON_ENCRYPTED_FILES",
                    };
                }
            }

            if (!params.encryptionMetadata?.iv) {
                await refundAIReservation(operationId, user.id).catch(() => {});
                return {
                    success: false,
                    status: "error",
                    error: "Cannot commit unencrypted content to an encrypted file without encryption metadata",
                };
            }
        }

        const normalizeETag = (t?: string | null) => (t ? t.replace(/^W\//, "").replace(/"/g, "") : null);
        const fileCurrentVersion = currentFile.version ?? 0;
        let baseVersion = expectedVersion;

        const isContentUnchanged =
            !currentFile.isEncrypted &&
            params.originalContent !== undefined &&
            normalizeMarkdownSource(currentFile.content) === normalizeMarkdownSource(params.originalContent);

        if (fileCurrentVersion !== expectedVersion) {
            // Self-Session Healing: if server content matches original baseline, adopt current version safely
            if (isContentUnchanged) {
                baseVersion = fileCurrentVersion;
            } else {
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
        }

        // ETag verification with normalization
        if (expectedETag && currentFile.etag) {
            const normExpected = normalizeETag(expectedETag);
            const normCurrent = normalizeETag(currentFile.etag);
            if (normExpected && normCurrent && normExpected !== normCurrent && !isContentUnchanged) {
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
        }

        const now = new Date();
        const newVersion = baseVersion + 1;
        const newEtag = generateETagSync({
            id: fileId,
            content: resultContent,
            updatedAt: now,
            isEncrypted: currentFile.isEncrypted ?? false,
            envelope: currentFile.isEncrypted ? {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: params.encryptionMetadata?.keyId ?? 'master-v1',
                salt: params.encryptionMetadata?.salt ?? '',
                iv: params.encryptionMetadata?.iv ?? '',
                kdfIterations: params.encryptionMetadata?.kdfIterations ?? 600000,
                ciphertext: resultContent,
            } : undefined,
        });

        // 3. Atomically update file with optimistic version lock
        const targetDb = txDb && typeof txDb.transaction === "function" ? txDb : db;
        let updatedFile: typeof currentFile | undefined;

        if (typeof targetDb.transaction === "function") {
            const txResult = await targetDb.transaction(async (tx) => {
                const [f] = await tx
                    .update(schema.files)
                    .set({
                        content: resultContent,
                        encryptionMetadata: currentFile.isEncrypted
                            ? (params.encryptionMetadata ?? currentFile.encryptionMetadata)
                            : null,
                        etag: newEtag,
                        version: newVersion,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(schema.files.id, fileId),
                            eq(schema.files.userId, user.id),
                            eq(schema.files.version, baseVersion),
                            isNull(schema.files.deletedAt)
                        )
                    )
                    .returning();

                if (!f) {
                    return { conflict: true };
                }

                return { conflict: false, file: f };
            });

            if (txResult?.conflict) {
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
            const [f] = await db
                .update(schema.files)
                .set({
                    content: resultContent,
                    encryptionMetadata: currentFile.isEncrypted
                        ? (params.encryptionMetadata ?? currentFile.encryptionMetadata)
                        : null,
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
