"use server";

/**
 * Server Action: Import File
 * Handles PDF/MD/TXT file imports with text extraction and parent ownership validation
 */

import { getUser } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { extractPdfText, isValidPDF } from "@/lib/parsers/pdf-parser";
import { smartConvertToHTML } from "@/lib/parsers/text-to-html.server";
import { generateETagSync } from "@/lib/sync/etag-generator";
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

/**
 * Import a file and extract its text content
 * @param fileName - Name of the file
 * @param fileContent - File content as base64 string
 * @param fileType - Type of file (pdf/md/txt)
 * @param parentFolderId - Optional parent folder ID
 */
export async function importFile(
    fileName: string,
    fileContent: string,
    fileType: 'pdf' | 'md' | 'txt',
    parentFolderId: string | null = null
): Promise<ImportFileResult> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "User not authenticated" };
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
                return { success: false, error: "Parent folder not found or forbidden" };
            }

            if (!parent.isFolder) {
                return { success: false, error: "Parent destination must be a folder" };
            }
        }

        let textContent: string;
        let wordCount = 0;

        // Process based on file type
        if (fileType === 'pdf') {
            // Decode base64 to Buffer
            const buffer = Buffer.from(fileContent, 'base64');

            // Validate PDF
            if (!isValidPDF(buffer)) {
                return { success: false, error: "Invalid PDF file" };
            }

            // Extract text only (NO IMAGES)
            const pdfResult = await extractPdfText(buffer);
            textContent = pdfResult.text;
            wordCount = pdfResult.wordCount;

            if (!textContent.trim()) {
                return { success: false, error: "PDF contains no extractable text" };
            }
        } else {
            // For MD/TXT files, decode from base64 preserving all formatting
            textContent = Buffer.from(fileContent, 'base64').toString('utf-8');

            // Normalize line endings for consistency
            textContent = textContent.replace(/\r\n/g, '\n');

            wordCount = textContent.split(/\s+/).filter(Boolean).length;
        }

        // Remove file extension from title and sanitize
        const rawTitle = fileName.replace(/\.(pdf|md|txt)$/i, '');
        const title = (rawTitle || "Imported Document").trim().slice(0, 500);

        // Convert plain text to HTML for TipTap editor compatibility
        const htmlContent = smartConvertToHTML(textContent, fileType);

        const newFileId = randomUUID();
        const now = new Date();
        const etag = generateETagSync({
            id: newFileId,
            content: htmlContent,
            updatedAt: now,
        });

        // Atomic insert with pre-computed ETag
        const [newFile] = await db
            .insert(files)
            .values({
                id: newFileId,
                userId: user.id,
                title,
                content: htmlContent,
                parentFolderId,
                isFolder: false,
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
                content: htmlContent,
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
