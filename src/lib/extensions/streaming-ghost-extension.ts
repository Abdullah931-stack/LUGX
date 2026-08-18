'use client';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { detectTextDirection } from '@/lib/utils';

export interface StreamingGhostState {
    active: boolean;
    from: number;
    to: number;
    text: string;
    operation?: string;
}

export const streamingGhostPluginKey = new PluginKey<StreamingGhostState>('streamingGhost');

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        streamingGhost: {
            /**
             * Initialize ephemeral streaming ghost decoration at the target range
             */
            startStreamingGhost: (options: { from: number; to: number; text?: string; operation?: string }) => ReturnType;
            /**
             * Update the streaming ghost buffer text in real-time
             */
            updateStreamingGhost: (text: string) => ReturnType;
            /**
             * Clear and dismantle the streaming ghost decoration
             */
            clearStreamingGhost: () => ReturnType;
        };
    }
}

/**
 * TipTap Extension for Ephemeral AI Streaming Ghost Decoration.
 *
 * Renders real-time AI streaming chunks in an ephemeral view layer without
 * modifying the underlying ProseMirror document model. This ensures:
 * 1. Zero document mutation during streaming (auto-save is never triggered).
 * 2. Unaffected surrounding content when performing partial selection replacements.
 * 3. Atomic single-action undo when the stream is committed.
 */
export const StreamingGhostExtension = Extension.create({
    name: 'streamingGhost',

    addCommands() {
        return {
            startStreamingGhost:
                ({ from, to, text = '', operation }) =>
                    ({ tr, dispatch }) => {
                        if (dispatch) {
                            tr.setMeta(streamingGhostPluginKey, {
                                type: 'START',
                                from,
                                to,
                                text,
                                operation,
                            });
                            tr.setMeta('addToHistory', false);
                        }
                        return true;
                    },

            updateStreamingGhost:
                (text: string) =>
                    ({ tr, dispatch }) => {
                        if (dispatch) {
                            tr.setMeta(streamingGhostPluginKey, {
                                type: 'UPDATE',
                                text,
                            });
                            tr.setMeta('addToHistory', false);
                        }
                        return true;
                    },

            clearStreamingGhost:
                () =>
                    ({ tr, dispatch }) => {
                        if (dispatch) {
                            tr.setMeta(streamingGhostPluginKey, {
                                type: 'CLEAR',
                            });
                            tr.setMeta('addToHistory', false);
                        }
                        return true;
                    },
        };
    },

    addProseMirrorPlugins() {
        return [
            new Plugin<StreamingGhostState>({
                key: streamingGhostPluginKey,
                state: {
                    init(): StreamingGhostState {
                        return {
                            active: false,
                            from: 0,
                            to: 0,
                            text: '',
                            operation: undefined,
                        };
                    },
                    apply(tr, prevState): StreamingGhostState {
                        const meta = tr.getMeta(streamingGhostPluginKey);
                        if (!meta) {
                            // If document changed, map the positions forward if still active
                            if (prevState.active && tr.docChanged) {
                                return {
                                    ...prevState,
                                    from: tr.mapping.map(prevState.from),
                                    to: tr.mapping.map(prevState.to),
                                };
                            }
                            return prevState;
                        }

                        switch (meta.type) {
                            case 'START':
                                return {
                                    active: true,
                                    from: meta.from,
                                    to: meta.to,
                                    text: meta.text || '',
                                    operation: meta.operation,
                                };
                            case 'UPDATE':
                                return {
                                    ...prevState,
                                    text: meta.text,
                                };
                            case 'CLEAR':
                                return {
                                    active: false,
                                    from: 0,
                                    to: 0,
                                    text: '',
                                    operation: undefined,
                                };
                            default:
                                return prevState;
                        }
                    },
                },
                props: {
                    decorations(state) {
                        const pluginState = streamingGhostPluginKey.getState(state);
                        if (!pluginState || !pluginState.active) {
                            return DecorationSet.empty;
                        }

                        const docSize = state.doc.content.size;
                        const from = Math.max(0, Math.min(pluginState.from, docSize));
                        const to = Math.max(from, Math.min(pluginState.to, docSize));
                        const isPartialSelection = from !== to;

                        const decorations: Decoration[] = [];

                        // 1. Inline decoration: Dim the original selection if replacing a partial selection
                        if (isPartialSelection) {
                            decorations.push(
                                Decoration.inline(from, to, {
                                    class: 'opacity-35 line-through decoration-zinc-500 select-none bg-zinc-800/30 rounded px-0.5 transition-opacity',
                                    'data-streaming-target': 'true',
                                })
                            );
                        }

                        // 2. Widget decoration: Render the live streaming text preview at 'from'
                        const widget = Decoration.widget(
                            from,
                            () => {
                                const container = document.createElement('span');
                                container.className =
                                    'inline-block my-1 p-2 rounded-lg bg-emerald-950/30 border border-emerald-500/30 text-emerald-200 shadow-sm max-w-full overflow-hidden transition-all';

                                const dir = detectTextDirection(pluginState.text || '');
                                container.setAttribute('dir', dir);

                                // Header tag
                                const header = document.createElement('span');
                                header.className =
                                    'flex items-center gap-1.5 text-[11px] font-mono font-medium tracking-wide uppercase text-emerald-400 mb-1 select-none';
                                header.innerHTML = `
                                    <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block"></span>
                                    <span>AI Streaming (${pluginState.operation || 'Processing'})...</span>
                                `;
                                container.appendChild(header);

                                // Content container
                                const content = document.createElement('span');
                                content.className = 'whitespace-pre-wrap leading-relaxed text-sm font-normal text-zinc-100 block';
                                content.textContent = pluginState.text || '...';
                                container.appendChild(content);

                                // Pulsing cursor indicator
                                const cursor = document.createElement('span');
                                cursor.className =
                                    'inline-block w-1.5 h-4 bg-emerald-400 ml-1 align-middle animate-pulse rounded-xs shadow-[0_0_8px_rgba(52,211,153,0.8)]';
                                content.appendChild(cursor);

                                return container;
                            },
                            {
                                side: -1,
                                key: 'ai-streaming-ghost-widget',
                            }
                        );

                        decorations.push(widget);

                        return DecorationSet.create(state.doc, decorations);
                    },
                },
            }),
        ];
    },
});

export default StreamingGhostExtension;
