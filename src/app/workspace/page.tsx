import { redirect } from "next/navigation";
import Link from "next/link";
import { getUser } from "@/lib/supabase/server";
import { getRootFiles, createFile } from "@/server/actions/file-ops";
import { Button } from "@/components/ui/button";
import { Plus, FileText, Folder, Sparkles } from "lucide-react";

export default async function WorkspacePage() {
    const user = await getUser();

    if (!user) {
        redirect("/login");
    }

    const filesResult = await getRootFiles();
    const files = filesResult.data || [];

    return (
        <div className="p-6">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-2xl font-medium text-zinc-50">Workspace</h1>
                        <p className="text-zinc-500 mt-1">
                            Your documents and folders
                        </p>
                    </div>

                    <form
                        action={async () => {
                            "use server";
                            const result = await createFile("Untitled Document", null, false);
                            if (result.success && result.data) {
                                redirect(`/workspace/editor/${result.data.id}`);
                            }
                        }}
                    >
                        <Button type="submit" variant="ai" className="gap-2">
                            <Plus className="w-4 h-4" />
                            New Document
                        </Button>
                    </form>
                </div>

                {/* Files Grid */}
                {files.length === 0 ? (
                    <div className="text-center py-20">
                        <div className="w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center mx-auto mb-4">
                            <Sparkles className="w-8 h-8 text-zinc-500" />
                        </div>
                        <h2 className="text-lg font-medium text-zinc-400 mb-2">
                            No documents yet
                        </h2>
                        <p className="text-zinc-500 text-sm mb-6">
                            Create your first document to get started
                        </p>
                        <form
                            action={async () => {
                                "use server";
                                const result = await createFile("Untitled Document", null, false);
                                if (result.success && result.data) {
                                    redirect(`/workspace/editor/${result.data.id}`);
                                }
                            }}
                        >
                            <Button type="submit" variant="primary" className="gap-2">
                                <Plus className="w-4 h-4" />
                                Create Document
                            </Button>
                        </form>
                    </div>
                ) : (
                    <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {files.map((file) => (
                            <Link
                                key={file.id}
                                href={file.isFolder ? `/workspace` : `/workspace/editor/${file.id}`}
                                className="group block"
                            >
                                <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/50 hover:border-zinc-700 transition-all">
                                    <div className="w-10 h-10 rounded-lg bg-zinc-800/50 flex items-center justify-center mb-3 group-hover:bg-zinc-800 transition-colors">
                                        {file.isFolder ? (
                                            <Folder className="w-5 h-5 text-amber-500/70" />
                                        ) : (
                                            <FileText className="w-5 h-5 text-zinc-500" />
                                        )}
                                    </div>
                                    <h3 className="font-medium text-zinc-300 truncate group-hover:text-zinc-50 transition-colors">
                                        {file.title}
                                    </h3>
                                    <p className="text-xs text-zinc-500 mt-1">
                                        {new Date(file.updatedAt).toLocaleDateString()}
                                    </p>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
