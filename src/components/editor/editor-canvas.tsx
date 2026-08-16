"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@/lib/utils";

interface EditorCanvasProps {
    content: string;
    onChange: (content: string) => void;
    placeholder?: string;
    className?: string;
    dir?: "ltr" | "rtl";
}

export function EditorCanvas({
    content,
    onChange,
    placeholder = "Start writing...",
    className,
    dir = "ltr",
}: EditorCanvasProps) {
    const editor = useEditor({
        extensions: [
            StarterKit.configure({
                heading: {
                    levels: [1, 2, 3],
                },
            }),
            Placeholder.configure({
                placeholder,
                emptyEditorClass: "is-editor-empty",
            }),
        ],
        content,
        editorProps: {
            attributes: {
                class: "tiptap-editor outline-none min-h-[60vh] text-zinc-300",
                dir,
            },
        },
        onUpdate: ({ editor }) => {
            onChange(editor.getHTML());
        },
    });

    return (
        <div className={cn("w-full", className)}>
            <EditorContent editor={editor} />
        </div>
    );
}

export function useEditorInstance() {
    return useEditor({
        extensions: [
            StarterKit,
            Placeholder.configure({
                placeholder: "Start writing...",
            }),
        ],
        content: "",
        editorProps: {
            attributes: {
                class: "tiptap-editor outline-none min-h-[60vh] text-zinc-300",
            },
        },
    });
}
