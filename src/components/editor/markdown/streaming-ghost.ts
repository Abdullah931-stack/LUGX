import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import {
    EditorView as CMEditorView,
    Decoration as CMDecoration,
    WidgetType as CMWidgetType,
} from '@codemirror/view';

export interface CMStreamingGhostOptions {
    from: number;
    to: number;
    text?: string;
    operation?: string;
    isStreaming?: boolean;
    onApply?: () => void;
    onReject?: () => void;
    onRetry?: () => void;
    onStop?: () => void;
}

export interface StreamingGhostState {
    active: boolean;
    from: number;
    to: number;
    text: string;
    operation?: string;
    isStreaming: boolean;
    onApply?: () => void;
    onReject?: () => void;
    onRetry?: () => void;
    onStop?: () => void;
}

const RTL_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function detectTextDirection(text: string): 'rtl' | 'ltr' {
    return RTL_REGEX.test(text) ? 'rtl' : 'ltr';
}

export const startGhostEffect = StateEffect.define<CMStreamingGhostOptions>();

export const updateGhostEffect = StateEffect.define<{
    text: string;
    isStreaming?: boolean;
}>();

export const clearGhostEffect = StateEffect.define<void>();

export class CMStreamingGhostWidget extends CMWidgetType {
    constructor(
        readonly text: string,
        readonly operation?: string,
        readonly isStreaming: boolean = true,
        readonly onApply?: () => void,
        readonly onReject?: () => void,
        readonly onRetry?: () => void,
        readonly onStop?: () => void
    ) {
        super();
    }

    eq(other: CMStreamingGhostWidget): boolean {
        return (
            this.text === other.text &&
            this.operation === other.operation &&
            this.isStreaming === other.isStreaming
        );
    }

