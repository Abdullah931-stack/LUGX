import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { getUserProfile } from "@/server/actions/auth-actions";
import { getRemainingQuota } from "@/server/actions/ai-ops";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Settings, LogOut, Plus, Sparkles } from "lucide-react";
import { signOut } from "@/server/actions/auth-actions";

export default async function DashboardPage() {
    const user = await getUser();

    if (!user) {
        redirect("/login");
    }

    const [profileResult, quotaResult] = await Promise.all([
        getUserProfile(),
        getRemainingQuota(),
    ]);

    const profile = profileResult.data;
    const quota = quotaResult;

    return (
        <div className="min-h-screen bg-zinc-950">
            {/* Navigation */}
            <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-lg">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <Link href="/dashboard" className="flex items-center gap-2">
                            <Image
                                src="/logo.png"
                                alt="LUGX"
                                width={100}
                                height={28}
                                className="h-7 w-auto"
                            />
                        </Link>

                        <div className="flex items-center gap-4">
                            <Link href="/workspace">
                                <Button variant="ai" size="sm" className="gap-2">
                                    <Sparkles className="w-4 h-4" />
                                    Open Editor
                                </Button>
                            </Link>

                            <Link href="/account">
                                <Button variant="ghost" size="icon-sm">
                                    <Settings className="w-4 h-4" />
                                </Button>
                            </Link>

                            <form action={signOut}>
                                <Button type="submit" variant="ghost" size="icon-sm">
                                    <LogOut className="w-4 h-4" />
                                </Button>
                            </form>
                        </div>
                    </div>
                </div>
            </nav>

            {/* Main Content */}
            <main className="pt-24 pb-12 px-4 max-w-7xl mx-auto">
                {/* Welcome Header */}
                <div className="mb-8">
                    <h1 className="text-2xl font-medium text-zinc-50">
                        Welcome back, {profile?.displayName || "User"}
                    </h1>
                    <p className="text-zinc-500 mt-1">
                        Your AI-powered text editing workspace
                    </p>
                </div>

                {/* Quick Stats */}
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                    {/* Current Plan */}
                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription>Current Plan</CardDescription>
                            <CardTitle className="text-xl capitalize flex items-center gap-2">
                                {quota?.tier || "Free"}
                                {quota?.tier === "ultra" && (
                                    <span className="text-xs px-2 py-0.5 rounded-full ultra-badge">
                                        ✦
                                    </span>
                                )}
                            </CardTitle>
                        </CardHeader>
                    </Card>

                    {/* Words Remaining */}
                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription>Words Remaining ({quota?.correctImproveTranslate.period || "daily"})</CardDescription>
                            <CardTitle className="text-xl">
                                {quota?.correctImproveTranslate.remaining.toLocaleString() || 0}
                                <span className="text-zinc-500 text-sm font-normal">
                                    {" / "}
                                    {quota?.correctImproveTranslate.limit.toLocaleString() || 0}
                                </span>
                            </CardTitle>
                        </CardHeader>
                    </Card>

                    {/* Summaries Remaining */}
                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription>Summaries Remaining</CardDescription>
                            <CardTitle className="text-xl">
                                {quota?.summarize.remaining || 0}
                                <span className="text-zinc-500 text-sm font-normal">
                                    {" / "}
                                    {quota?.summarize.limit || 0}
                                </span>
                            </CardTitle>
                        </CardHeader>
                    </Card>

                    {/* Prompts Remaining */}
                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription>Prompts Remaining</CardDescription>
                            <CardTitle className="text-xl">
                                {quota?.toPrompt ? (
                                    <>
                                        {quota.toPrompt.remaining}
                                        <span className="text-zinc-500 text-sm font-normal">
                                            {" / "}
                                            {quota.toPrompt.limit}
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-zinc-500 text-sm font-normal">Pro+</span>
                                )}
                            </CardTitle>
                        </CardHeader>
                    </Card>
                </div>

                {/* Quick Actions */}
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {/* New Document */}
                    <Link href="/workspace">
                        <Card className="group hover:border-zinc-700 cursor-pointer transition-all h-full">
                            <CardHeader>
                                <div className="w-12 h-12 rounded-lg bg-indigo-500/10 flex items-center justify-center mb-3 group-hover:bg-indigo-500/20 transition-colors">
                                    <Plus className="w-6 h-6 text-indigo-400" />
                                </div>
                                <CardTitle>New Document</CardTitle>
                                <CardDescription>
                                    Create a new document and start writing
                                </CardDescription>
                            </CardHeader>
                        </Card>
                    </Link>

                    {/* Recent Files */}
                    <Link href="/workspace">
                        <Card className="group hover:border-zinc-700 cursor-pointer transition-all h-full">
                            <CardHeader>
                                <div className="w-12 h-12 rounded-lg bg-violet-500/10 flex items-center justify-center mb-3 group-hover:bg-violet-500/20 transition-colors">
                                    <FileText className="w-6 h-6 text-violet-400" />
                                </div>
                                <CardTitle>Your Files</CardTitle>
                                <CardDescription>
                                    Browse and manage your documents
                                </CardDescription>
                            </CardHeader>
                        </Card>
                    </Link>

                    {/* Upgrade */}
                    {quota?.tier === "free" && (
                        <Link href="/account">
                            <Card className="group hover:border-indigo-500/50 cursor-pointer transition-all h-full border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-transparent">
                                <CardHeader>
                                    <div className="w-12 h-12 rounded-lg bg-indigo-500/20 flex items-center justify-center mb-3 group-hover:bg-indigo-500/30 transition-colors">
                                        <Sparkles className="w-6 h-6 text-indigo-400" />
                                    </div>
                                    <CardTitle>Upgrade to Pro</CardTitle>
                                    <CardDescription>
                                        Unlock more words, summaries, and ToPrompt feature
                                    </CardDescription>
                                </CardHeader>
                            </Card>
                        </Link>
                    )}
                </div>
            </main>
        </div>
    );
}
