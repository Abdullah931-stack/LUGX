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

    // Remove code blocks (```...```) - must be done first
    cleanText = cleanText.replace(/```[\s\S]*?```/g, '');

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

/**
 * Convert HTML to plain text (for TipTap editor content)
 * @param html - HTML content from TipTap editor
 * @returns Plain text without HTML tags
 */
export function htmlToPlainText(html: string): string {
    if (!html || html.trim().length === 0) {
        return '';
    }

    let text = html;

    // Convert <p> tags to newlines
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<p[^>]*>/gi, '');

    // Convert <br> to newlines
    text = text.replace(/<br\s*\/?>/gi, '\n');

    // Convert headings to text with newlines
    text = text.replace(/<\/h[1-6]>/gi, '\n');
    text = text.replace(/<h[1-6][^>]*>/gi, '');

    // Convert list items
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<li[^>]*>/gi, '');

    // Remove all other HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");

    // Clean up whitespace
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]{2,}/g, ' ');

    // Trim
    text = text.trim();

    return text;
}
