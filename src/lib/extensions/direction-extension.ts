'use client';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// Arabic and RTL Unicode ranges detection
const RTL_PATTERN = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/;

/**
 * Detect text direction based on first meaningful character
 * @param text - The text to analyze
 * @returns 'rtl' or 'ltr'
 */
function detectDirection(text: string): 'rtl' | 'ltr' {
    // Find first letter (skip numbers, spaces, punctuation)
    const match = text.match(/[^\s\d\p{P}]/u);
    if (match) {
        return RTL_PATTERN.test(match[0]) ? 'rtl' : 'ltr';
    }
    return 'ltr'; // Default to LTR if no letters found
}

/**
 * TipTap Extension for automatic per-paragraph text direction
 * Detects RTL/LTR content and applies dir attribute to each block element
 */
export const AutoDirectionExtension = Extension.create({
    name: 'autoDirection',

    addGlobalAttributes() {
        return [
            {
                types: ['paragraph', 'heading', 'blockquote', 'listItem'],
                attributes: {
                    dir: {
                        default: null,
                        parseHTML: (element) => element.getAttribute('dir'),
                        renderHTML: (attributes) => {
                            if (!attributes.dir) {
                                return {};
                            }
                            return { dir: attributes.dir };
                        },
                    },
                },
            },
        ];
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('autoDirection'),
                appendTransaction: (transactions, oldState, newState) => {
                    // Only process if document changed
                    const docChanged = transactions.some((tr) => tr.docChanged);
                    if (!docChanged) return null;

                    const { tr } = newState;
                    let modified = false;

                    // Iterate through all nodes in the document
                    newState.doc.descendants((node, pos) => {
                        // Check for block nodes that support direction
                        if (
                            node.type.name === 'paragraph' ||
                            node.type.name === 'heading' ||
                            node.type.name === 'blockquote' ||
                            node.type.name === 'listItem'
                        ) {
                            const text = node.textContent;
                            if (text.trim()) {
                                const detectedDir = detectDirection(text);
                                const currentDir = node.attrs.dir;

                                // Only update if direction changed or not set
                                if (currentDir !== detectedDir) {
                                    tr.setNodeMarkup(pos, undefined, {
                                        ...node.attrs,
                                        dir: detectedDir,
                                    });
                                    modified = true;
                                }
                            } else if (node.attrs.dir) {
                                // Clear direction for empty nodes
                                tr.setNodeMarkup(pos, undefined, {
                                    ...node.attrs,
                                    dir: null,
                                });
                                modified = true;
                            }
                        }
                    });

                    return modified ? tr : null;
                },
            }),
        ];
    },
});

export default AutoDirectionExtension;
