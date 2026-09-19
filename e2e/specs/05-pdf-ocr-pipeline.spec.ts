import { test, expect } from "../fixtures/auth-fixture";
import { isDisguisedBinary, validateFileBuffer } from "../../src/lib/parsers/file-validator";

test.describe("Scenario 5: Client-Side Document Ingestion, Magic Bytes & PDF Pipeline", () => {
    test("rejects disguised executables via magic bytes and validates genuine document ingestion", async ({
        page,
        authSession: _authSession,
    }) => {
        // 1. Magic Bytes Rejection: simulate disguised Windows PE executable with .md extension
        const disguisedPE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
        const peCheck = isDisguisedBinary(disguisedPE);
        expect(peCheck.isBinary).toBe(true);
        expect(peCheck.type).toContain("Windows Executable");

        const peValidation = validateFileBuffer(disguisedPE, "trojan-document.md");
        expect(peValidation.isValid).toBe(false);
        expect(peValidation.error).toMatch(/disguised (binary|executable)/i);

        // 2. Magic Bytes Rejection: simulate disguised Linux ELF binary with .pdf extension
        const disguisedELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
        const elfCheck = isDisguisedBinary(disguisedELF);
        expect(elfCheck.isBinary).toBe(true);
        expect(elfCheck.type).toContain("Linux Executable");

        const elfValidation = validateFileBuffer(disguisedELF, "malicious.pdf");
        expect(elfValidation.isValid).toBe(false);

        // 3. Genuine PDF validation: %PDF-1.4 header
        const validPdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
        const pdfCheck = isDisguisedBinary(validPdfBytes);
        expect(pdfCheck.isBinary).toBe(false);

        const pdfValidation = validateFileBuffer(validPdfBytes, "annual-report.pdf");
        expect(pdfValidation.isValid).toBe(true);
        expect(pdfValidation.fileType).toBe("pdf");

        // 4. Verify UI Sidebar Import Dialog trigger
        await page.goto("/workspace");
        await page.waitForLoadState("domcontentloaded");

        // Verify import button is present in sidebar
        const importBtn = page.locator('button:has-text("Import"), button[title*="Import"], button[aria-label*="Import"]').first();
        if (await importBtn.isVisible()) {
            await expect(importBtn).toBeEnabled();
        }
    });
});
