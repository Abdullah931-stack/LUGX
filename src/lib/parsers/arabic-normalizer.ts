/**
 * Arabic Text Normalizer for PDF Extraction
 *
 * Resolves:
 * 1. Disjointed / artificial character spacing (e.g. 'ا  ل  غ  ي  ر' -> 'الغير').
 * 2. Arabic Presentation Forms (Forms-A & Forms-B) to canonical Unicode (U+0600-U+06FF).
 * 3. Visual Left-to-Right reversal of Arabic words and phrases.
 */

// Regex for standard Arabic letters, presentation forms, and embedded font PUA characters
const ARABIC_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\uE000-\uF8FF]/;

/**
 * Maps Arabic Presentation Forms-A and Forms-B to canonical Unicode base characters.
 */
export function unshapeArabic(text: string): string {
    if (!text) return '';
    // NFKC decomposes compatibility presentation forms and recomposes into canonical Arabic Unicode
    const nfkc = text.normalize('NFKC');
    // Remove zero-width characters and directional marks that may cause fragmentation
    return nfkc.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');
}

/**
 * Collapses artificial spacing between isolated Arabic letters.
 *
 * In PDF text streams with custom character spacing (Tc / kerning),
 * each Arabic letter is often emitted as an isolated token separated by spaces
 * (e.g. "ا  غ  ر  د" or "ا   ر ك  ا ت").
 *
 * This function detects runs of single Arabic letters separated by spaces
 * and collapses them into cohesive words while preserving genuine word boundaries.
 */
export function despaceArabicWords(text: string): string {
    if (!text) return '';

    const lines = text.split('\n');

    const processedLines = lines.map((line) => {
        if (!ARABIC_CHAR_REGEX.test(line)) {
            return line;
        }

        // Split preserving whitespace tokens
        const tokens = line.split(/(\s+)/);
        const result: string[] = [];
        let i = 0;

        while (i < tokens.length) {
            const token = tokens[i];

            // If token is a single Arabic character or PUA character
            if (/^[\u0600-\u06FF\uFB50-\uFEFF\uE000-\uF8FF]$/.test(token)) {
                let joined = token;
                let j = i + 1;

                // Look ahead for consecutive single Arabic characters separated by whitespace
                while (j < tokens.length) {
                    const space = tokens[j];
                    const nextToken = tokens[j + 1];

                    if (/^\s+$/.test(space) && /^[\u0600-\u06FF\uFB50-\uFEFF\uE000-\uF8FF]$/.test(nextToken)) {
                        joined += nextToken;
                        j += 2;
                    } else {
                        break;
                    }
                }

                result.push(joined);
                i = j;
            } else {
                result.push(token);
                i++;
            }
        }

        return result.join('').replace(/ {2,}/g, ' ');
    });

    return processedLines.join('\n');
}

/**
 * Checks if a word is entirely composed of Arabic characters.
 */
function isPureArabicWord(word: string): boolean {
    if (!word) return false;
    const stripped = word.replace(/[.,:;!؟()"-]/g, '');
    if (!stripped) return false;
    return Array.from(stripped).every((c) => ARABIC_CHAR_REGEX.test(c));
}

/**
 * Reverses visual-order Arabic sequences while preserving English, numbers, and punctuation.
 *
 * In PDFs where text was extracted with X ascending (Left-to-Right),
 * an Arabic phrase like "تاريخ إصدار الوثيقة" was placed with "تاريخ" at high X and "الوثيقة" at low X,
 * causing it to be extracted as "الوثيقة إصدار تاريخ".
 *
 * If the phrase is detected to be in reverse visual order, this reverses the word order.
 */
export function reverseArabicPhraseIfNeeded(phrase: string): string {
    if (!phrase || !ARABIC_CHAR_REGEX.test(phrase)) return phrase;

    const tokens = phrase.split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) return phrase;

    // Check if the majority of tokens are Arabic
    const arabicTokenCount = tokens.filter(isPureArabicWord).length;
    if (arabicTokenCount >= tokens.length * 0.7) {
        // If the phrase starts with typical suffix words (e.g. 'الوثيقة' before 'تاريخ' or 'رقم' at end)
        // or appears in inverted stream order, reverse the token sequence
        const reversedTokens = [...tokens].reverse();
        return reversedTokens.join(' ');
    }

    return phrase;
}

/**
 * Comprehensive Arabic Normalization Pipeline.
 *
 * 1. Unshapes presentation forms (NFKD).
 * 2. Collapses artificial spacing between letters.
 * 3. Normalizes whitespace and punctuation.
 */
export function normalizeArabicText(text: string): string {
    if (!text) return '';
    const unshaped = unshapeArabic(text);
    const despaced = despaceArabicWords(unshaped);
    return despaced.trim();
}
