"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, ChevronUp, ChevronDown, Replace } from "lucide-react";
import { cn } from "@/lib/utils";
import { EditorAdapter } from "@/components/editor/markdown/types";

interface SearchReplaceProps {
    /** Target EditorAdapter instance */
    adapter?: EditorAdapter | null;
    /** Backward compatibility alias for adapter */
    editor?: EditorAdapter | null;
    isOpen: boolean;
    onClose: () => void;
}

export function SearchReplace({ adapter, editor, isOpen, onClose }: SearchReplaceProps) {
    const currentAdapter = adapter || editor;

    const [searchQuery, setSearchQuery] = useState("");
    const [replaceQuery, setReplaceQuery] = useState("");
    const [matches, setMatches] = useState<{ index: number; from: number; to: number }[]>([]);
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [shouldSearch, setShouldSearch] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Highlight specific match using exact document offsets
    const highlightMatch = useCallback(
        (match: { from: number; to: number }) => {
            if (!currentAdapter) return;

            try {
                currentAdapter.setSelection(match.from, match.to);
                currentAdapter.focus();
            } catch (error) {
                console.error("[SearchReplace] Highlight error:", error);
            }
        },
        [currentAdapter]
    );

    // Find all matches in the editor Markdown content using exact UTF-16 offsets
    const findMatches = useCallback(() => {
        if (!currentAdapter || !searchQuery) {
            setMatches([]);
            setCurrentMatchIndex(0);
            return;
        }

        try {
            const content = currentAdapter.getValue();
            const searchText = caseSensitive ? searchQuery : searchQuery.toLowerCase();
            const contentToSearch = caseSensitive ? content : content.toLowerCase();

            const foundMatches: { index: number; from: number; to: number }[] = [];
            let position = 0;
            let matchIndex = 0;

            // Find all occurrences
            while (position < contentToSearch.length) {
                const index = contentToSearch.indexOf(searchText, position);
                if (index === -1) break;

                foundMatches.push({
                    index: matchIndex++,
                    from: index,
                    to: index + searchQuery.length,
                });

                position = index + Math.max(1, searchQuery.length);
            }

            setMatches(foundMatches);
            setCurrentMatchIndex(0);

            // Highlight first match
            if (foundMatches.length > 0) {
                highlightMatch(foundMatches[0]);
            }
        } catch (error) {
            console.error("[SearchReplace] Search error:", error);
            setMatches([]);
        }
    }, [currentAdapter, searchQuery, caseSensitive, highlightMatch]);

    // Navigate to next match
    const goToNextMatch = useCallback(() => {
        if (matches.length === 0) return;

        const nextIndex = (currentMatchIndex + 1) % matches.length;
        setCurrentMatchIndex(nextIndex);
        highlightMatch(matches[nextIndex]);
    }, [matches, currentMatchIndex, highlightMatch]);

    // Navigate to previous match
    const goToPreviousMatch = useCallback(() => {
        if (matches.length === 0) return;

        const prevIndex = (currentMatchIndex - 1 + matches.length) % matches.length;
        setCurrentMatchIndex(prevIndex);
        highlightMatch(matches[prevIndex]);
    }, [matches, currentMatchIndex, highlightMatch]);

    // Replace current match
    const replaceCurrentMatch = useCallback(() => {
        if (!currentAdapter || matches.length === 0 || !replaceQuery) return;

        try {
            const currentMatch = matches[currentMatchIndex];
            const { from, to } = currentMatch;

            // Replace single range synchronously
            currentAdapter.replaceRange(from, to, replaceQuery);
            currentAdapter.focus();

            // Refresh matches synchronously without setTimeout race condition
            findMatches();
        } catch (error) {
            console.error("[SearchReplace] Replace error:", error);
        }
    }, [currentAdapter, matches, currentMatchIndex, replaceQuery, findMatches]);

    // Safe Multi-Range Transaction: Replace all matches in one atomic undoable step
    const replaceAllMatches = useCallback(() => {
        if (!currentAdapter || matches.length === 0 || !replaceQuery) return;

        try {
            const changes = matches.map((m) => ({
                from: m.from,
                to: m.to,
                insert: replaceQuery,
            }));

            // Multi-Range Transaction in CodeMirror
            currentAdapter.replaceRanges(changes);
            currentAdapter.focus();

            // Clear matches state
            setMatches([]);
            setCurrentMatchIndex(0);
            setSearchQuery("");
            setReplaceQuery("");
        } catch (error) {
            console.error("[SearchReplace] Replace all error:", error);
        }
    }, [currentAdapter, matches, replaceQuery]);

    // Debounced search effect
    useEffect(() => {
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
            searchTimeoutRef.current = null;
        }

        if (!searchQuery) {
            searchTimeoutRef.current = setTimeout(() => {
                setMatches([]);
                setCurrentMatchIndex(0);
                setShouldSearch(false);
            }, 0);
            return;
        }

        if (shouldSearch) {
            searchTimeoutRef.current = setTimeout(() => {
                findMatches();
                setShouldSearch(false);
            }, 0);
            return;
        }

        searchTimeoutRef.current = setTimeout(() => {
            findMatches();
        }, 300);

        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
                searchTimeoutRef.current = null;
            }
        };
    }, [searchQuery, shouldSearch, findMatches]);

    // Handle search input key press
    const handleSearchKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
            e.preventDefault();
            if (matches.length > 0) {
                goToNextMatch();
            } else {
                setShouldSearch(true);
            }
        }
    };

    // Keyboard shortcuts (Ctrl+F, Enter, Shift+Enter, Ctrl+Enter, Esc)
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                goToPreviousMatch();
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                replaceCurrentMatch();
            } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, goToNextMatch, goToPreviousMatch, replaceCurrentMatch, onClose]);

    if (!isOpen) return null;

    return (
        <div className="border-b border-zinc-800/50 bg-zinc-900/60 backdrop-blur-sm">
            <div className="flex items-center gap-2 p-3 max-w-4xl mx-auto">
                {/* Search Input */}
                <div className="flex-1 flex items-center gap-2">
                    <Input
                        ref={searchInputRef}
                        type="text"
                        placeholder="بحث في المستند (Enter للتنقل)..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyPress}
                        className="h-8 text-sm bg-zinc-900/50 border-zinc-700 focus:border-indigo-500"
                        autoFocus
                    />

                    {/* Match Counter */}
                    {matches.length > 0 && (
                        <span className="text-xs text-zinc-400 whitespace-nowrap">
                            {currentMatchIndex + 1} / {matches.length}
                        </span>
                    )}

                    {/* Navigation Buttons */}
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={goToPreviousMatch}
                            disabled={matches.length === 0}
                            title="المطابقة السابقة (Shift+Enter)"
                        >
                            <ChevronUp className="w-4 h-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={goToNextMatch}
                            disabled={matches.length === 0}
                            title="المطابقة التالية (Enter)"
                        >
                            <ChevronDown className="w-4 h-4" />
                        </Button>
                    </div>
                </div>

                {/* Replace Input */}
                <div className="flex-1 flex items-center gap-2">
                    <Input
                        type="text"
                        placeholder="استبدال بـ..."
                        value={replaceQuery}
                        onChange={(e) => setReplaceQuery(e.target.value)}
                        className="h-8 text-sm bg-zinc-900/50 border-zinc-700 focus:border-indigo-500"
                    />

                    {/* Replace Buttons */}
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={replaceCurrentMatch}
                            disabled={matches.length === 0 || !replaceQuery}
                            className="h-8 text-xs"
                            title="استبدال الحالي (Ctrl+Enter)"
                        >
                            <Replace className="w-3 h-3 mr-1" />
                            استبدال
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={replaceAllMatches}
                            disabled={matches.length === 0 || !replaceQuery}
                            className="h-8 text-xs"
                            title="استبدال الكل (Multi-Range Transaction)"
                        >
                            الكل
                        </Button>
                    </div>
                </div>

                {/* Case Sensitive Toggle */}
                <Button
                    variant={caseSensitive ? "outline" : "ghost"}
                    size="sm"
                    onClick={() => setCaseSensitive(!caseSensitive)}
                    className={cn(
                        "h-8 w-8 font-mono text-xs",
                        caseSensitive && "border-indigo-500/50 bg-indigo-500/10 text-indigo-300"
                    )}
                    title="مطابقة حالة الأحرف (Case sensitive)"
                >
                    Aa
                </Button>

                {/* Close Button */}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onClose}
                    className="h-8 w-8"
                    title="إغلاق (Esc)"
                >
                    <X className="w-4 h-4" />
                </Button>
            </div>
        </div>
    );
}
