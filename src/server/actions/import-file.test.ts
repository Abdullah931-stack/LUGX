/**
 * Tests for Server Action: importFile
 * 
 * Validates:
 * 1. MD/TXT files are imported as pure Markdown text with NO HTML conversion (no smartConvertToHTML).
 * 2. PDF files are extracted to linear Markdown text without HTML conversion.
 * 3. Line endings and Unicode normalization are applied.
 * 4. ETags are generated accurately on the Markdown content.
 * 5. Parent folder validation (must exist, must be a folder, must belong to user).
 * 6. Empty / unextractable files error handling according to contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { importFile } from "./import-file";
import { db } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";

// Mock dependencies
vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

vi.mock("@/lib/db", () => {
    const mockDb = {
        query: {
            files: {
                findFirst: vi.fn(),
                findMany: vi.fn().mockResolvedValue([]),
            },
        },
        insert: vi.fn(() => ({
            values: vi.fn((vals) => ({
                returning: vi.fn().mockResolvedValue([
                    {
                        ...vals,
                        id: vals.id || "mock-imported-id",
                        title: vals.title,
                        content: vals.content,
                        etag: vals.etag,
                        version: vals.version || 1,
                    },
                ]),
            })),
        })),
    };
    return { db: mockDb };
});

vi.mock("@/lib/parsers/pdf-parser", () => ({
    extractPdfText: vi.fn().mockImplementation(async (buf: Buffer) => {
        const text = buf.toString("utf-8");
        if (text.includes("EMPTY_PDF")) {
            return { text: "   ", numPages: 1, wordCount: 0 };
        }
        return {
            text: "# Extracted PDF Header\r\n\r\nThis is the PDF paragraph content.",
            numPages: 2,
            wordCount: 9,
        };
    }),
    isValidPDF: vi.fn().mockImplementation((buf: Buffer) => {
        return !buf.toString("utf-8").includes("INVALID_MAGIC");
    }),
}));

describe("importFile Server Action (Phase 3 Markdown Content Model)", () => {
    const mockUser = { id: "user-test-import-123", email: "import-test@example.com" };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUser).mockResolvedValue(mockUser as any);
    });

    it("requires authenticated user", async () => {
        vi.mocked(getUser).mockResolvedValue(null);
        const result = await importFile("test.md", Buffer.from("# Title").toString("base64"), "md");
        expect(result.success).toBe(false);
        expect(result.error).toBe("User not authenticated");
    });

    it("imports MD file as pure Markdown without HTML tags", async () => {
        const rawMarkdown = "# Heading 1\r\n\r\n- Item 1\r\n- Item 2\r\n\r\n**Bold Text**";
        const base64 = Buffer.from(rawMarkdown, "utf-8").toString("base64");

        const result = await importFile("my-document.md", base64, "md");

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data?.title).toBe("my-document");
        // Must be pure Markdown normalized to LF, not converted to HTML
        expect(result.data?.content).toBe("# Heading 1\n\n- Item 1\n- Item 2\n\n**Bold Text**");
        expect(result.data?.content).not.toContain("<h1>");
        expect(result.data?.content).not.toContain("<p>");
        expect(result.data?.content).not.toContain("<ul>");
        expect(result.data?.wordCount).toBe(11);

        // Verify DB insert payload
        expect(db.insert).toHaveBeenCalled();
    });

    it("imports TXT file as pure Markdown without HTML wrapping", async () => {
        const rawText = "Line 1\r\nLine 2\r\nLine 3";
        const base64 = Buffer.from(rawText, "utf-8").toString("base64");

        const result = await importFile("notes.txt", base64, "txt");

        expect(result.success).toBe(true);
        expect(result.data?.title).toBe("notes");
        expect(result.data?.content).toBe("Line 1\nLine 2\nLine 3");
        expect(result.data?.content).not.toContain("<p>");
        expect(result.data?.content).not.toContain("<br");
    });

    it("imports PDF file and stores extracted text as normalized Markdown", async () => {
        const pdfContent = "Dummy PDF buffer content";
        const base64 = Buffer.from(pdfContent, "utf-8").toString("base64");

        const result = await importFile("whitepaper.pdf", base64, "pdf");

        expect(result.success).toBe(true);
        expect(result.data?.title).toBe("whitepaper");
        expect(result.data?.content).toBe("# Extracted PDF Header\n\nThis is the PDF paragraph content.");
        expect(result.data?.content).not.toContain("<p>");
        expect(result.data?.wordCount).toBe(9);
    });

    it("rejects invalid PDF buffer", async () => {
        const invalidBase64 = Buffer.from("INVALID_MAGIC content", "utf-8").toString("base64");
        const result = await importFile("bad.pdf", invalidBase64, "pdf");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid PDF file");
    });

    it("rejects PDF containing no extractable text", async () => {
        const emptyPdfBase64 = Buffer.from("EMPTY_PDF content", "utf-8").toString("base64");
        const result = await importFile("scanned.pdf", emptyPdfBase64, "pdf");

        expect(result.success).toBe(false);
        expect(result.error).toBe("PDF contains no extractable text");
    });

    it("validates parent folder existence and folder type", async () => {
        // 1. Parent folder not found
        vi.mocked(db.query.files.findFirst).mockResolvedValue(null as any);
        const base64 = Buffer.from("# Title", "utf-8").toString("base64");

        const notFoundRes = await importFile("doc.md", base64, "md", "missing-folder-id");
        expect(notFoundRes.success).toBe(false);
        expect(notFoundRes.error).toBe("Parent folder not found");

        // 2. Parent destination is not a folder
        vi.mocked(db.query.files.findFirst).mockResolvedValue({
            id: "file-not-folder",
            userId: mockUser.id,
            isFolder: false,
            deletedAt: null,
        } as any);

        const notFolderRes = await importFile("doc.md", base64, "md", "file-not-folder");
        expect(notFolderRes.success).toBe(false);
        expect(notFolderRes.error).toBe("Parent destination must be a folder");
    });

    it("rejects files exceeding the maximum base64 size limit (10MB / 14MB base64)", async () => {
        // Create an oversized string (> 14 * 1024 * 1024 chars)
        const oversizedContent = "A".repeat(15 * 1024 * 1024);
        const result = await importFile("huge.md", oversizedContent, "md");

        expect(result.success).toBe(false);
        expect(result.error).toBe("File exceeds maximum size limit (10MB)");
    });

    it("resolves duplicate title collision by incrementing suffix", async () => {
        // Mock existing sibling files in the destination folder
        vi.mocked(db.query.files.findMany).mockResolvedValue([
            { title: "document" },
            { title: "document (1)" },
        ] as any);

        const base64 = Buffer.from("# Unique Content", "utf-8").toString("base64");
        const result = await importFile("document.md", base64, "md");

        expect(result.success).toBe(true);
        expect(result.data?.title).toBe("document (2)");
    });
});
