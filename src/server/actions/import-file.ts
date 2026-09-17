"use server";

/**
 * Server Action: Import File
 * Handles PDF/MD/TXT file imports with direct UTF-8 text/ciphertext payloads,
 * parent folder ownership validation, and Zero-Knowledge Vault encrypted import.
 */

import { getUser } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { files, type FileEncryptionMetadata } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { generateETagSync, normalizeMarkdownSource } from "@/lib/sync/etag-generator";
import { randomUUID } from "crypto";

export interface ImportFileResult {
    success: boolean;
    data?: {
        id: string;
        title: string;
        content: string;
        wordCount: number;
    };
    error?: string;
}

export interface ImportEncryptionOptions {
    isEncrypted?: boolean;
    encryptionMetadata?: FileEncryptionMetadata | null;
    fileId?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 10 * 1024 * 1024; // 10MB UTF-8 text limit

/**
 * Import a file by saving its extracted text or encrypted ciphertext into Neon DB.
 *
 * @param fileName - Original name of the file (e.g. document.pdf, notes.md)
 * @param textContent - Extracted UTF-8 plain text or AES-GCM ciphertext Base64 string
 * @param fileType - Type of file ('pdf' | 'md' | 'txt')
 * @param parentFolderId - Optional parent folder ID
 * @param encryption - Optional Zero-Knowledge Vault encryption parameters
 */
export async function importFile(
    fileName: string,
    textContent: string,
    fileType: 'pdf' | 'md' | 'txt',
    parentFolderId: string | null = null,
    encryption?: ImportEncryptionOptions
): Promise<ImportFileResult> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "User not authenticated" };
        }

        // Validate text content payload
        if (typeof textContent !== 'string') {
            return { success: false, error: "Invalid text content payload" };
        }

        if (textContent.trim().length === 0) {
            return {
                success: false,
                error: fileType === 'pdf'
                    ? "PDF contains no extractable text"
                    : "File content is empty or contains no extractable text"
            };
        }

        if (Buffer.byteLength(textContent, 'utf-8') > MAX_TEXT_LENGTH) {
            return { success: false, error: "File exceeds maximum size limit (10MB)" };
        }

        // Validate parent folder if specified
        if (parentFolderId) {
            const parent = await db.query.files.findFirst({
                where: and(
                    eq(files.id, parentFolderId),
                    eq(files.userId, user.id),
                    isNull(files.deletedAt)
                ),
            });

            if (!parent) {
                return { success: false, error: "Parent folder not found" };
            }

            if (!parent.isFolder) {
                return { success: false, error: "Parent destination must be a folder" };
            }
        }

        const isEncrypted = Boolean(encryption?.isEncrypted);
        let finalContent: string;
        let wordCount = 0;
        let newFileId: string;
        let finalMetadata: FileEncryptionMetadata | null = null;

        // Strip null bytes to protect PostgreSQL text fields
        const sanitizedInput = textContent.replace(/\0/g, '');

        if (isEncrypted) {
            // Zero-Knowledge Vault: Client pre-generated UUID must match AAD: vault:file:${userId}:${fileId}
            if (!encryption?.fileId || !UUID_REGEX.test(encryption.fileId)) {
                return { success: false, error: "Valid UUID fileId is required for encrypted import" };
            }

            if (!encryption?.encryptionMetadata || typeof encryption.encryptionMetadata !== 'object' || !encryption.encryptionMetadata.iv) {
                return { success: false, error: "Valid encryption metadata is required for encrypted import" };
            }

            newFileId = encryption.fileId;
            finalContent = sanitizedInput;
            finalMetadata = encryption.encryptionMetadata;
            wordCount = 0; // Word count cannot be evaluated on zero-knowledge ciphertext
        } else {
            // Plain text: normalize Markdown source
            finalContent = normalizeMarkdownSource(sanitizedInput);
            if (!finalContent.trim()) {
                return {
                    success: false,
                    error: fileType === 'pdf' ? "PDF contains no extractable text" : "File contains no extractable text",
                };
            }

            newFileId = encryption?.fileId && UUID_REGEX.test(encryption.fileId)
                ? encryption.fileId
                : randomUUID();
            wordCount = finalContent.split(/\s+/).filter(Boolean).length;
        }

        // Remove file extension from title and sanitize length
        const rawTitle = fileName.replace(/\.(pdf|md|txt)$/i, '');
        const baseTitle = (rawTitle || "Imported Document").trim().slice(0, 500);

        // Resolve title collisions in destination folder via single query
        const siblings = await db.query.files.findMany({
            where: and(
                eq(files.userId, user.id),
                parentFolderId ? eq(files.parentFolderId, parentFolderId) : isNull(files.parentFolderId),
                isNull(files.deletedAt)
            ),
            columns: { title: true },
        });

        const existingTitles = new Set(siblings.map((s) => s.title));
        let title = baseTitle;
        let counter = 1;
        while (existingTitles.has(title)) {
            title = `${baseTitle} (${counter})`.slice(0, 500);
            counter++;
        }

        const now = new Date();
        const etag = generateETagSync({
            id: newFileId,
            content: finalContent,
            updatedAt: now,
        });

        // Atomic insert into Neon PostgreSQL
        const [newFile] = await db
            .insert(files)
            .values({
                id: newFileId,
                userId: user.id,
                title,
                content: finalContent,
                parentFolderId,
                isFolder: false,
                isEncrypted,
                encryptionMetadata: finalMetadata,
                etag,
                version: 1,
                createdAt: now,
                updatedAt: now,
            })
            .returning();

        return {
            success: true,
            data: {
                id: newFile.id,
                title: newFile.title,
                content: finalContent,
                wordCount,
            },
        };
    } catch (error) {
        console.error("Import file error:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to import file",
        };
    }
}
