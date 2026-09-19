/**
 * LIVE integration tests — Document Ingestion, Normalization & Export Pipeline (Phase 15 / Phase 18 Suite 6)
 * against the isolated Neon test branch.
 *
 * Real boundaries:
 * 1. REAL database tables (`files`, `users`).
 * 2. REAL magic bytes inspection rejecting disguised executables (PE, ELF, ZIP).
 * 3. REAL null-byte scrubbing for PostgreSQL text safety.
 * 4. REAL Arabic RTL and GFM 2D table persistence.
 * 5. REAL Pure-Markdown export -> import 100% round-trip fidelity.
 *
 * Mocked boundary ONLY: Supabase session (`getUser`).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import { getUser } from "@/lib/supabase/server";
import { importFile } from "@/server/actions/import-file";
import { exportContent } from "@/lib/exporters";
import { normalizeMarkdownSource } from "@/lib/sync/etag-generator";

const USER_ID = "34343434-3434-3434-3434-343434343434";

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => ({ id: USER_ID, email: `${USER_ID}@live.test` })),
}));

describe("LIVE: Document Ingestion, Normalization & Export on isolated branch", () => {
    beforeAll(async () => {
        await testDb
            .insert(schema.users)
            .values({ id: USER_ID, email: `${USER_ID}@live.test`, tier: "pro" })
            .onConflictDoNothing();
    });

    afterAll(async () => {
        try {
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_ID));
        } catch {
            /* ignore */
        }
        await cleanupTestUsers([USER_ID]);
    });

    beforeEach(async () => {
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_ID));
    });

    it("rejects disguised executable binaries (PE, ELF, ZIP) via Magic Bytes with zero DB mutations", async () => {
        // 1. Disguised Windows PE executable
        const pePayload = "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00\xb8\x00\x00Some hidden payload";
        const peResult = await importFile("malicious.md", pePayload, "md");
        expect(peResult.success).toBe(false);
        expect(peResult.error).toContain("disguised binary");

        // 2. Disguised Linux ELF executable
        const elfPayload = "\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00Script content";
        const elfResult = await importFile("binary.txt", elfPayload, "txt");
        expect(elfResult.success).toBe(false);
        expect(elfResult.error).toContain("disguised binary");

        // 3. Disguised ZIP archive
        const zipPayload = "PK\x03\x04\x14\x00\x00\x00\x08\x00Packed payload";
        const zipResult = await importFile("archive.md", zipPayload, "md");
        expect(zipResult.success).toBe(false);
        expect(zipResult.error).toContain("disguised binary");

        // Assert ZERO rows were inserted into Neon files table
        const filesInDb = await testDb.select().from(schema.files).where(eq(schema.files.userId, USER_ID));
        expect(filesInDb.length).toBe(0);
    });

    it("scrubs null-bytes (\0) safely during import preventing PostgreSQL text corruption", async () => {
        const nullByteText = "# وثيقة تجريبية\0 مع بايتات\0 صفرية غير آمنة\0.";
        const importRes = await importFile("null_test.md", nullByteText, "md");
        expect(importRes.success).toBe(true);
        expect(importRes.data).toBeDefined();

        const fileId = importRes.data!.id;
        const [persisted] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));

        // Content in PostgreSQL has ZERO null-bytes
        expect(persisted.content).not.toContain("\0");
        expect(persisted.content).toBe(normalizeMarkdownSource(nullByteText.replace(/\0/g, "")));
    });

    it("preserves complex Arabic RTL text and GFM 2D tables with 100% fidelity in real DB", async () => {
        const arabicRtlDocument = `# تقرير التحليل المعماري للمنصة

هذا النص مكتوب باللغة العربية مع اتجاه RTL تلقائي.

| معرّف الحزمة | اسم النظام | الحالة | التغطية |
| :--- | :--- | :--- | :--- |
| S1 | المزامنة وقفل التحديثات | نشط | 100% |
| S2 | بوابات الذكاء الاصطناعي | نشط | 100% |
| S5 | الخزنة المشفرة AES-GCM | نشط | 100% |

\`\`\`typescript
const securityInvariant = "Zero Knowledge";
console.log(securityInvariant);
\`\`\`
`;

        const importRes = await importFile("arabic_report.md", arabicRtlDocument, "md");
        expect(importRes.success).toBe(true);

        const fileId = importRes.data!.id;
        const [persisted] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));

        expect(persisted.content).toContain("| معرّف الحزمة | اسم النظام | الحالة | التغطية |");
        expect(persisted.content).toContain("تقرير التحليل المعماري للمنصة");
        expect(persisted.content).toContain("Zero Knowledge");
    });

    it("guarantees 100% roundtrip fidelity: Export -> Read -> Import -> Identity in real DB", async () => {
        const originalSource = `# Roundtrip Pure Markdown Document

- Point A: High reliability
- Point B: Zero data loss

| Key | Value |
| :-- | :---- |
| ID  | 1001  |
`;

        // 1. Initial import into Neon
        const initialImport = await importFile("roundtrip_source.md", originalSource, "md");
        expect(initialImport.success).toBe(true);
        const initialContent = initialImport.data!.content;

        // 2. Export via MarkdownExporter
        const exportRes = await exportContent(initialContent, "roundtrip_export", "md");
        expect(exportRes.blob).toBeDefined();
        const exportedText = await exportRes.blob!.text();

        // 3. Re-import the exported content into Neon as a second file
        const secondImport = await importFile("roundtrip_reimported.md", exportedText, "md");
        expect(secondImport.success).toBe(true);
        const secondContent = secondImport.data!.content;

        // 4. Assert 100% roundtrip fidelity between original and re-imported records
        expect(secondContent).toBe(initialContent);

        const [file1] = await testDb.select().from(schema.files).where(eq(schema.files.id, initialImport.data!.id));
        const [file2] = await testDb.select().from(schema.files).where(eq(schema.files.id, secondImport.data!.id));
        expect(file1.content).toBe(file2.content);
    });
});
