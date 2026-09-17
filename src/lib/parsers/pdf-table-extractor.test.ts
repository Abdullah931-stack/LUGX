import { describe, it, expect } from 'vitest';
import { extractSpatialPdfTableContent, SpatialTextItem } from './pdf-table-extractor';

describe('Spatial PDF Table Extractor', () => {
    it('correctly detects a 3-column bilingual table and generates Markdown', () => {
        const items: SpatialTextItem[] = [
            // Row 1: y = 700
            { str: 'Policy issuance Date', x: 50, y: 700, width: 100 },
            { str: '05/01/2026', x: 250, y: 700, width: 60 },
            { str: 'تاريخ إصدار الوثيقة', x: 480, y: 700, width: 90 },

            // Row 2: y = 670
            { str: 'Policy Number', x: 50, y: 670, width: 80 },
            { str: 'P/2001/5504/26/482160', x: 250, y: 670, width: 120 },
            { str: 'رقم وثيقة التأمين', x: 480, y: 670, width: 80 },

            // Row 3: y = 640
            { str: 'Product ID Number (IA)', x: 50, y: 640, width: 110 },
            { str: 'A-SAGR-1-B-15-002', x: 250, y: 640, width: 100 },
            { str: 'رقم المنتج التعريفي', x: 480, y: 640, width: 90 },
        ];

        const md = extractSpatialPdfTableContent(items);

        // Check that valid Markdown table syntax was produced
        expect(md).toContain('| Policy issuance Date | 05/01/2026 | تاريخ إصدار الوثيقة |');
        expect(md).toContain('| :--- | :--- | :--- |');
        expect(md).toContain('| Policy Number | P/2001/5504/26/482160 | رقم وثيقة التأمين |');
        expect(md).toContain('| Product ID Number (IA) | A-SAGR-1-B-15-002 | رقم المنتج التعريفي |');
    });

    it('formats section headers preceding tables', () => {
        const items: SpatialTextItem[] = [
            { str: 'Vehicle Details بيانات المركبة', x: 50, y: 800, width: 200 },
            // Table row 1
            { str: 'Vehicle Make', x: 50, y: 750, width: 80 },
            { str: 'نيسان', x: 250, y: 750, width: 40 },
            // Table row 2
            { str: 'Vehicle Model', x: 50, y: 720, width: 80 },
            { str: 'بك اب غماره', x: 250, y: 720, width: 60 },
        ];

        const md = extractSpatialPdfTableContent(items);
        expect(md).toContain('### Vehicle Details بيانات المركبة');
        expect(md).toContain('| Vehicle Make | نيسان |');
        expect(md).toContain('| Vehicle Model | بك اب غماره |');
    });

    it('outputs linear non-table text when disableTables is true', () => {
        const items: SpatialTextItem[] = [
            { str: 'Policy issuance Date', x: 50, y: 700, width: 100 },
            { str: '05/01/2026', x: 250, y: 700, width: 60 },
            { str: 'تاريخ إصدار الوثيقة', x: 480, y: 700, width: 90 },

            { str: 'Policy Number', x: 50, y: 670, width: 80 },
            { str: 'P/2001/5504/26/482160', x: 250, y: 670, width: 120 },
            { str: 'رقم وثيقة التأمين', x: 480, y: 670, width: 80 },
        ];

        const linearOutput = extractSpatialPdfTableContent(items, { disableTables: true });

        // Should NOT contain markdown table syntax or delimiter rows
        expect(linearOutput).not.toContain('|');
        expect(linearOutput).not.toContain(':---');

        // Should preserve text content and line separation
        expect(linearOutput).toContain('Policy issuance Date');
        expect(linearOutput).toContain('05/01/2026');
        expect(linearOutput).toContain('تاريخ إصدار الوثيقة');
        expect(linearOutput).toContain('Policy Number');
        expect(linearOutput).toContain('P/2001/5504/26/482160');
    });

    it('handles empty or blank item lists gracefully', () => {
        expect(extractSpatialPdfTableContent([])).toBe('');
        expect(extractSpatialPdfTableContent([{ str: '   ', x: 0, y: 0 }])).toBe('');
    });

    it('replaces embedded newlines within table cells with spaces to prevent row breaking', () => {
        const items: SpatialTextItem[] = [
            // Row 1
            { str: 'Multi-line\nHeader', x: 50, y: 700, width: 80 },
            { str: 'Description\r\nColumn', x: 250, y: 700, width: 80 },
            // Row 2
            { str: 'Item 1\nDetails', x: 50, y: 670, width: 80 },
            { str: 'Value with\r\nembedded break', x: 250, y: 670, width: 80 },
        ];

        const md = extractSpatialPdfTableContent(items);
        const lines = md.trim().split('\n');

        // Must produce exactly 3 lines (header, delimiter, data row 1) - no stray wrapped lines
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe('| Multi-line Header | Description Column |');
        expect(lines[1]).toBe('| :--- | :--- |');
        expect(lines[2]).toBe('| Item 1 Details | Value with embedded break |');
    });
});

