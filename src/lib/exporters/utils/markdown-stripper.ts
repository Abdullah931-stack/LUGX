/**
 * Markdown Syntax Stripper Utility
 * Removes all Markdown formatting from text to produce clean plain text
 */

/**
 * Strips all Markdown syntax from text
 * @param text - Text with Markdown formatting
 * @returns Clean plain text without any Markdown syntax
 */
export function stripMarkdownSyntax(text: string): string {
    if (!text || text.trim().length === 0) {
        return '';
    }

    let cleanText = text;

    // Strip code block fences (```...```) while preserving inner code text
    cleanText = cleanText.replace(/```[^\n]*\n?([\s\S]*?)\n?```/g, '$1');

    // Remove inline code (`...`)
    cleanText = cleanText.replace(/`([^`]+)`/g, '$1');

    // Remove images ![alt](url)
    cleanText = cleanText.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '$1');

    // Remove links [text](url) - keep the text
    cleanText = cleanText.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

    // Remove reference-style links [text][ref]
    cleanText = cleanText.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

    // Remove bold (**text** or __text__)
    cleanText = cleanText.replace(/\*\*([^*]+)\*\*/g, '$1');
    cleanText = cleanText.replace(/__([^_]+)__/g, '$1');

    // Remove italic (*text* or _text_)
    cleanText = cleanText.replace(/\*([^*]+)\*/g, '$1');
    cleanText = cleanText.replace(/_([^_]+)_/g, '$1');

    // Remove strikethrough (~~text~~)
    cleanText = cleanText.replace(/~~([^~]+)~~/g, '$1');

    // Remove headers (# ## ### etc)
    cleanText = cleanText.replace(/^#{1,6}\s+/gm, '');

    // Remove horizontal rules (---, ***, ___)
    cleanText = cleanText.replace(/^[\-*_]{3,}\s*$/gm, '');

    // Remove blockquotes (> text)
    cleanText = cleanText.replace(/^>\s+/gm, '');

    // Remove unordered list markers (-, *, +)
    cleanText = cleanText.replace(/^[\-*+]\s+/gm, '');

    // Remove ordered list markers (1. 2. etc)
    cleanText = cleanText.replace(/^\d+\.\s+/gm, '');

    // Remove task list markers (- [ ] or - [x])
    cleanText = cleanText.replace(/^-\s+\[[x\s]\]\s+/gm, '');

    // Remove HTML tags (if any)
    cleanText = cleanText.replace(/<[^>]+>/g, '');

    // Remove footnotes [^1]
    cleanText = cleanText.replace(/\[\^[^\]]+\]/g, '');

    // Clean up excessive whitespace
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n'); // Max 2 newlines
    cleanText = cleanText.replace(/[ \t]{2,}/g, ' '); // Multiple spaces to single space

    // Trim each line
    cleanText = cleanText
        .split('\n')
        .map(line => line.trim())
        .join('\n');

    // Remove leading/trailing whitespace
    cleanText = cleanText.trim();

    return cleanText;
}



