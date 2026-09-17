/**
 * Fast Language Detector for Document Processing
 *
 * Inspects a sample of text to determine whether the content is
 * Arabic, English, or bilingual (Arabic + English) using Unicode character ranges.
 */

export type DetectedDocumentLanguage = 'ara' | 'eng' | 'ara+eng';

// Arabic Unicode blocks: Basic Arabic, Arabic Supplement, Arabic Extended-A, Presentation Forms-A and B
const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ENGLISH_REGEX = /[a-zA-Z]/;

export interface LanguageDetectionResult {
    language: DetectedDocumentLanguage;
    hasArabic: boolean;
    hasEnglish: boolean;
    arabicCount: number;
    englishCount: number;
}

/**
 * Detects the dominant language(s) of a document string in O(N) time.
 *
 * @param text The sample text to analyze (typically the first 1000-2000 characters).
 * @param threshold Minimum character count to consider a script present (default: 3).
 */
export function detectDocumentLanguage(
    text: string,
    threshold: number = 3
): LanguageDetectionResult {
    if (!text || typeof text !== 'string') {
        return {
            language: 'ara+eng',
            hasArabic: false,
            hasEnglish: false,
            arabicCount: 0,
            englishCount: 0,
        };
    }

    let arabicCount = 0;
    let englishCount = 0;

    // Scan sample characters up to a max limit for ultra-fast response
    const limit = Math.min(text.length, 3000);
    for (let i = 0; i < limit; i++) {
        const char = text[i];
        if (ARABIC_REGEX.test(char)) {
            arabicCount++;
        } else if (ENGLISH_REGEX.test(char)) {
            englishCount++;
        }
    }

    const hasArabic = arabicCount >= threshold;
    const hasEnglish = englishCount >= threshold;

    let language: DetectedDocumentLanguage;
    if (hasArabic && hasEnglish) {
        language = 'ara+eng';
    } else if (hasArabic) {
        language = 'ara';
    } else if (hasEnglish) {
        language = 'eng';
    } else {
        // Fallback for neutral or scanned numbers/symbols: bilingual model covers all
        language = 'ara+eng';
    }

    return {
        language,
        hasArabic,
        hasEnglish,
        arabicCount,
        englishCount,
    };
}
