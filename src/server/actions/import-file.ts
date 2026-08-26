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

/**
 * Import a file and extract its text content as pure Markdown
 * 
 * Layout Loss Policy for PDF:
 * Extracted PDF text is normalized to linear Markdown paragraphs. Complex page layouts,
 * columns, headers, footers, and embedded media are not preserved.
 * 
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

        // Defense-in-depth: Validate Base64 payload size (max 10MB decoded binary ≈ 14MB base64)
        const MAX_BASE64_LENGTH = 14 * 1024 * 1024;
        if (!fileContent || typeof fileContent !== 'string' || fileContent.length > MAX_BASE64_LENGTH) {
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

            // Extract text only (NO IMAGES, linear layout)
            const pdfResult = await extractPdfText(buffer);
            textContent = normalizeMarkdownSource(pdfResult.text);
            wordCount = pdfResult.wordCount;

            if (!textContent.trim()) {
                return { success: false, error: "PDF contains no extractable text" };
            }
        } else {
            // For MD/TXT files, decode from base64 preserving pure markdown formatting
            const rawText = Buffer.from(fileContent, 'base64').toString('utf-8');
            textContent = normalizeMarkdownSource(rawText);
            wordCount = textContent.split(/\s+/).filter(Boolean).length;
        }

        // Remove file extension from title and sanitize
        const rawTitle = fileName.replace(/\.(pdf|md|txt)$/i, '');
        const baseTitle = (rawTitle || "Imported Document").trim().slice(0, 500);

        // Resolve title collisions in destination folder via single query (avoids 23505 unique_violation)
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

        const newFileId = randomUUID();
        const now = new Date();
        const etag = generateETagSync({
            id: newFileId,
            content: textContent,
            updatedAt: now,
        });

        // Atomic insert with pre-computed ETag, pure Markdown content, and collision-free title
        const [newFile] = await db
            .insert(files)
            .values({
                id: newFileId,
                userId: user.id,
                title,
                content: textContent,
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
                content: textContent,
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
