/**
 * Spatial Table Extractor for PDF Documents
 *
 * Converts 2D positioned text items into clean GitHub-Flavored Markdown tables
 * by analyzing vertical (Y) line alignment and horizontal (X) column clusters.
 */

import { normalizeArabicText } from './arabic-normalizer';

export interface SpatialTextItem {
    str: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    hasEOL?: boolean;
}

interface GroupedLine {
    y: number;
    items: SpatialTextItem[];
}

/**
 * Extracts and formats 2D spatial text items into clean Markdown with detected tables.
 */
export function extractSpatialPdfTableContent(
    items: SpatialTextItem[],
    options?: { yTolerance?: number; minTableRows?: number; disableTables?: boolean }
): string {
    const { yTolerance = 3.5, minTableRows = 2, disableTables = false } = options || {};

    if (!items || items.length === 0) return '';

    // Step 1: Filter empty items and sort primarily by Y (descending: top of page to bottom)
    const validItems = items.filter((i) => i.str && i.str.trim().length > 0);
    if (validItems.length === 0) return '';

    // Sort by Y descending (PDF coordinates: 0,0 is at bottom-left)
    validItems.sort((a, b) => b.y - a.y);

    // Step 2: Group items into horizontal lines based on Y-tolerance
    const lines: GroupedLine[] = [];

    for (const item of validItems) {
        const matchedLine = lines.find((l) => Math.abs(l.y - item.y) <= yTolerance);
        if (matchedLine) {
            matchedLine.items.push(item);
        } else {
            lines.push({ y: item.y, items: [item] });
        }
    }

    // Step 3: Sort items within each line by X ascending (Left-to-Right)
    for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
    }

    // If table extraction is disabled, format lines linearly without markdown table pipe syntax
    if (disableTables) {
        const linearLines: string[] = [];
        for (const line of lines) {
            const lineText = formatLineText(line.items);
            if (lineText.trim()) {
                linearLines.push(lineText.trim());
            }
        }
        return linearLines.join('\n\n');
    }

    // Step 4: Detect tabular lines vs section headers vs standard text
    const processedBlocks: string[] = [];
    let currentTableRows: string[][] = [];

    const flushTable = () => {
        if (currentTableRows.length === 0) return;

        if (currentTableRows.length >= minTableRows) {
            // Determine maximum column count across all rows in this table
            const maxCols = Math.max(...currentTableRows.map((r) => r.length));

            if (maxCols >= 2) {
                // Format as a valid Markdown table
                const headerRow = currentTableRows[0];
                while (headerRow.length < maxCols) headerRow.push('');

                const delimiterRow = Array(maxCols).fill(':---');

                const tableMdLines = [
                    `| ${headerRow.join(' | ')} |`,
                    `| ${delimiterRow.join(' | ')} |`,
                ];

                for (let i = 1; i < currentTableRows.length; i++) {
                    const row = currentTableRows[i];
                    while (row.length < maxCols) row.push('');
                    tableMdLines.push(`| ${row.join(' | ')} |`);
                }

                processedBlocks.push(tableMdLines.join('\n'));
                currentTableRows = [];
                return;
            }
        }

        // Fallback: If table has < minTableRows or only 1 column, output as linear text
        for (const row of currentTableRows) {
            processedBlocks.push(row.join(' '));
        }
        currentTableRows = [];
    };

    for (const line of lines) {
        // Group close items on the same line into column cells based on horizontal gaps
        const cells: string[] = [];
        let currentCellItems: SpatialTextItem[] = [];

        for (let i = 0; i < line.items.length; i++) {
            const item = line.items[i];
            const prevItem = line.items[i - 1];

            if (prevItem) {
                const prevRight = prevItem.x + (prevItem.width || 20);
                const gap = item.x - prevRight;

                // If horizontal gap between items exceeds 25pt, consider it a new column boundary
                if (gap > 25) {
                    if (currentCellItems.length > 0) {
                        cells.push(formatCellText(currentCellItems));
                        currentCellItems = [];
                    }
                }
            }
            currentCellItems.push(item);
        }

        if (currentCellItems.length > 0) {
            cells.push(formatCellText(currentCellItems));
        }

        // Clean cells: strip empty tokens
        const cleanedCells = cells.map((c) => c.trim()).filter(Boolean);

        if (cleanedCells.length >= 2) {
            // Multi-column line: accumulate into current table
            currentTableRows.push(cleanedCells);
        } else if (cleanedCells.length === 1) {
            // Single-cell line
            const singleText = cleanedCells[0];

            // If it looks like a section title / table header (short and distinct), format as header
            const isPotentialHeader = singleText.length < 80 && !singleText.endsWith('.');

            flushTable();

            if (isPotentialHeader && (singleText.includes('Particulars') || singleText.includes('Details') || singleText.includes('Address') || singleText.includes('بيانات') || singleText.includes('العنوان'))) {
                processedBlocks.push(`### ${singleText}`);
            } else {
                processedBlocks.push(singleText);
            }
        }
    }

    flushTable();

    return processedBlocks.join('\n\n');
}

/**
 * Formats and normalizes text within a horizontal line with RTL/LTR awareness.
 */
function formatLineText(items: SpatialTextItem[]): string {
    const orderedItems = [...items];
    if (items.length > 1) {
        const arabicItemCount = items.filter((i) => /[\u0600-\u06FF\uFB50-\uFEFF\uE000-\uF8FF]/.test(i.str)).length;
        if (arabicItemCount >= items.length * 0.4) {
            orderedItems.sort((a, b) => b.x - a.x);
        } else {
            orderedItems.sort((a, b) => a.x - b.x);
        }
    }

    const rawJoined = orderedItems.map((i) => i.str).join(' ');
    return normalizeArabicText(rawJoined);
}

/**
 * Formats and normalizes text within a single table cell, stripping newlines and escaping pipes.
 */
function formatCellText(items: SpatialTextItem[]): string {
    return formatLineText(items)
        .replace(/[\r\n]+/g, ' ')
        .replace(/\|/g, '\\|');
}