    private renderActions(actionsContainer: HTMLElement): void {
        actionsContainer.innerHTML = '';

        if (this.isStreaming) {
            if (this.onStop) {
                const stopBtn = document.createElement('button');
                stopBtn.type = 'button';
                stopBtn.className =
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-300 text-xs font-medium transition-colors cursor-pointer select-none';
                stopBtn.innerHTML = `
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke-width="2"></circle>
                        <rect x="9" y="9" width="6" height="6" fill="currentColor"></rect>
                    </svg>
                    <span>إيقاف التوليد</span>
                `;
                stopBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.onStop?.();
                });
                actionsContainer.appendChild(stopBtn);
            }
        } else {
            // Preview ready - 3 Decision Buttons: Reject, Retry, Apply
            if (this.onReject) {
                const rejectBtn = document.createElement('button');
                rejectBtn.type = 'button';
                rejectBtn.className =
                    'flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-300 text-xs font-medium transition-colors cursor-pointer select-none';
                rejectBtn.innerHTML = `
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke-width="2"></circle>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 9l-6 6m0-6l6 6"></path>
                    </svg>
                    <span>رفض</span>
                `;
                rejectBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.onReject?.();
                });
                actionsContainer.appendChild(rejectBtn);
            }

            if (this.onRetry) {
                const retryBtn = document.createElement('button');
                retryBtn.type = 'button';
                retryBtn.className =
                    'flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs font-medium transition-colors cursor-pointer select-none';
                retryBtn.innerHTML = `
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                    </svg>
                    <span>إعادة المحاولة</span>
                `;
                retryBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.onRetry?.();
                });
                actionsContainer.appendChild(retryBtn);
            }

            if (this.onApply) {
                const applyBtn = document.createElement('button');
                applyBtn.type = 'button';
                applyBtn.className =
                    'flex items-center gap-1 px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer select-none';
                applyBtn.innerHTML = `
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>
                    </svg>
                    <span>تطبيق التعديل</span>
                `;
                applyBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.onApply?.();
                });
                actionsContainer.appendChild(applyBtn);
            }
        }
    }

    toDOM(): HTMLElement {
        const container = document.createElement('div');
        container.className =
            'cm-ai-ghost-widget block my-2.5 p-3.5 rounded-xl bg-zinc-900/95 border border-emerald-500/40 text-zinc-100 shadow-xl max-w-full overflow-hidden transition-all backdrop-blur-md';

        // Header with Operation & Actions
        const header = document.createElement('div');
        header.className =
            'flex items-center justify-between border-b border-zinc-800/90 pb-2.5 mb-2.5 select-none';

        const titleBadge = document.createElement('div');
        titleBadge.className =
            'flex items-center gap-2 text-emerald-400 text-xs font-mono font-medium uppercase tracking-wider';
        titleBadge.innerHTML = `
            <svg class="w-4 h-4 animate-pulse text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path>
            </svg>
            <span>معاينة الذكاء الاصطناعي (${this.operation || 'معالجة ذكية'})</span>
        `;
        if (this.isStreaming) {
            const pingDot = document.createElement('span');
            pingDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block';
            titleBadge.appendChild(pingDot);
        }
        header.appendChild(titleBadge);

        const actions = document.createElement('div');
        actions.className = 'cm-ai-ghost-actions flex items-center gap-2';
        this.renderActions(actions);
        header.appendChild(actions);

        container.appendChild(header);

        // Content container
        const dir = detectTextDirection(this.text || '');
        const contentBox = document.createElement('div');
        contentBox.setAttribute('dir', dir);
        contentBox.className =
            'cm-ai-ghost-content text-sm leading-relaxed whitespace-pre-wrap text-zinc-200 max-h-64 overflow-y-auto custom-scrollbar font-normal p-2.5 rounded-lg bg-zinc-950/60 border border-zinc-800/60';

        const textSpan = document.createElement('span');
        textSpan.className = 'cm-ai-ghost-text';
        textSpan.textContent = this.text || (this.isStreaming ? 'جاري استقبال البيانات...' : '...');
        contentBox.appendChild(textSpan);

        if (this.isStreaming) {
            const cursor = document.createElement('span');
            cursor.className =
                'cm-ai-ghost-cursor inline-block w-1.5 h-4 bg-emerald-400 ml-1 align-middle animate-pulse rounded-xs shadow-[0_0_8px_rgba(52,211,153,0.8)]';
            contentBox.appendChild(cursor);
        }

        container.appendChild(contentBox);

        return container;
    }

    updateDOM(dom: HTMLElement): boolean {
        const textNode = dom.querySelector('.cm-ai-ghost-text');
        const contentBox = dom.querySelector('.cm-ai-ghost-content');
        const actionsBox = dom.querySelector('.cm-ai-ghost-actions') as HTMLElement;

        if (textNode && contentBox && actionsBox) {
            textNode.textContent = this.text || (this.isStreaming ? 'جاري استقبال البيانات...' : '...');
            const dir = detectTextDirection(this.text || '');
            contentBox.setAttribute('dir', dir);

            const cursorNode = dom.querySelector('.cm-ai-ghost-cursor');
            if (this.isStreaming && !cursorNode) {
                const cursor = document.createElement('span');
                cursor.className =
                    'cm-ai-ghost-cursor inline-block w-1.5 h-4 bg-emerald-400 ml-1 align-middle animate-pulse rounded-xs shadow-[0_0_8px_rgba(52,211,153,0.8)]';
                contentBox.appendChild(cursor);
            } else if (!this.isStreaming && cursorNode) {
                cursorNode.remove();
            }

            // Update action buttons state
            this.renderActions(actionsBox);

            return true;
        }
        return false;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

/**
 * CodeMirror 6 StateField for tracking and dynamically shifting AI ghost preview range.
 * Uses tr.changes.mapPos to automatically track edits elsewhere in the document.
 */
export const codeMirrorStreamingGhostField = StateField.define<StreamingGhostState>({
    create(): StreamingGhostState {
        return {
            active: false,
            from: 0,
            to: 0,
            text: '',
            operation: undefined,
            isStreaming: false,
        };
    },
    update(value, tr): StreamingGhostState {
        let current = value;

        for (const effect of tr.effects) {
            if (effect.is(startGhostEffect)) {
                const safeFrom = Math.max(0, Math.min(effect.value.from, tr.newDoc.length));
                const safeTo = Math.max(safeFrom, Math.min(effect.value.to, tr.newDoc.length));
                current = {
                    active: true,
                    from: safeFrom,
                    to: safeTo,
                    text: effect.value.text || '',
                    operation: effect.value.operation,
                    isStreaming: effect.value.isStreaming ?? true,
                    onApply: effect.value.onApply,
                    onReject: effect.value.onReject,
                    onRetry: effect.value.onRetry,
                    onStop: effect.value.onStop,
                };
            } else if (effect.is(updateGhostEffect)) {
                if (current.active) {
                    current = {
                        ...current,
                        text: effect.value.text,
                        isStreaming: effect.value.isStreaming ?? current.isStreaming,
                    };
                }
            } else if (effect.is(clearGhostEffect)) {
                current = {
                    active: false,
                    from: 0,
                    to: 0,
                    text: '',
                    operation: undefined,
                    isStreaming: false,
                    onApply: undefined,
                    onReject: undefined,
                    onRetry: undefined,
                    onStop: undefined,
                };
            }
        }

        // Dynamic Position Shifting & Collision Detection
        if (value.active && current.active && tr.docChanged) {
            let collision = false;
            tr.changes.iterChanges((fromA, toA) => {
                if (collision) return;
                // If it was a point/cursor selection
                if (value.from === value.to) {
                    if (fromA <= value.from && toA >= value.from) {
                        collision = true;
                    }
                } else {
                    // Range selection: overlaps if change intersects (value.from, value.to)
                    if (fromA < value.to && toA > value.from) {
                        collision = true;
                    }
                }
            });

            if (collision) {
                // User directly edited the text being processed by AI -> abort and dismiss
                if (typeof current.onStop === 'function') {
                    const onStop = current.onStop;
                    queueMicrotask(() => {
                        try {
                            onStop();
                        } catch (e) {
                            console.error('[StreamingGhost] Error in onStop callback:', e);
                        }
                    });
                }
                current = {
                    active: false,
                    from: 0,
                    to: 0,
                    text: '',
                    operation: undefined,
                    isStreaming: false,
                    onApply: undefined,
                    onReject: undefined,
                    onRetry: undefined,
                    onStop: undefined,
                };
            } else {
                // Non-overlapping edit: map positions forward/backward cleanly
                const mappedFrom = Math.max(0, Math.min(tr.changes.mapPos(current.from, 1), tr.newDoc.length));
                const mappedTo = Math.max(mappedFrom, Math.min(tr.changes.mapPos(current.to, -1), tr.newDoc.length));
                current = {
                    ...current,
                    from: mappedFrom,
                    to: mappedTo,
                };
            }
        }

        return current;
    },
    provide(field) {
        return CMEditorView.decorations.compute([field], (state) => {
            const ghost = state.field(field, false);
            if (!ghost || !ghost.active) return CMDecoration.none;
            const builder = new RangeSetBuilder<CMDecoration>();
            const docLen = state.doc.length;
            const from = Math.max(0, Math.min(ghost.from, docLen));
            const to = Math.max(from, Math.min(ghost.to, docLen));

            // 1. Widget decoration displaying live streamed preview and action buttons
            builder.add(
                from,
                from,
                CMDecoration.widget({
                    widget: new CMStreamingGhostWidget(
                        ghost.text,
                        ghost.operation,
                        ghost.isStreaming,
                        ghost.onApply,
                        ghost.onReject,
                        ghost.onRetry,
                        ghost.onStop
                    ),
                    side: from > 0 ? -1 : 0,
                })
            );

            // 2. Inline mark decoration to dim targeted selection
            if (from !== to) {
                builder.add(
                    from,
                    to,
                    CMDecoration.mark({
                        class: 'opacity-35 line-through decoration-zinc-500 bg-zinc-800/30 rounded px-0.5 transition-opacity',
                    })
                );
            }

            return builder.finish();
        });
    },
});
