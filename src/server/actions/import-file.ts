"use server";

/**
 * Server Action: Import File
 * Handles PDF/MD/TXT file imports with text extraction
 */

import { getUser } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { extractPdfText, isValidPDF } from "@/lib/parsers/pdf-parser";
import { smartConvertToHTML } from "@/lib/parsers/text-to-html";

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

            // DEBUG: Log to verify newlines are present
            console.log('[Import Debug] Text content preview:', textContent.substring(0, 200));
            console.log('[Import Debug] Contains newlines:', textContent.includes('\n'));
            console.log('[Import Debug] Newline count:', (textContent.match(/\n/g) || []).length);

            wordCount = textContent.split(/\s+/).filter(Boolean).length;
        }

        // Remove file extension from title
        const title = fileName.replace(/\.(pdf|md|txt)$/i, '');

        // Convert plain text to HTML for TipTap editor compatibility
        // This preserves newlines and formatting
        console.log('[Import Debug] Before HTML conversion, text has', (textContent.match(/\n/g) || []).length, 'newlines');
        const htmlContent = smartConvertToHTML(textContent, fileType);
        console.log('[Import Debug] After HTML conversion:', htmlContent.substring(0, 300));
        console.log('[Import Debug] HTML has <br> tags:', htmlContent.includes('<br>'));
        console.log('[Import Debug] HTML has <p> tags:', htmlContent.includes('<p>'));

        // Insert into database
        const [newFile] = await db
            .insert(files)
            .values({
                userId: user.id,
                title,
                content: htmlContent, // Store as HTML
                parentFolderId,
                isFolder: false,
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
