/**
 * Text to HTML Converter (safe for BOTH client and server).
 * Converts plain text with newlines to HTML format for TipTap editor.
 *
 * XSS DEFENSE (client-safe path): user-supplied text is ALWAYS escaped
 * via escapeHtml() before being wrapped in tags, so plain-text and
 * markdown input can never carry live HTML.
 *
 * XSS DEFENSE (server path, imports): smartConvertToHTML additionally
 * sanitizes raw HTML input through DOMPurify (see src/lib/sanitize.ts)
 * because imported .html content may contain tags.
 */

/**
 * Escape special HTML characters to prevent XSS when user-supplied text
 * is injected into the TipTap editor DOM.
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Convert plain text to HTML preserving formatting
 * @param text - Plain text with newlines
 * @returns HTML formatted text compatible with TipTap
 */
export function convertTextToHTML(text: string): string {
    if (!text || text.trim().length === 0) {
        return '<p></p>';
    }

    // Split by double newlines to get paragraphs
    const paragraphs = text.split('\n\n');

    const htmlParagraphs = paragraphs.map(para => {
        if (para.trim().length === 0) {
            // Empty paragraph - just skip, don't add extra lines
            return '';
        }

        // Within each paragraph, replace single newlines with <br>
        const lines = para.split('\n').map(line => escapeHtml(line)).join('<br>');

        return `<p>${lines}</p>`;
    }).filter(p => p.length > 0); // Remove empty strings

    return htmlParagraphs.join('') || '<p></p>';
}

/**
 * Convert text preserving Markdown formatting (for .md files)
 * @param text - Markdown text
 * @returns HTML with basic Markdown parsing
 */
export function convertMarkdownToHTML(text: string): string {
    if (!text || text.trim().length === 0) {
        return '<p></p>';
    }

    // Escape first to prevent XSS in user-supplied markdown content
    let html = escapeHtml(text);

    // Convert headings
    html = html.replace(/^### (.*$)/gm, '\n\n<h3>$1</h3>\n\n');
    html = html.replace(/^## (.*$)/gm, '\n\n<h2>$1</h2>\n\n');
    html = html.replace(/^# (.*$)/gm, '\n\n<h1>$1</h1>\n\n');

    // Convert bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Convert italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Convert code blocks
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');

    // Convert links
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');

    // Convert lists
    html = html.replace(/^\- (.*$)/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');

    // Split by double newlines for paragraphs
    const paragraphs = html.split('\n\n');

    const result = paragraphs.map(para => {
        if (para.trim().length === 0) {
            return '';
        }

        // Check if it's already an HTML element
        if (para.match(/^<(h[1-6]|ul|li)/i)) {
            return para;
        }

        // Replace single newlines with <br>
        const lines = para.split('\n').join('<br>');
        return `<p>${lines}</p>`;
    }).filter(p => p.length > 0);

    return result.join('') || '<p></p>';
}

/**
 * Determine if content is HTML or plain text
 * More strict detection - only returns true for actual HTML with closing tags
 */
export function isHTML(text: string): boolean {
    // Check for actual HTML tags with closing tags (not just any angle brackets)
    // This prevents false positives from code comments like "//BOOT: ENTITY_(DSE)_v3.0"
    return /<(p|h1|h2|h3|h4|h5|h6|div|span|br|ul|ol|li|strong|em|code)[^>]*>[\s\S]*?<\/\1>/.test(text) ||
        /<br\s*\/?>/.test(text); // Also check for self-closing br tags
}

// NOTE: smartConvertToHTML lives in ./text-to-html.server.ts (server-only,
// jsdom-backed DOMPurify chokepoint for imports) so this client-safe
// module carries zero DOMPurify/jsdom bytes into the editor bundle.
