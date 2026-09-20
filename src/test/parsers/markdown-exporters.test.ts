import { describe, it, expect } from "vitest";
import { exportContent } from "@/lib/exporters";
import { MarkdownExporter } from "@/lib/exporters/strategies/markdown-exporter";
import { TextExporter } from "@/lib/exporters/strategies/text-exporter";

describe("Markdown & Text Exporters (Phase 5 Markdown Source of Truth)", () => {
    describe("MarkdownExporter", () => {
        it("should export raw Markdown preserving all formatting, code blocks, tables, and RTL text exactly as-is", async () => {
            const rawMarkdown = `# عنوان رئيسي\n\nهذا نص تجريبي يحتوي على **تنسيق عريض** و *مائل*.\n\n| العمود 1 | العمود 2 |\n|---|---|\n| قيمة 1 | قيمة 2 |\n\n\`\`\`typescript\nconst x: number = 42;\nconsole.log(x);\n\`\`\`\n\n- [ ] قائمة مهام\n- [x] مهمة منجزة\n\n[رابط تجريبي](https://example.com)\n\n<custom-tag>نص داخل وسم</custom-tag>`;

            const exporter = new MarkdownExporter();
            const result = await exporter.export(rawMarkdown, "test-doc");

            expect(result.success).toBe(true);
            expect(result.filename).toBe("test-doc.md");
            expect(result.blob).toBeDefined();

            // Read text from blob
            const exportedText = await result.blob!.text();
            expect(exportedText).toBe(rawMarkdown);
            expect(exportedText).toContain("# عنوان رئيسي");
            expect(exportedText).toContain("**تنسيق عريض**");
            expect(exportedText).toContain("| العمود 1 | العمود 2 |");
            expect(exportedText).toContain("const x: number = 42;");
            expect(exportedText).toContain("<custom-tag>نص داخل وسم</custom-tag>");
        });

        it("should sanitize dangerous filename characters and enforce .md extension", async () => {
            const exporter = new MarkdownExporter();
            const result = await exporter.export("# Content", "invalid/file:name*?doc");

            expect(result.success).toBe(true);
            expect(result.filename).toBe("invalidfilenamedoc.md");
        });

        it("should reject null or undefined content with ExportError", async () => {
            const exporter = new MarkdownExporter();
            const result = await exporter.export(null as any, "doc");

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe("INVALID_CONTENT");
        });
    });

    describe("TextExporter", () => {
        it("should strip all Markdown syntax directly from raw text to produce clean plain text", async () => {
            const rawMarkdown = `# Header 1\n\nThis is **bold** and *italic* text with a [link](https://example.com).\n\n## Subheader\n\n- Item 1\n- Item 2\n\n\`inline code\`\n\n> Blockquote text`;

            const exporter = new TextExporter();
            const result = await exporter.export(rawMarkdown, "plain-doc");

            expect(result.success).toBe(true);
            expect(result.filename).toBe("plain-doc.txt");
            expect(result.blob).toBeDefined();

            const exportedText = await result.blob!.text();
            expect(exportedText).not.toContain("# Header 1");
            expect(exportedText).toContain("Header 1");
            expect(exportedText).not.toContain("**bold**");
            expect(exportedText).toContain("bold");
            expect(exportedText).not.toContain("*italic*");
            expect(exportedText).toContain("italic");
            expect(exportedText).not.toContain("[link](https://example.com)");
            expect(exportedText).toContain("link");
            expect(exportedText).not.toContain("`inline code`");
            expect(exportedText).toContain("inline code");
        });

        it("should preserve code block content while stripping triple-backtick fences in txt export", async () => {
            const rawMarkdown = `# Code Sample\n\n\`\`\`typescript\nconst total: number = 100;\nconsole.log(total);\n\`\`\`\n\nFinal note.`;

            const exporter = new TextExporter();
            const result = await exporter.export(rawMarkdown, "code-sample");

            expect(result.success).toBe(true);
            const text = await result.blob!.text();
            expect(text).not.toContain("```");
            expect(text).toContain("const total: number = 100;");
            expect(text).toContain("console.log(total);");
            expect(text).toContain("Final note.");
        });
    });

    describe("ExporterFactory & exportContent Facade", () => {
        it("should route md and txt export requests to the correct strategy", async () => {
            const mdResult = await exportContent("# Heading", "file", "md");
            expect(mdResult.success).toBe(true);
            expect(mdResult.filename).toBe("file.md");

            const txtResult = await exportContent("# Heading", "file", "txt");
            expect(txtResult.success).toBe(true);
            expect(txtResult.filename).toBe("file.txt");
            const txt = await txtResult.blob!.text();
            expect(txt.trim()).toBe("Heading");
        });
    });
});
