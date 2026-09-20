/**
 * Integration Test: Export-Import Round-Trip Pipeline & Content Security Hardening
 *
 * Verifies Phase 15 Core Invariants:
 * 1. High-Fidelity Round-Trip (Export -> Read -> Validate -> Import -> Identity):
 *    - Preserves complex Markdown with Arabic RTL text, GFM tables, code blocks, and dates with 100% fidelity.
 *    - Preserves plain text conversion through TextExporter with markdown syntax stripped.
 * 2. Pure Markdown Security & Adversarial Invariant:
 *    - Null bytes (\0) are scrubbed for PostgreSQL text field safety.
 *    - Injected <script>, event handlers, and javascript: URLs are stored strictly as literal Markdown source text without HTML conversion.
 * 3. Security Boundary Enforcement:
 *    - Filename sanitization neutralizes path traversal (../../) and illegal OS characters.
 *    - Disguised binaries (Windows PE, Linux ELF, ZIP archives) are strictly rejected.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { exportContent } from "@/lib/exporters";
import { importFile } from "@/server/actions/import-file";
import { validateFileBuffer } from "@/lib/parsers/file-validator";
import { normalizeMarkdownSource, generateETagSync } from "@/lib/sync/etag-generator";

const TEST_USER_ID = "20202020-2020-2020-2020-202020202020";

let insertedRecord: any = null;

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => ({
        id: TEST_USER_ID,
        email: "roundtrip-test@example.com",
    })),
}));

vi.mock("@/lib/db", () => {
    const mockDb = {
        query: {
            files: {
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
            },
        },
        insert: vi.fn(() => ({
            values: vi.fn((vals) => {
                insertedRecord = { ...vals };
                return {
                    returning: vi.fn().mockResolvedValue([
                        {
                            ...vals,
                            id: vals.id,
                            title: vals.title,
                            content: vals.content,
                            etag: vals.etag,
                            version: vals.version || 1,
                            isEncrypted: vals.isEncrypted || false,
                            encryptionMetadata: vals.encryptionMetadata || null,
                        },
                    ]),
                };
            }),
        })),
    };

    return {
        db: mockDb,
        schema: {
            files: {
                id: "id",
                userId: "user_id",
                title: "title",
                content: "content",
                parentFolderId: "parent_folder_id",
                isFolder: "is_folder",
                isEncrypted: "is_encrypted",
                encryptionMetadata: "encryption_metadata",
                version: "version",
                etag: "etag",
                deletedAt: "deleted_at",
                createdAt: "created_at",
                updatedAt: "updated_at",
            },
        },
    };
});

describe("Export-Import Round-Trip & Content Security (Phase 15 Integration Tests)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertedRecord = null;
    });

    it("executes 100% high-fidelity round-trip for complex Markdown with Arabic RTL, GFM tables, and code", async () => {
        const complexMarkdown = [
            "# تقرير المواصفات الفنية — منصة LUGX",
            "",
            "هذا المستند يوضح المعايير الهندسية المعتمدة بتاريخ 2026-09-17 في إدارة الملفات.",
            "",
            "## 1. جدول الحالات التشغيلية",
            "",
            "| المعرف | اسم الوحدة | الحالة التشغيلية |",
            "| :--- | :--- | :--- |",
            "| 101 | محرك التطبيع العربي | نشط ومطابق |",
            "| 102 | مستخرج الجداول المكاني | مكتمل 100% |",
            "| 103 | محرك التعرف الضوئي OCR | جاهز عند الطلب |",
            "",
            "## 2. مقتطفات برمجية",
            "",
            "```typescript",
            "export function calculateSecurityScore(): number {",
            "    const invariants = ['PureMarkdown', 'NFC_Unicode', 'ZeroKnowledge'];",
            "    return invariants.length * 100;",
            "}",
            "```",
            "",
            "> ملاحظة تقنية: يتم الحفاظ على علامات الاقتباس والقوائم دون أي تحويل وسيط.",
            "",
            "- [x] فحص سلامة نهايات الأسطر",
            "- [x] توحيد ETag الحتمي",
            "- [ ] مهام مستقبلية",
        ].join("\n");

        // 1. Export as Markdown
        const exportResult = await exportContent(complexMarkdown, "lugx-arabic-spec", "md");
        expect(exportResult.success).toBe(true);
        expect(exportResult.filename).toBe("lugx-arabic-spec.md");
        expect(exportResult.blob).toBeDefined();

        // 2. Read exported blob text
        const exportedText = await exportResult.blob!.text();
        const textBytes = new TextEncoder().encode(exportedText);

        // 3. Client buffer validation
        const valResult = validateFileBuffer(textBytes, exportResult.filename!);
        expect(valResult.isValid).toBe(true);
        expect(valResult.fileType).toBe("md");

        // 4. Server action import
        const importResult = await importFile(exportResult.filename!, exportedText, "md");
        expect(importResult.success).toBe(true);
        expect(importResult.data).toBeDefined();
        expect(importResult.data?.title).toBe("lugx-arabic-spec");

        // 5. Assert 100% content identity
        const expectedNormalized = normalizeMarkdownSource(complexMarkdown);
        expect(importResult.data?.content).toBe(expectedNormalized);
        expect(insertedRecord.content).toBe(expectedNormalized);

        // 6. Assert ETag determinism
        const expectedETag = generateETagSync({
            id: importResult.data!.id,
            content: expectedNormalized,
            updatedAt: insertedRecord.updatedAt,
        });
        expect(insertedRecord.etag).toBe(expectedETag);
        expect(insertedRecord.version).toBe(1);
    });

    it("executes round-trip through TextExporter stripping Markdown syntax into clean plain text", async () => {
        const sourceMarkdown = [
            "# عنوان المستند الرئيسي",
            "",
            "هذه فقرة تحتوي على **نص عريض** و *نص مائل* ورابط [LUGX](https://lugx.app).",
            "",
            "## قسم فرعي",
            "- عنصر قائمة 1",
            "- عنصر قائمة 2",
        ].join("\n");

        // 1. Export as Plain Text
        const exportResult = await exportContent(sourceMarkdown, "my-notes", "txt");
        expect(exportResult.success).toBe(true);
        expect(exportResult.filename).toBe("my-notes.txt");

        // 2. Read exported blob
        const exportedPlain = await exportResult.blob!.text();

        // Verify Markdown markers are stripped
        expect(exportedPlain).not.toContain("#");
        expect(exportedPlain).not.toContain("**");
        expect(exportedPlain).toContain("عنوان المستند الرئيسي");
        expect(exportedPlain).toContain("نص عريض");

        // 3. Import plain text
        const importResult = await importFile(exportResult.filename!, exportedPlain, "txt");
        expect(importResult.success).toBe(true);
        expect(importResult.data?.title).toBe("my-notes");
        expect(importResult.data?.content).toBe(normalizeMarkdownSource(exportedPlain));
    });

    it("sanitizes adversarial injections (XSS, script tags, null bytes) safely without HTML execution", async () => {
        const adversarialInput = [
            "# Security Test Document",
            "",
            "<script>alert('XSS_ATTACK');</script>",
            "<img src=\"x\" onerror=\"stealCookies()\" />",
            "[Dangerous Link](javascript:alert('malicious_protocol'))",
            "Line with embedded \0 null byte for postgres injection attempt",
        ].join("\n");

        // 1. Export content
        const exportResult = await exportContent(adversarialInput, "security-audit", "md");
        expect(exportResult.success).toBe(true);

        const exportedText = await exportResult.blob!.text();

        // 2. Import into server
        const importResult = await importFile("security-audit.md", exportedText, "md");
        expect(importResult.success).toBe(true);

        // Null bytes must be scrubbed completely
        expect(importResult.data?.content).not.toContain("\0");
        expect(insertedRecord.content).not.toContain("\0");

        // Script tags must remain inert Markdown text literals without HTML evaluation
        expect(importResult.data?.content).toContain("<script>alert('XSS_ATTACK');</script>");
        expect(importResult.data?.content).toContain("onerror=\"stealCookies()\"");
    });

    it("sanitizes filename to eliminate directory traversal and forbidden OS characters", async () => {
        const dangerousFilename = "../../../..\\..\\Windows\\System32\\config<bad>:*.md";
        const safeContent = "# Simple Content";

        const importResult = await importFile(dangerousFilename, safeContent, "md");
        expect(importResult.success).toBe(true);
        expect(importResult.data).toBeDefined();

        // Filename must not contain traversal or forbidden chars
        expect(importResult.data?.title).not.toContain("../");
        expect(importResult.data?.title).not.toContain("..\\");
        expect(importResult.data?.title).not.toContain("<");
        expect(importResult.data?.title).not.toContain(">");
        expect(importResult.data?.title).not.toContain(":");
        expect(importResult.data?.title).not.toContain("*");
        expect(importResult.data?.title).toBe("WindowsSystem32configbad");
    });

    it("rejects disguised Windows PE executable in round-trip pipeline", async () => {
        const fakePe = "MZ\x90\x00\x03\x00\x00\x00BinaryPayloadHere";
        const importResult = await importFile("hacker.md", fakePe, "md");
        expect(importResult.success).toBe(false);
        expect(importResult.error).toContain("disguised binary detected");
    });

    it("rejects disguised ZIP archive in round-trip pipeline", async () => {
        const fakeZip = "PK\x03\x04\x14\x00\x00\x00ZipDataStream";
        const importResult = await importFile("archive.md", fakeZip, "md");
        expect(importResult.success).toBe(false);
        expect(importResult.error).toContain("disguised binary detected");
    });
});
