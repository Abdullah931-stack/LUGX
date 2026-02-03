/**
 * Text to HTML Converter
 * Converts plain text with newlines to HTML format for TipTap editor
 */

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
        const lines = para.split('\n').map(line => line).join('<br>');

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

    let html = text;

    // Convert headings
    html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

    // Convert bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Convert italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Convert code blocks
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');

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

/**
 * Smart convert: detect format and convert appropriately
 */
export function smartConvertToHTML(text: string, fileType: 'md' | 'txt' | 'pdf'): string {
    // Debug logging
    console.log('[smartConvertToHTML] Input fileType:', fileType);
    console.log('[smartConvertToHTML] isHTML check:', isHTML(text));
    console.log('[smartConvertToHTML] First 100 chars:', text.substring(0, 100));

    // If already HTML, return as-is
    if (isHTML(text)) {
        console.log('[smartConvertToHTML] Detected as HTML, returning as-is');
        return text;
    }

    // Convert based on file type
    if (fileType === 'md') {
        console.log('[smartConvertToHTML] Converting as Markdown');
        return convertMarkdownToHTML(text);
    } else {
        console.log('[smartConvertToHTML] Converting as plain text');
        return convertTextToHTML(text);
    }
}
