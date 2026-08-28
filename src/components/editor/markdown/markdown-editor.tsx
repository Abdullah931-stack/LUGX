"use client";

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { placeholder as cmPlaceholder } from "@codemirror/view";
import { MarkdownEditorProps, EditorAdapter, DirectionSettings } from "./types";
import {
    createMarkdownExtensions,
    modeCompartment,
    readOnlyCompartment,
    placeholderCompartment,
    directionCompartment,
    directionSettingsState,
    setDirectionSettingsEffect,
    resolveDirectionExtension,
    livePreviewPlugin,
} from "./markdown-extensions";
import { createEditorAdapter, CodeMirrorEditorAdapter } from "./editor-adapter";

export const MarkdownEditor = forwardRef<EditorAdapter, MarkdownEditorProps>(function MarkdownEditor(
    {
        value,
        defaultValue = "",
        onChange,
        onSelectionChange,
        onAdapterReady,
        mode = "live",
        onModeChange,
        placeholder = "Start writing...",
        readOnly = false,
        autoFocus = false,
        className = "",
        dir = "auto",
        lockCodeBlocksLTR = true,
        onDirectionChange,
    },
    ref
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const adapterRef = useRef<EditorAdapter | null>(null);

    // Keep callback refs stable to avoid restarting extensions on re-render
    const onChangeRef = useRef(onChange);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const onAdapterReadyRef = useRef(onAdapterReady);
    const onModeChangeRef = useRef(onModeChange);
    const onDirectionChangeRef = useRef(onDirectionChange);

    useEffect(() => {
        onChangeRef.current = onChange;
        onSelectionChangeRef.current = onSelectionChange;
        onAdapterReadyRef.current = onAdapterReady;
        onModeChangeRef.current = onModeChange;
        onDirectionChangeRef.current = onDirectionChange;
    });

    // Expose EditorAdapter via ref
    useImperativeHandle(ref, () => ({
        getValue: () => adapterRef.current?.getValue() ?? "",
        setValue: (content: string, origin?: string) => adapterRef.current?.setValue(content, origin),
        getSelection: () => adapterRef.current?.getSelection() ?? { from: 0, to: 0 },
        setSelection: (from: number, to?: number) => adapterRef.current?.setSelection(from, to),
        replaceRange: (from: number, to: number, insert: string) => adapterRef.current?.replaceRange(from, to, insert),
        replaceRanges: (changes) => adapterRef.current?.replaceRanges(changes),
        getSelectedText: () => adapterRef.current?.getSelectedText() ?? "",
        insertMarkdown: (prefix, suffix, placeholder) => adapterRef.current?.insertMarkdown(prefix, suffix, placeholder),
        setEditable: (editable) => adapterRef.current?.setEditable(editable),
        focus: () => adapterRef.current?.focus(),
        blur: () => adapterRef.current?.blur(),
        hasFocus: () => adapterRef.current?.hasFocus() ?? false,
        undo: () => adapterRef.current?.undo() ?? false,
        redo: () => adapterRef.current?.redo() ?? false,
        canUndo: () => adapterRef.current?.canUndo() ?? false,
        canRedo: () => adapterRef.current?.canRedo() ?? false,
        getWordCount: () => adapterRef.current?.getWordCount() ?? 0,
        getCharCount: () => adapterRef.current?.getCharCount() ?? 0,
        getLineCount: () => adapterRef.current?.getLineCount() ?? 0,
        getHeadingCount: () => adapterRef.current?.getHeadingCount() ?? 0,
        getMode: () => adapterRef.current?.getMode() ?? "live",
        setMode: (m) => adapterRef.current?.setMode(m),
        getDirectionSettings: () =>
            adapterRef.current?.getDirectionSettings() ?? {
                mode: dir,
                lockCodeBlocksLTR,
            },
        setDirectionSettings: (settings) => adapterRef.current?.setDirectionSettings(settings),
        startStreamingGhost: (opts) => adapterRef.current?.startStreamingGhost?.(opts),
        updateStreamingGhost: (text, isStreaming) => adapterRef.current?.updateStreamingGhost?.(text, isStreaming),
        clearStreamingGhost: () => adapterRef.current?.clearStreamingGhost?.(),
        getGhostRange: () => adapterRef.current?.getGhostRange?.() ?? null,
        destroy: () => adapterRef.current?.destroy(),
    }), [dir, lockCodeBlocksLTR]);

    // Initialize CodeMirror 6 EditorView on mount
    useEffect(() => {
        if (!containerRef.current) return;

        const initialDoc = value !== undefined ? value : defaultValue;

        const extensions = createMarkdownExtensions({
            mode,
            placeholder,
            readOnly,
            dir,
            lockCodeBlocksLTR,
            initialDoc,
            onDirectionChange: (settings: DirectionSettings) => {
                if (onDirectionChangeRef.current) {
                    onDirectionChangeRef.current(settings);
                }
            },
            onUpdate: (update) => {
                if (update.docChanged) {
                    const newDoc = update.state.doc.toString();
                    if (onChangeRef.current) {
                        onChangeRef.current(newDoc);
                    }
                }
                if (update.selectionSet && onSelectionChangeRef.current) {
                    const main = update.state.selection.main;
                    onSelectionChangeRef.current({
                        from: main.from,
                        to: main.to,
                    });
                }
            },
        });

        const state = EditorState.create({
            doc: initialDoc,
            extensions,
        });

        const view = new EditorView({
            state,
            parent: containerRef.current,
        });

        const adapter = createEditorAdapter(view, mode);
        viewRef.current = view;
        adapterRef.current = adapter;

        if (onAdapterReadyRef.current) {
            onAdapterReadyRef.current(adapter);
        }

        if (autoFocus) {
            view.focus();
        }

        return () => {
            view.destroy();
            viewRef.current = null;
            adapterRef.current = null;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Synchronize controlled `value`
    useEffect(() => {
        const view = viewRef.current;
        if (!view || value === undefined) return;

        const currentVal = view.state.doc.toString();
        if (value !== currentVal) {
            const currentSel = view.state.selection.main;
            const safeAnchor = Math.min(currentSel.anchor, value.length);
            const safeHead = Math.min(currentSel.head, value.length);

            view.dispatch({
                changes: { from: 0, to: currentVal.length, insert: value },
                selection: { anchor: safeAnchor, head: safeHead },
                userEvent: "set",
            });
        }
    }, [value]);

    // Synchronize `mode` (Live Preview vs Source)
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;

        view.dispatch({
            effects: modeCompartment.reconfigure(mode === "live" ? [livePreviewPlugin] : []),
        });

        if (adapterRef.current instanceof CodeMirrorEditorAdapter) {
            // Internal state sync
            (adapterRef.current as unknown as { currentMode: EditorMode }).currentMode = mode;
        }

        if (onModeChangeRef.current) {
            onModeChangeRef.current(mode);
        }
    }, [mode]);

    // Synchronize `readOnly`
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;

        view.dispatch({
            effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
        });
    }, [readOnly]);

    // Synchronize `placeholder`
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;

        view.dispatch({
            effects: placeholderCompartment.reconfigure(cmPlaceholder(placeholder)),
        });
    }, [placeholder]);

    // Synchronize direction settings (`dir` & `lockCodeBlocksLTR`)
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;

        const currentSettings = view.state.field(directionSettingsState, false);
        if (
            currentSettings &&
            (currentSettings.mode !== dir || currentSettings.lockCodeBlocksLTR !== lockCodeBlocksLTR)
        ) {
            const nextSettings: DirectionSettings = {
                mode: dir,
                lockCodeBlocksLTR,
            };
            view.dispatch({
                effects: [
                    setDirectionSettingsEffect.of(nextSettings),
                    directionCompartment.reconfigure(resolveDirectionExtension(dir, view.state.doc.toString())),
                ],
            });
        }
    }, [dir, lockCodeBlocksLTR]);

    return (
        <div
            className={`lugx-markdown-editor w-full relative outline-none rounded-md ${className}`}
            dir={dir === "auto" ? undefined : dir}
        >
            <div ref={containerRef} className="w-full min-h-[300px]" />
        </div>
    );
});
