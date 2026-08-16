import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { Sidebar } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";
import { Settings, Home } from "lucide-react";

export default async function WorkspaceLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const user = await getUser();

    if (!user) {
        redirect("/login");
    }

    return (
        <div className="h-screen bg-zinc-950 flex overflow-hidden">
            {/* Sidebar */}
            <Sidebar />

            {/* Main Area */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Top Bar */}
                <header className="h-14 border-b border-zinc-800/50 bg-zinc-950 flex items-center justify-between px-4 flex-shrink-0">
                    <Link href="/dashboard" className="flex items-center gap-2">
                        <Image
                            src="/logo.png"
                            alt="LUGX"
                            width={80}
                            height={24}
                            className="h-6 w-auto"
                        />
                    </Link>

                    <div className="flex items-center gap-2">
                        <Link href="/dashboard">
                            <Button variant="ghost" size="icon-sm">
                                <Home className="w-4 h-4" />
                            </Button>
                        </Link>
                        <Link href="/account">
                            <Button variant="ghost" size="icon-sm">
                                <Settings className="w-4 h-4" />
                            </Button>
                        </Link>
                    </div>
                </header>

                {/* Content - Independent scrolling container */}
                <main className="flex-1 overflow-auto">
                    {children}
                </main>
            </div>
        </div>
    );
}
