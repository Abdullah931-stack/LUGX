/**
 * Universal PDF Font Corruption & Illegibility Detector
 *
 * Deterministically analyzes extracted text streams to identify documents
 * containing unmapped embedded subset fonts, Private Use Area (PUA) codepoints,
 * or extreme character fragmentation before presenting distorted output to the user.
 */

export interface FontCorruptionReport {
    isCorrupted: boolean;
    score: number;
    puaCount: number;
    replacementCount: number;
    fragmentationRatio: number;
    totalPagesSampled: number;
    reason?: 'PUA_ENCODED_FONT' | 'REPLACEMENT_CHARACTERS' | 'SEVERE_FRAGMENTATION';
}

/**
 * Checks if a Unicode codepoint falls within standard Private Use Area (PUA) ranges.
 * - BMP PUA: U+E000 to U+F8FF
 * - Plane 15 PUA: U+F0000 to U+FFFFD
 * - Plane 16 PUA: U+100000 to U+10FFFD
 */
export function isPuaCodePoint(code: number): boolean {
    return (
        (code >= 0xe000 && code <= 0xf8ff) ||
        (code >= 0xf0000 && code <= 0xffffd) ||
        (code >= 0x100000 && code <= 0x10fffd)
    );
}

/**
 * Checks if a character is a non-standard replacement or unprintable control character.
 */
export function isReplacementOrControl(code: number): boolean {
    if (code === 0xfffd) return true; // Unicode Replacement Character 
    // Control characters excluding standard whitespace (\t = 9, \n = 10, \r = 13)
    if (code >= 0x0000 && code <= 0x0008) return true;
    if (code === 0x000b || code === 0x000c) return true;
    if (code >= 0x000e && code <= 0x001f) return true;
    return false;
}

/**
 * Analyzes raw text content across sampled pages to detect font encoding defects.
 */
export function analyzeTextContentCorruption(pagesText: string[]): FontCorruptionReport {
    let totalNonWhitespace = 0;
    let puaCount = 0;
    let replacementCount = 0;

    let totalArabicChars = 0;
    let isolatedArabicChars = 0;

    for (const pageText of pagesText) {
        if (!pageText) continue;

        // Iterate over code points (handling 32-bit supplementary plane characters properly)
        for (const char of pageText) {
            const code = char.codePointAt(0);
            if (code === undefined) continue;

            // Skip standard whitespace
            if (/\s/.test(char)) continue;

            totalNonWhitespace++;

            if (isPuaCodePoint(code)) {
                puaCount++;
            } else if (isReplacementOrControl(code)) {
                replacementCount++;
            }

            // Arabic range check
            if (/[\u0600-\u06FF\uFB50-\uFEFF]/.test(char)) {
                totalArabicChars++;
            }
        }

        // Check for isolated Arabic character fragmentation (runs of single letters with spaces)
        const tokens = pageText.split(/\s+/).filter(Boolean);
        for (const token of tokens) {
            if (token.length === 1 && /[\u0600-\u06FF\uFB50-\uFEFF]/.test(token)) {
                isolatedArabicChars++;
            }
        }
    }

    if (totalNonWhitespace === 0) {
        return {
            isCorrupted: false,
            score: 0,
            puaCount: 0,
            replacementCount: 0,
            fragmentationRatio: 0,
            totalPagesSampled: pagesText.length,
        };
    }

    const puaRatio = puaCount / totalNonWhitespace;
    const replacementRatio = replacementCount / totalNonWhitespace;
    const combinedScore = (puaCount + replacementCount) / totalNonWhitespace;
    const fragmentationRatio = totalArabicChars > 15 ? isolatedArabicChars / totalArabicChars : 0;

    // Classification Thresholds (Universal & Non-Overfitted):
    // 1. If PUA codepoints exceed 2.5% of total non-whitespace content -> PUA_ENCODED_FONT
    // 2. If replacement / control characters exceed 2.0% -> REPLACEMENT_CHARACTERS
    // 3. If Arabic single-letter fragmentation exceeds 35% with at least 15 Arabic characters -> SEVERE_FRAGMENTATION
    if (puaRatio >= 0.025) {
        return {
            isCorrupted: true,
            score: combinedScore,
            puaCount,
            replacementCount,
            fragmentationRatio,
            totalPagesSampled: pagesText.length,
            reason: 'PUA_ENCODED_FONT',
        };
    }

    if (replacementRatio >= 0.02) {
        return {
            isCorrupted: true,
            score: combinedScore,
            puaCount,
            replacementCount,
            fragmentationRatio,
            totalPagesSampled: pagesText.length,
            reason: 'REPLACEMENT_CHARACTERS',
        };
    }

    if (fragmentationRatio >= 0.35) {
        return {
            isCorrupted: true,
            score: fragmentationRatio,
            puaCount,
            replacementCount,
            fragmentationRatio,
            totalPagesSampled: pagesText.length,
            reason: 'SEVERE_FRAGMENTATION',
        };
    }

    return {
        isCorrupted: false,
        score: combinedScore,
        puaCount,
        replacementCount,
        fragmentationRatio,
        totalPagesSampled: pagesText.length,
    };
}

/**
 * Inspects a PDF ArrayBuffer by sampling its first N pages to detect font corruption.
 *
 * @param data - Raw PDF binary data (ArrayBuffer or Uint8Array)
 * @param maxPages - Maximum number of pages to sample (defaults to 5)
 */
export async function detectPdfFontCorruption(
    data: ArrayBuffer | Uint8Array,
    maxPages = 5
): Promise<FontCorruptionReport> {
    const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);

    // Dynamic import of pdfjs-dist for browser and test environment isolation
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
        if (typeof window !== 'undefined') {
            pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        }
    }

    // Worker safe DOM polyfill for getDocument (scoped exclusively to WebWorker threads)
    if (typeof document === 'undefined' && typeof self !== 'undefined' && (typeof (self as unknown as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' || typeof (self as unknown as { importScripts?: unknown }).importScripts === 'function')) {
        const workerHref = (typeof self !== 'undefined' && 'location' in self && (self as unknown as { location?: { href?: string } }).location?.href) || '';
        (globalThis as unknown as { document: unknown }).document = {
            baseURI: workerHref,
            documentElement: null,
            head: null,
            body: null,
            createElement: () => ({ append: () => {}, appendChild: () => {}, setAttribute: () => {} }),
            getElementsByTagName: () => [],
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: () => null,
        };
    }

    let pdfDoc;
    try {
        pdfDoc = await pdfjs.getDocument({
            data: uint8Data,
            cMapUrl: '/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: '/standard_fonts/',
            useWorkerFetch: true,
            isEvalSupported: false,
            useSystemFonts: false,
            disableFontFace: true,
            verbosity: 0,
        }).promise;
    } catch {
        // If document fails to load here, let the main extraction pipeline handle the specific load error
        return {
            isCorrupted: false,
            score: 0,
            puaCount: 0,
            replacementCount: 0,
            fragmentationRatio: 0,
            totalPagesSampled: 0,
        };
    }

    const pagesToSample = Math.min(maxPages, pdfDoc.numPages);
    const pagesText: string[] = [];

    try {
        for (let pageNum = 1; pageNum <= pagesToSample; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            try {
                const textContent = await page.getTextContent();
                const pageString = textContent.items
                    .map((item) => ('str' in item ? (item.str as string) : ''))
                    .join(' ');
                pagesText.push(pageString);
            } finally {
                try {
                    page.cleanup();
                } catch {}
            }
        }
    } finally {
        try {
            await pdfDoc.destroy();
        } catch {}
    }

    return analyzeTextContentCorruption(pagesText);
}
