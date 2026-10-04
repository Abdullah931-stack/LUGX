// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SearchReplace } from "../../components/editor/search-replace";
import { EditorAdapter } from "../../components/editor/markdown/types";

describe("SearchReplace Component - LUGX-054 Stale Range Protection", () => {
    it("aborts replacement and recomputes if document slice mismatches expected range (stale cache)", async () => {
        let docContent = "Hello World World";
        const replaceRangeMock = vi.fn((from, to, text) => {
            docContent = docContent.slice(0, from) + text + docContent.slice(to);
        });
        const replaceRangesMock = vi.fn();
        
        const mockAdapter = {
            getValue: () => docContent,
            setSelection: vi.fn(),
            focus: vi.fn(),
            replaceRange: replaceRangeMock,
            replaceRanges: replaceRangesMock,
        } as unknown as EditorAdapter;

        render(<SearchReplace adapter={mockAdapter} isOpen={true} onClose={vi.fn()} />);

        const searchInput = screen.getByPlaceholderText(/بحث في المستند/i);
        fireEvent.change(searchInput, { target: { value: "World" } });
        
        await waitFor(() => {
            expect(screen.getByText("1 / 2")).toBeDefined();
        });

        // Mutate doc content directly (simulating concurrent edit or stale timer)
        docContent = "Hello Coder Coder";
        
        const replaceInput = screen.getByPlaceholderText(/استبدال بـ/i);
        fireEvent.change(replaceInput, { target: { value: "Universe" } });
        
        // Click replace current
        const replaceBtn = screen.getByTitle(/استبدال الحالي/i);
        fireEvent.click(replaceBtn);
        
        // Replace should be aborted because "Coder" != "World"
        expect(replaceRangeMock).not.toHaveBeenCalled();
        
        await waitFor(() => {
            expect(screen.queryByText("1 / 2")).toBeNull();
        });
    });

    it("aborts replaceAll if document slices mismatch (stale cache)", async () => {
        let docContent = "Hello World World";
        const replaceRangesMock = vi.fn();
        
        const mockAdapter = {
            getValue: () => docContent,
            setSelection: vi.fn(),
            focus: vi.fn(),
            replaceRange: vi.fn(),
            replaceRanges: replaceRangesMock,
        } as unknown as EditorAdapter;

        render(<SearchReplace adapter={mockAdapter} isOpen={true} onClose={vi.fn()} />);

        const searchInput = screen.getByPlaceholderText(/بحث في المستند/i);
        fireEvent.change(searchInput, { target: { value: "World" } });
        
        await waitFor(() => {
            expect(screen.getByText("1 / 2")).toBeDefined();
        });

        docContent = "Hello Coder Coder";
        
        const replaceInput = screen.getByPlaceholderText(/استبدال بـ/i);
        fireEvent.change(replaceInput, { target: { value: "Universe" } });
        
        const replaceAllBtn = screen.getByTitle(/استبدال الكل/i);
        fireEvent.click(replaceAllBtn);
        
        expect(replaceRangesMock).not.toHaveBeenCalled();
    });
});
