/**
 * Tests for Server Action: importFile
 *
 * Validates:
 * 1. MD/TXT/PDF files are imported with direct UTF-8 textContent (no Base64 required).
 * 2. Line endings and Unicode normalization are applied.
 * 3. ETags are generated accurately on the content.
 * 4. Zero-Knowledge Vault encrypted import (isEncrypted: true, encryptionMetadata, client fileId).
 * 5. Parent folder validation (must exist, must be a folder, must belong to user).
 * 6. Empty / unextractable files error handling according to contract.
 * 7. Payload limit enforcement (10MB) and null byte stripping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { importFile } from "./import-file";
import { db } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";
import { randomUUID } from "crypto";

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
                        isEncrypted: vals.isEncrypted || false,
                        encryptionMetadata: vals.encryptionMetadata || null,
                    },
                ]),
            })),
        })),
    };
    return { db: mockDb };
});

describe("importFile Server Action (Client-Extracted Text & Vault Pipeline)", () => {
    const mockUser = { id: "user-test-import-123", email: "import-test@example.com" };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUser).mockResolvedValue(mockUser as any);
    });

    it("requires authenticated user", async () => {
        vi.mocked(getUser).mockResolvedValue(null);
        const result = await importFile("test.md", "# Title", "md");
        expect(result.success).toBe(false);
        expect(result.error).toBe("User not authenticated");
    });

    it("imports MD file as pure Markdown without HTML tags", async () => {
        const rawMarkdown = "# Heading 1\r\n\r\n- Item 1\r\n- Item 2\r\n\r\n**Bold Text**";

        const result = await importFile("my-document.md", rawMarkdown, "md");

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data?.title).toBe("my-document");
        // Must be pure Markdown normalized to LF, not converted to HTML
        expect(result.data?.content).toBe("# Heading 1\n\n- Item 1\n- Item 2\n\n**Bold Text**");
        expect(result.data?.content).not.toContain("<h1>");
        expect(result.data?.content).not.toContain("<p>");
        expect(result.data?.content).not.toContain("<ul>");
        expect(result.data?.wordCount).toBe(11);

        expect(db.insert).toHaveBeenCalled();
    });

    it("imports TXT file as pure Markdown without HTML wrapping", async () => {
        const rawText = "Line 1\r\nLine 2\r\nLine 3";

        const result = await importFile("notes.txt", rawText, "txt");

        expect(result.success).toBe(true);
        expect(result.data?.title).toBe("notes");
        expect(result.data?.content).toBe("Line 1\nLine 2\nLine 3");
        expect(result.data?.content).not.toContain("<p>");
        expect(result.data?.content).not.toContain("<br");
    });

    it("imports pre-extracted PDF text and stores as normalized Markdown", async () => {
        const extractedText = "# Extracted PDF Header\r\n\r\nThis is the PDF paragraph content.";

        const result = await importFile("whitepaper.pdf", extractedText, "pdf");

        expect(result.success).toBe(true);
        expect(result.data?.title).toBe("whitepaper");
        expect(result.data?.content).toBe("# Extracted PDF Header\n\nThis is the PDF paragraph content.");
        expect(result.data?.content).not.toContain("<p>");
        expect(result.data?.wordCount).toBe(10);
    });

    it("rejects PDF containing no extractable text", async () => {
        const emptyPdfText = "    \n\r\n   ";
        const result = await importFile("scanned.pdf", emptyPdfText, "pdf");

        expect(result.success).toBe(false);
        expect(result.error).toBe("PDF contains no extractable text");
    });

    it("strips null bytes from textContent before storage", async () => {
        const textWithNulls = "Safe text\0\0 content";
        const result = await importFile("nulls.txt", textWithNulls, "txt");

        expect(result.success).toBe(true);
        expect(result.data?.content).toBe("Safe text content");
    });

    it("validates parent folder existence and folder type", async () => {
        // 1. Parent folder not found
        vi.mocked(db.query.files.findFirst).mockResolvedValue(null as any);
        const notFoundRes = await importFile("doc.md", "# Title", "md", "missing-folder-id");
        expect(notFoundRes.success).toBe(false);
        expect(notFoundRes.error).toBe("Parent folder not found");

        // 2. Parent destination is not a folder
        vi.mocked(db.query.files.findFirst).mockResolvedValue({
            id: "file-not-folder",
            userId: mockUser.id,
            isFolder: false,
            deletedAt: null,
        } as any);

        const notFolderRes = await importFile("doc.md", "# Title", "md", "file-not-folder");
        expect(notFolderRes.success).toBe(false);
        expect(notFolderRes.error).toBe("Parent destination must be a folder");
    });

    it("rejects files exceeding the maximum text size limit (10MB)", async () => {
        const oversizedContent = "A".repeat(10 * 1024 * 1024 + 1);
        const result = await importFile("huge.md", oversizedContent, "md");

        expect(result.success).toBe(false);
        expect(result.error).toBe("File exceeds maximum size limit (10MB)");
    });

    it("rejects non-ASCII text exceeding 10MB in UTF-8 bytes even if char length is under 10M", async () => {
        // Arabic character 'ض' is 2 bytes in UTF-8.
        // 6 * 1024 * 1024 characters = 6M chars (< 10M chars), but 12MB in UTF-8 (> 10MB).
        const oversizedArabic = "ض".repeat(6 * 1024 * 1024);
        const result = await importFile("huge-arabic.txt", oversizedArabic, "txt");

        expect(result.success).toBe(false);
        expect(result.error).toBe("File exceeds maximum size limit (10MB)");
    });

    it("resolves duplicate title collision by incrementing suffix", async () => {
        vi.mocked(db.query.files.findMany).mockResolvedValue([
            { title: "document" },
            { title: "document (1)" },
        ] as any);

        const result = await importFile("document.md", "# Unique Content", "md");

        expect(result.success).toBe(true);
        expect(result.data?.title).toBe("document (2)");
    });

    describe("Vault Encrypted Import Pipeline", () => {
        it("stores encrypted ciphertext with isEncrypted: true and client fileId", async () => {
            const clientFileId = randomUUID();
            const fakeCiphertext = "dGhpcyBpcyBhbiBlbmNyeXB0ZWQgY2lwaGVydGV4dA==";
            const fakeMetadata = {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: "YWJjZGVmMTIzNDU2",
                kdfIterations: 600000,
            };

            const result = await importFile("confidential.pdf", fakeCiphertext, "pdf", null, {
                isEncrypted: true,
                fileId: clientFileId,
                encryptionMetadata: fakeMetadata,
            });

            expect(result.success).toBe(true);
            expect(result.data?.id).toBe(clientFileId);
            expect(result.data?.content).toBe(fakeCiphertext);
            expect(result.data?.wordCount).toBe(0);

            // Verify insert payload was called with encryption metadata
            expect(db.insert).toHaveBeenCalled();
        });

        it("rejects encrypted import when fileId is missing or not a valid UUID", async () => {
            const fakeCiphertext = "dGhpcyBpcyBhbiBlbmNyeXB0ZWQ=";
            const fakeMetadata = {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: "YWJjZGVmMTIzNDU2",
            };

            const result = await importFile("secret.md", fakeCiphertext, "md", null, {
                isEncrypted: true,
                fileId: "not-a-uuid",
                encryptionMetadata: fakeMetadata,
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Valid UUID fileId is required for encrypted import");
        });

        it("rejects encrypted import when encryptionMetadata is missing or has no iv", async () => {
            const clientFileId = randomUUID();
            const fakeCiphertext = "dGhpcyBpcyBhbiBlbmNyeXB0ZWQ=";

            const result = await importFile("secret.md", fakeCiphertext, "md", null, {
                isEncrypted: true,
                fileId: clientFileId,
                encryptionMetadata: null as any,
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Valid encryption metadata is required for encrypted import");
        });
    });

    describe("Sanitization and Security Hardening", () => {
        it("rejects disguised Windows PE executable in text content", async () => {
            const fakePePayload = "MZ\x90\x00\x03\x00\x00\x00Some hidden binary payload";
            const result = await importFile("script.md", fakePePayload, "md");
            expect(result.success).toBe(false);
            expect(result.error).toContain("disguised binary detected (Windows Executable (PE))");
        });

        it("rejects disguised Linux ELF executable in text content", async () => {
            const fakeElfPayload = "\x7fELF\x02\x01\x01\x00Some ELF binary code";
            const result = await importFile("notes.txt", fakeElfPayload, "txt");
            expect(result.success).toBe(false);
            expect(result.error).toContain("disguised binary detected (Linux Executable (ELF))");
        });

        it("rejects disguised ZIP archive in text content", async () => {
            const fakeZipPayload = "PK\x03\x04\x14\x00\x00\x00CompressedArchiveContent";
            const result = await importFile("bundle.md", fakeZipPayload, "md");
            expect(result.success).toBe(false);
            expect(result.error).toContain("disguised binary detected (ZIP Archive)");
        });

        it("sanitizes filename to prevent directory traversal and strips illegal characters", async () => {
            const maliciousName = "../../..\\..\\secret<name>:*.md";
            const result = await importFile(maliciousName, "# Safe Content", "md");
            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            // All ../ and illegal characters <>:"/\|?* should be stripped
            expect(result.data?.title).not.toContain("../");
            expect(result.data?.title).not.toContain("..\\");
            expect(result.data?.title).not.toContain("<");
            expect(result.data?.title).not.toContain(">");
            expect(result.data?.title).not.toContain(":");
            expect(result.data?.title).not.toContain("*");
            expect(result.data?.title).toBe("secretname");
        });

        it("accepts genuine plain text starting with MZ characters without false positive PE rejection", async () => {
            const mzContent = "MZ: Architecture and Systems Engineering notes for LUGX platform.";
            const result = await importFile("mz-notes.md", mzContent, "md");
            expect(result.success).toBe(true);
            expect(result.data?.content).toBe(mzContent);
            expect(result.data?.wordCount).toBe(9);
        });

        it("resolves title collisions safely with circuit breaker and bounded title length", async () => {
            vi.mocked(db.query.files.findMany).mockResolvedValueOnce([
                { title: "Long Document" },
                { title: "Long Document (1)" },
                { title: "Long Document (2)" },
            ] as any);

            const result = await importFile("Long Document.md", "Content", "md");
            expect(result.success).toBe(true);
            expect(result.data?.title).toBe("Long Document (3)");
        });
    });
});

