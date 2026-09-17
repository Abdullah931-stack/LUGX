import { describe, it, expect } from 'vitest';
import { detectDocumentLanguage } from './language-detector';

describe('Language Detector', () => {
    it('detects pure Arabic text', () => {
        const text = 'جدول وثيقة تأمين المركبات ضد الغير شركة الصقر للتأمين التعاوني';
        const result = detectDocumentLanguage(text);
        expect(result.language).toBe('ara');
        expect(result.hasArabic).toBe(true);
        expect(result.hasEnglish).toBe(false);
    });

    it('detects pure English text', () => {
        const text = 'Policy schedule Motor Insurance TPL Policy Particulars Policy Number';
        const result = detectDocumentLanguage(text);
        expect(result.language).toBe('eng');
        expect(result.hasArabic).toBe(false);
        expect(result.hasEnglish).toBe(true);
    });

    it('detects bilingual Arabic and English text', () => {
        const text = 'Policy schedule-Motor Insurance TPL جدول وثيقة تأمين المركبات ضد الغير 05/01/2026';
        const result = detectDocumentLanguage(text);
        expect(result.language).toBe('ara+eng');
        expect(result.hasArabic).toBe(true);
        expect(result.hasEnglish).toBe(true);
    });

    it('detects Arabic presentation forms', () => {
        // Text using presentation forms like \uFE8E, \uFE91
        const text = 'ﺟ ﺪ و ل ﻭ ﺛ ﻴ ﻘ ﺔ';
        const result = detectDocumentLanguage(text);
        expect(result.hasArabic).toBe(true);
    });

    it('handles empty or non-alphabetical strings by falling back to ara+eng', () => {
        expect(detectDocumentLanguage('').language).toBe('ara+eng');
        expect(detectDocumentLanguage('1234567890 !@#$%^&*()').language).toBe('ara+eng');
    });
});
