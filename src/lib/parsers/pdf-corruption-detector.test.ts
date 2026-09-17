import { describe, it, expect } from 'vitest';
import {
    isPuaCodePoint,
    isReplacementOrControl,
    analyzeTextContentCorruption,
    detectPdfFontCorruption,
} from './pdf-corruption-detector';

describe('PDF Font Corruption Detector', () => {
    describe('isPuaCodePoint', () => {
        it('identifies BMP Private Use Area (U+E000 to U+F8FF)', () => {
            expect(isPuaCodePoint(0xe000)).toBe(true);
            expect(isPuaCodePoint(0xe002)).toBe(true);
            expect(isPuaCodePoint(0xf8ff)).toBe(true);
            expect(isPuaCodePoint(0x0627)).toBe(false); // Arabic Alif
            expect(isPuaCodePoint(0x0041)).toBe(false); // Latin 'A'
        });

        it('identifies Supplementary PUA planes (Plane 15 & Plane 16)', () => {
            expect(isPuaCodePoint(0xf0000)).toBe(true);
            expect(isPuaCodePoint(0x100000)).toBe(true);
            expect(isPuaCodePoint(0x10fffd)).toBe(true);
            expect(isPuaCodePoint(0x1f600)).toBe(false); // Emoji
        });
    });

    describe('isReplacementOrControl', () => {
        it('identifies replacement and unprintable control characters', () => {
            expect(isReplacementOrControl(0xfffd)).toBe(true);
            expect(isReplacementOrControl(0x0001)).toBe(true);
            expect(isReplacementOrControl(0x0007)).toBe(true);
            expect(isReplacementOrControl(0x0009)).toBe(false); // \t
            expect(isReplacementOrControl(0x000a)).toBe(false); // \n
            expect(isReplacementOrControl(0x000d)).toBe(false); // \r
            expect(isReplacementOrControl(0x0020)).toBe(false); // Space
        });
    });

    describe('analyzeTextContentCorruption', () => {
        it('returns false for clean English text', () => {
            const pages = [
                'Policy schedule - Motor Insurance TPL. All terms and conditions apply.',
                'The insured shall notify the company in the event of an accident.',
            ];
            const report = analyzeTextContentCorruption(pages);
            expect(report.isCorrupted).toBe(false);
            expect(report.puaCount).toBe(0);
            expect(report.score).toBe(0);
        });

        it('returns false for clean connected Arabic text', () => {
            const pages = [
                'جدول وثيقة تأمين المركبات ضد الغير. المملكة العربية السعودية.',
                'شروط وأحكام الوثيقة الموحدة للتأمين الإلزامي.',
            ];
            const report = analyzeTextContentCorruption(pages);
            expect(report.isCorrupted).toBe(false);
            expect(report.puaCount).toBe(0);
            expect(report.fragmentationRatio).toBeLessThan(0.35);
        });

        it('detects PUA-encoded embedded fonts (e.g. AlSagr/Foxit style)', () => {
            // Simulated PUA string with \uE002, \uE004, etc.
            const puaSample = 'Policy TPL ا \uE002 ﻐ \uE004 ﺮ \uE006 ﺪ ا \uE002 \uE008 ﺮ ﻛ \uE00A ﺎ ت \uE00D ﺄ \uE00F \uE004 \uE010';
            const report = analyzeTextContentCorruption([puaSample]);
            expect(report.isCorrupted).toBe(true);
            expect(report.reason).toBe('PUA_ENCODED_FONT');
            expect(report.puaCount).toBeGreaterThan(5);
        });

        it('detects unmapped replacement characters', () => {
            const corruptSample = 'Some text \uFFFD\uFFFD\uFFFD\uFFFD with missing glyphs';
            const report = analyzeTextContentCorruption([corruptSample]);
            expect(report.isCorrupted).toBe(true);
            expect(report.reason).toBe('REPLACEMENT_CHARACTERS');
        });

        it('detects severely fragmented Arabic letter streams', () => {
            // Every Arabic word is completely broken into single characters separated by spaces
            const fragmentedSample = 'ا ل م م ل ك ة ا ل ع ر ب ي ة ا ل س ع و د ي ة و ث ي ق ة ت أ م ي ن';
            const report = analyzeTextContentCorruption([fragmentedSample]);
            expect(report.isCorrupted).toBe(true);
            expect(report.reason).toBe('SEVERE_FRAGMENTATION');
        });
    });

    describe('detectPdfFontCorruption with real PDF buffer', () => {
        function createMinimalPdf(streamContent: string): Uint8Array {
            const stream = `BT /F1 12 Tf 100 700 Td (${streamContent}) Tj ET`;
            const pdfSource = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${stream.length} >> stream
${stream}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
00000000117 00000 n 
00000000253 00000 n 
00000000350 00000 n 
trailer << /Root 1 0 R /Size 6 >>
startxref
450
%%EOF`;
            return new TextEncoder().encode(pdfSource);
        }

        it('correctly passes clean PDF documents without corruption flag', async () => {
            const cleanPdf = createMinimalPdf('Standard English text in clean PDF document');
            const report = await detectPdfFontCorruption(cleanPdf);
            expect(report.isCorrupted).toBe(false);
            expect(report.score).toBe(0);
        });
    });
});
