"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, ChevronUp, ChevronDown, Replace } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchReplaceProps {
    editor: Editor | null;
    isOpen: boolean;
    onClose: () => void;
}

export function SearchReplace({ editor, isOpen, onClose }: SearchReplaceProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const [replaceQuery, setReplaceQuery] = useState("");
    const [matches, setMatches] = useState<{ index: number; from: number; to: number }[]>([]);
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [shouldSearch, setShouldSearch] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Find all matches in the editor content
    const findMatches = useCallback(() => {
        if (!editor || !searchQuery) {
            setMatches([]);
            setCurrentMatchIndex(0);
            return;
        }

        try {
            const content = editor.getText();
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

                position = index + 1;
            }

            setMatches(foundMatches);
            setCurrentMatchIndex(0);

            // Highlight first match
            if (foundMatches.length > 0) {
                highlightMatch(foundMatches[0]);
            }
        } catch (error) {
            console.error("Search error:", error);
            setMatches([]);
        }
    }, [editor, searchQuery, caseSensitive]);

    // Highlight specific match
    const highlightMatch = useCallback((match: { from: number; to: number }) => {
        if (!editor) return;

        try {
            editor.commands.setTextSelection({ from: match.from + 1, to: match.to + 1 });
            editor.commands.focus();
        } catch (error) {
            console.error("Highlight error:", error);
        }
    }, [editor]);

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
        if (!editor || matches.length === 0 || !replaceQuery) return;

        try {
            const currentMatch = matches[currentMatchIndex];
            const { from, to } = currentMatch;

            // Replace the text
            editor.chain()
                .focus()
                .setTextSelection({ from: from + 1, to: to + 1 })
                .insertContent(replaceQuery)
                .run();

            // Refresh matches after replacement
            setTimeout(() => {
                findMatches();
            }, 100);
        } catch (error) {
            console.error("Replace error:", error);
        }
    }, [editor, matches, currentMatchIndex, replaceQuery, findMatches]);

    // Replace all matches
    const replaceAllMatches = useCallback(() => {
        if (!editor || matches.length === 0 || !replaceQuery) return;

        try {
            const content = editor.getText();
            const searchText = caseSensitive ? searchQuery : searchQuery.toLowerCase();
            const contentToReplace = caseSensitive ? content : content.toLowerCase();

            // Replace all occurrences
            let newContent = "";
            let lastIndex = 0;

            matches.forEach((match) => {
                newContent += content.substring(lastIndex, match.from);
                newContent += replaceQuery;
                lastIndex = match.to;
            });
            newContent += content.substring(lastIndex);

            // Set new content
            editor.commands.setContent(newContent);

            // Clear matches
            setMatches([]);
            setCurrentMatchIndex(0);
            setSearchQuery("");
            setReplaceQuery("");
        } catch (error) {
            console.error("Replace all error:", error);
        }
    }, [editor, matches, searchQuery, replaceQuery, caseSensitive]);

    // Debounced search effect (triggers after 2 seconds of stopping typing)
    useEffect(() => {
        // Clear previous timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
            searchTimeoutRef.current = null;
        }

        if (!searchQuery) {
            setMatches([]);
            setCurrentMatchIndex(0);
            setShouldSearch(false);
            return;
        }

        // If explicitly triggered (Enter pressed), search immediately
        if (shouldSearch) {
            findMatches();
            setShouldSearch(false);
            return;
        }

        // Set new timeout - search after 2 seconds of no typing
        searchTimeoutRef.current = setTimeout(() => {
            findMatches();
        }, 2000);

        // Cleanup function
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
                // If matches exist, go to next
                goToNextMatch();
            } else {
                // If no matches yet, trigger search immediately
                setShouldSearch(true);
            }
        }
    };

    // Keyboard shortcuts
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Shift + Enter: Previous match
            if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                goToPreviousMatch();
            }
            // Ctrl + Enter: Replace current
            else if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                replaceCurrentMatch();
            }
            // Escape: Close
            else if (e.key === "Escape") {
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
                        placeholder="Find... (Press Enter or wait 2s)"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyPress={handleSearchKeyPress}
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
                            title="Previous match (Shift+Enter)"
                        >
                            <ChevronUp className="w-4 h-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={goToNextMatch}
                            disabled={matches.length === 0}
                            title="Next match (Enter)"
                        >
                            <ChevronDown className="w-4 h-4" />
                        </Button>
                    </div>
                </div>

                {/* Replace Input */}
                <div className="flex-1 flex items-center gap-2">
                    <Input
                        type="text"
                        placeholder="Replace with..."
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
                            title="Replace (Ctrl+Enter)"
                        >
                            <Replace className="w-3 h-3 mr-1" />
                            Replace
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={replaceAllMatches}
                            disabled={matches.length === 0 || !replaceQuery}
                            className="h-8 text-xs"
                            title="Replace all"
                        >
                            All
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
                        caseSensitive && "border-indigo-500/50"
                    )}
                    title="Case sensitive"
                >
                    Aa
                </Button>

                {/* Close Button */}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onClose}
                    className="h-8 w-8"
                    title="Close (Esc)"
                >
                    <X className="w-4 h-4" />
                </Button>
            </div>
        </div>
    );
}
