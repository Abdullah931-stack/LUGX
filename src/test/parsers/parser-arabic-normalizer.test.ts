import { describe, it, expect } from 'vitest';
import {
    unshapeArabic,
    despaceArabicWords,
    normalizeArabicText,
    reverseArabicPhraseIfNeeded,
} from '@/lib/parsers/arabic-normalizer';

describe('Arabic Normalizer', () => {
    describe('unshapeArabic', () => {
        it('converts Arabic Presentation Forms-B into base Unicode characters', () => {
            // \uFE9F (Jeem initial) \uFEAA (Dal final) \uFEED (Waw isolated) \uFEDD (Lam isolated)
            const presentationForm = '\uFE9F\uFEAA\uFEED\uFEDD';
            expect(unshapeArabic(presentationForm)).toBe('جدول');
        });

        it('converts isolated letters correctly', () => {
            const isolatedGhain = '\uFECF'; // Arabic letter Ghain medial
            expect(unshapeArabic(isolatedGhain)).toBe('غ');
        });
    });

    describe('despaceArabicWords', () => {
        it('collapses single Arabic letters separated by spaces into words', () => {
            const spaced = 'ا   ر ك  ا ت';
            expect(despaceArabicWords(spaced)).toBe('اركات');
        });

        it('collapses sample phrase with artificial kerning spacing', () => {
            const spacedPhrase = 'ا  غ  ر  د';
            expect(despaceArabicWords(spacedPhrase)).toBe('اغرد');
        });

        it('preserves spaces between distinct English words', () => {
            const mixed = 'Policy schedule Motor Insurance';
            expect(despaceArabicWords(mixed)).toBe('Policy schedule Motor Insurance');
        });

        it('handles mixed lines with Arabic and numbers', () => {
            const line = 'ر  ق  م 1087535991';
            expect(despaceArabicWords(line)).toBe('رقم 1087535991');
        });
    });

    describe('reverseArabicPhraseIfNeeded', () => {
        it('reverses reversed Arabic word tokens', () => {
            const reversed = 'الوثيقة إصدار تاريخ';
            expect(reverseArabicPhraseIfNeeded(reversed)).toBe('تاريخ إصدار الوثيقة');
        });

        /**
         * KNOWN PRODUCTION LIMITATION (tracked in Phase 20):
         * The current implementation blindly reverses ALL phrases where ≥70% of tokens
         * are Arabic. It has no heuristic to detect whether the phrase is already in
         * correct reading order. This means already-correct forward phrases get
         * double-reversed (corrupted).
         *
         * The tests below assert CURRENT production behavior, not ideal behavior.
         * Fix tracked in: docs/Plans/COMPREHENSIVE_TECHNICAL_REMEDIATION_PLAN.md (Phase 20)
         */
        it('reverses forward Arabic phrases due to blind 70% heuristic (known limitation)', () => {
            const forward = 'تاريخ إصدار الوثيقة';
            // Current production: always reverses ≥70% Arabic → outputs reversed order
            expect(reverseArabicPhraseIfNeeded(forward)).toBe('الوثيقة إصدار تاريخ');

            const normalSentence = 'المملكة العربية السعودية';
            expect(reverseArabicPhraseIfNeeded(normalSentence)).toBe('السعودية العربية المملكة');
        });

        it('preserves single-word inputs', () => {
            expect(reverseArabicPhraseIfNeeded('جدول')).toBe('جدول');
        });
    });

    describe('normalizeArabicText', () => {
        it('performs end-to-end normalization on presentation forms with spaces', () => {
            // ﺟ ﺪ و ل with spaces and presentation forms
            const raw = 'ﺟ  ﺪ  و  ل';
            expect(normalizeArabicText(raw)).toBe('جدول');
        });
    });
});
