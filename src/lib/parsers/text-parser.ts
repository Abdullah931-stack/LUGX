/**
 * Plain Text and Markdown File Parser
 * Reads content from .txt and .md files
 */

export interface TextParseResult {
    text: string;
    wordCount: number;
}

/**
 * Parse plain text or markdown file
 * @param file - File object to parse
 * @returns Parsed text content
 */
export async function parseTextFile(file: File): Promise<TextParseResult> {
    try {
        const text = await file.text();
        const wordCount = text.split(/\s+/).filter(Boolean).length;

        return {
            text,
            wordCount,
        };
    } catch (error) {
        throw new Error(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Parse file content based on type
 * Client-side helper for MD/TXT files
 */
export async function parseFileContent(file: File): Promise<string> {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];

    if (extension === '.md' || extension === '.txt') {
        const result = await parseTextFile(file);
        return result.text;
    }

    throw new Error(`Unsupported file type for client-side parsing: ${extension}`);
}
