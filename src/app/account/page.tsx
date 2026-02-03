import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { getUserProfile, signOut } from "@/server/actions/auth-actions";
import { getRemainingQuota } from "@/server/actions/ai-ops";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TIER_LIMITS, getTierDisplayName } from "@/config/tiers.config";
import { ArrowLeft, User, CreditCard, LogOut, Check, ExternalLink } from "lucide-react";
import { UpgradeButton } from "@/components/subscription/upgrade-button";


export default async function AccountPage() {
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
    const currentTier = quota?.tier || "free";

    return (
        <div className="min-h-screen bg-zinc-950">
            {/* Navigation */}
            <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-lg">
                <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <div className="flex items-center gap-4">
                            <Link href="/dashboard">
                                <Button variant="ghost" size="icon-sm">
                                    <ArrowLeft className="w-4 h-4" />
                                </Button>
                            </Link>
                            <Link href="/dashboard">
                                <Image
                                    src="/logo.png"
                                    alt="LUGX"
                                    width={80}
                                    height={24}
                                    className="h-6 w-auto"
                                />
                            </Link>
                        </div>

                        <form action={signOut}>
                            <Button type="submit" variant="ghost" size="sm" className="gap-2">
                                <LogOut className="w-4 h-4" />
                                Sign Out
                            </Button>
                        </form>
                    </div>
                </div>
            </nav>

            {/* Main Content */}
            <main className="pt-24 pb-12 px-4 max-w-4xl mx-auto">
                <h1 className="text-2xl font-medium text-zinc-50 mb-8">Account Settings</h1>

                <div className="space-y-6">
                    {/* Profile Section */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <User className="w-5 h-5" />
                                Profile
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center gap-4">
                                {profile?.avatarUrl ? (
                                    <Image
                                        src={profile.avatarUrl}
                                        alt={profile.displayName || "User"}
                                        width={64}
                                        height={64}
                                        className="rounded-full"
                                    />
                                ) : (
                                    <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 text-xl">
                                        {profile?.displayName?.[0]?.toUpperCase() || "U"}
                                    </div>
                                )}
                                <div>
                                    <h3 className="font-medium text-zinc-50">
                                        {profile?.displayName || "User"}
                                    </h3>
                                    <p className="text-sm text-zinc-500">{profile?.email}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Subscription Section */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <CreditCard className="w-5 h-5" />
                                Subscription
                            </CardTitle>
                            <CardDescription>
                                Manage your subscription and billing
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 mb-6">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg font-medium text-zinc-50 capitalize">
                                            {getTierDisplayName(currentTier)}
                                        </span>
                                        {currentTier === "ultra" && (
                                            <span className="text-xs px-2 py-0.5 rounded-full ultra-badge">
                                                ✦
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-sm text-zinc-500 mt-1">
                                        ${TIER_LIMITS[currentTier].price.monthly}/month
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    {/* Show Pro button if user is on Free */}
                                    {currentTier === "free" && (
                                        <UpgradeButton
                                            tier="pro"
                                            currentTier={currentTier}
                                        />
                                    )}
                                    {/* Show Ultra button if user is on Free or Pro */}
                                    {currentTier !== "ultra" && (
                                        <UpgradeButton
                                            tier="ultra"
                                            currentTier={currentTier}
                                        />
                                    )}
                                </div>
                            </div>

                            {/* Remaining Quota */}
                            <div className="space-y-4">
                                <h4 className="text-sm font-medium text-zinc-400">Remaining Quota</h4>

                                {/* Words */}
                                <div>
                                    <div className="flex justify-between text-sm mb-1">
                                        <span className="text-zinc-400">
                                            Words ({quota?.correctImproveTranslate.period})
                                        </span>
                                        <span className="text-zinc-300">
                                            {quota?.correctImproveTranslate.remaining.toLocaleString()} / {quota?.correctImproveTranslate.limit.toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-indigo-500 transition-all"
                                            style={{
                                                width: `${Math.min(
                                                    ((quota?.correctImproveTranslate.remaining || 0) /
                                                        (quota?.correctImproveTranslate.limit || 1)) *
                                                    100,
                                                    100
                                                )}%`,
                                            }}
                                        />
                                    </div>
                                </div>

                                {/* Summaries */}
                                <div>
                                    <div className="flex justify-between text-sm mb-1">
                                        <span className="text-zinc-400">Summaries (daily)</span>
                                        <span className="text-zinc-300">
                                            {quota?.summarize.remaining} / {quota?.summarize.limit}
                                        </span>
                                    </div>
                                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-violet-500 transition-all"
                                            style={{
                                                width: `${Math.min(
                                                    ((quota?.summarize.remaining || 0) /
                                                        (quota?.summarize.limit || 1)) *
                                                    100,
                                                    100
                                                )}%`,
                                            }}
                                        />
                                    </div>
                                </div>

                                {/* ToPrompt */}
                                {quota?.toPrompt && (
                                    <div>
                                        <div className="flex justify-between text-sm mb-1">
                                            <span className="text-zinc-400">ToPrompt (daily)</span>
                                            <span className="text-zinc-300">
                                                {quota.toPrompt.remaining} / {quota.toPrompt.limit}
                                            </span>
                                        </div>
                                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-amber-500 transition-all"
                                                style={{
                                                    width: `${Math.min(
                                                        ((quota.toPrompt.remaining || 0) /
                                                            (quota.toPrompt.limit || 1)) *
                                                        100,
                                                        100
                                                    )}%`,
                                                }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Plan Comparison */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Available Plans</CardTitle>
                            <CardDescription>
                                Compare features and upgrade your plan
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="grid md:grid-cols-3 gap-4">
                                {(["free", "pro", "ultra"] as const).map((tier) => {
                                    const limits = TIER_LIMITS[tier];
                                    const isCurrentPlan = currentTier === tier;

                                    return (
                                        <div
                                            key={tier}
                                            className={`p-4 rounded-lg border ${isCurrentPlan
                                                ? "border-indigo-500/50 bg-indigo-500/5"
                                                : "border-zinc-800"
                                                }`}
                                        >
                                            <div className="flex items-center justify-between mb-3">
                                                <span className="font-medium text-zinc-50 capitalize">
                                                    {tier}
                                                </span>
                                                {isCurrentPlan && (
                                                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">
                                                        Current
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-2xl font-medium text-zinc-50 mb-3">
                                                ${limits.price.monthly}
                                                <span className="text-sm text-zinc-500 font-normal">/mo</span>
                                            </div>
                                            <ul className="space-y-2 text-sm text-zinc-400">
                                                <li className="flex items-center gap-2">
                                                    <Check className="w-4 h-4 text-emerald-500" />
                                                    {limits.correctImproveTranslate.words.toLocaleString()} words/{limits.correctImproveTranslate.period}
                                                </li>
                                                <li className="flex items-center gap-2">
                                                    <Check className="w-4 h-4 text-emerald-500" />
                                                    {limits.summarize.dailyLimit} summaries/day
                                                </li>
                                                <li className="flex items-center gap-2">
                                                    {limits.toPrompt ? (
                                                        <>
                                                            <Check className="w-4 h-4 text-emerald-500" />
                                                            {limits.toPrompt.dailyLimit} prompts/day
                                                        </>
                                                    ) : (
                                                        <span className="text-zinc-500">No ToPrompt</span>
                                                    )}
                                                </li>
                                            </ul>
                                        </div>
                                    );
                                })}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </main>
        </div>
    );
}
