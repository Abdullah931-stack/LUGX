// @vitest-environment jsdom
import React, { createRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { MarkdownEditor } from "./markdown-editor";
import { EditorAdapter } from "./types";

describe("MarkdownEditor React Component", () => {
    it("renders properly with default props", () => {
        const { container } = render(
            <MarkdownEditor defaultValue="# Initial Title\n\nSome body text." />
        );
        expect(container.querySelector(".lugx-markdown-editor")).toBeDefined();
        expect(container.querySelector(".cm-editor")).toBeDefined();
    });

    it("notifies onAdapterReady callback with valid EditorAdapter", () => {
        let adapterInstance: EditorAdapter | null = null;
        render(
            <MarkdownEditor
                defaultValue="# LUGX Markdown"
                onAdapterReady={(adapter) => {
                    adapterInstance = adapter;
                }}
            />
        );

        expect(adapterInstance).not.toBeNull();
        expect(adapterInstance!.getValue()).toBe("# LUGX Markdown");
    });

    it("exposes EditorAdapter via forwardRef", () => {
        const ref = createRef<EditorAdapter>();
        render(<MarkdownEditor ref={ref} defaultValue="Hello forwardRef" />);

        expect(ref.current).not.toBeNull();
        expect(ref.current!.getValue()).toBe("Hello forwardRef");
    });

    it("triggers onChange when content is updated via adapter", () => {
        const onChangeMock = vi.fn();
        let adapterInstance: EditorAdapter | null = null;

        render(
            <MarkdownEditor
                defaultValue="Start"
                onChange={onChangeMock}
                onAdapterReady={(adapter) => {
                    adapterInstance = adapter;
                }}
            />
        );

        act(() => {
            adapterInstance!.setValue("Updated text from test");
        });

        expect(onChangeMock).toHaveBeenCalledWith("Updated text from test");
        expect(adapterInstance!.getValue()).toBe("Updated text from test");
    });

    it("updates content and preserves cursor when controlled value prop changes", () => {
        let adapterInstance: EditorAdapter | null = null;
        const { rerender } = render(
            <MarkdownEditor
                value="Controlled initial text"
                onAdapterReady={(adapter) => {
                    adapterInstance = adapter;
                }}
            />
        );

        expect(adapterInstance!.getValue()).toBe("Controlled initial text");

        // Place cursor at position 10
        act(() => {
            adapterInstance!.setSelection(10, 10);
        });
        expect(adapterInstance!.getSelection().from).toBe(10);

        // Update controlled value
        rerender(
            <MarkdownEditor
                value="Controlled modified longer text"
                onAdapterReady={(adapter) => {
                    adapterInstance = adapter;
                }}
            />
        );

        expect(adapterInstance!.getValue()).toBe("Controlled modified longer text");
        // Cursor must be preserved at 10 (not reset to 0 or length)
        expect(adapterInstance!.getSelection().from).toBe(10);
    });

    it("supports switching mode prop dynamically", () => {
        let adapterInstance: EditorAdapter | null = null;
        const onModeChange = vi.fn();

        const { rerender } = render(
            <MarkdownEditor
                defaultValue="Testing Mode"
                mode="live"
                onModeChange={onModeChange}
                onAdapterReady={(adapter) => {
                    adapterInstance = adapter;
                }}
            />
        );

        expect(adapterInstance!.getMode()).toBe("live");

        rerender(
            <MarkdownEditor
                defaultValue="Testing Mode"
                mode="source"
                onModeChange={onModeChange}
                onAdapterReady={(adapter) => {
                    adapterInstance = adapter;
                }}
            />
        );

        expect(adapterInstance!.getMode()).toBe("source");
        expect(onModeChange).toHaveBeenCalledWith("source");
    });
});
