import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Sparkles, FileText, Languages, Wand2, ArrowRight } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2">
              <Image
                src="/logo.png"
                alt="LUGX"
                width={120}
                height={32}
                className="h-8 w-auto"
                priority
              />
            </Link>

            {/* Nav Links */}
            <div className="hidden md:flex items-center gap-6">
              <Link
                href="#features"
                className="text-zinc-400 hover:text-zinc-50 text-sm transition-colors"
              >
                Features
              </Link>
              <Link
                href="#pricing"
                className="text-zinc-400 hover:text-zinc-50 text-sm transition-colors"
              >
                Pricing
              </Link>
            </div>

            {/* Auth Buttons */}
            <div className="flex items-center gap-3">
              <Link href="/login">
                <Button variant="ghost" size="sm">
                  Sign In
                </Button>
              </Link>
              <Link href="/login">
                <Button variant="primary" size="sm">
                  Get Started
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm mb-6">
            <Sparkles className="w-4 h-4" />
            AI-Powered Text Editing
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-medium text-zinc-50 tracking-tight mb-6">
            Transform Your Writing with
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-violet-400">
              {" "}Intelligent AI
            </span>
          </h1>

          <p className="text-lg text-zinc-400 max-w-2xl mx-auto mb-8">
            Professional cloud-based text editing with AI-powered correction, improvement,
            summarization, translation, and prompt generation. Full RTL/LTR support.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/login">
              <Button variant="primary" size="xl" className="gap-2">
                Start Writing Free
                <ArrowRight className="w-5 h-5" />
              </Button>
            </Link>
            <Link href="#features">
              <Button variant="outline" size="xl">
                Explore Features
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 px-4 border-t border-zinc-800/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-medium text-zinc-50 mb-4">
              Powerful AI Features
            </h2>
            <p className="text-zinc-400 max-w-2xl mx-auto">
              Five specialized AI engines designed for different aspects of text processing
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Correct */}
            <Card className="group hover:border-zinc-700 transition-all">
              <CardHeader>
                <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center mb-3">
                  <Check className="w-5 h-5 text-indigo-400" />
                </div>
                <CardTitle className="text-xl">Correct</CardTitle>
                <CardDescription>
                  Fix grammar, spelling, and punctuation while preserving your style
                </CardDescription>
              </CardHeader>
            </Card>

            {/* Improve */}
            <Card className="group hover:border-zinc-700 transition-all">
              <CardHeader>
                <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center mb-3">
                  <Wand2 className="w-5 h-5 text-violet-400" />
                </div>
                <CardTitle className="text-xl">Improve</CardTitle>
                <CardDescription>
                  Elevate your text with enhanced vocabulary and refined structure
                </CardDescription>
              </CardHeader>
            </Card>

            {/* Summarize */}
            <Card className="group hover:border-zinc-700 transition-all">
              <CardHeader>
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center mb-3">
                  <FileText className="w-5 h-5 text-emerald-400" />
                </div>
                <CardTitle className="text-xl">Summarize</CardTitle>
                <CardDescription>
                  Extract key information from long texts into concise summaries
                </CardDescription>
              </CardHeader>
            </Card>

            {/* Translate */}
            <Card className="group hover:border-zinc-700 transition-all">
              <CardHeader>
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center mb-3">
                  <Languages className="w-5 h-5 text-amber-400" />
                </div>
                <CardTitle className="text-xl">Translate</CardTitle>
                <CardDescription>
                  Seamless Arabic-English translation with cultural adaptation
                </CardDescription>
              </CardHeader>
            </Card>

            {/* ToPrompt */}
            <Card className="group hover:border-zinc-700 transition-all md:col-span-2 lg:col-span-2">
              <CardHeader>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                    <Sparkles className="w-5 h-5 text-indigo-400" />
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    Pro & Ultra
                  </span>
                </div>
                <CardTitle className="text-xl">ToPrompt</CardTitle>
                <CardDescription>
                  Transform your ideas into powerful, optimized AI prompts with advanced prompt engineering
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-20 px-4 border-t border-zinc-800/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-medium text-zinc-50 mb-4">
              Simple Pricing
            </h2>
            <p className="text-zinc-400">
              Choose the plan that fits your needs
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {/* Free Plan */}
            <Card>
              <CardHeader>
                <CardTitle className="text-2xl">Free</CardTitle>
                <CardDescription>Get started with basic features</CardDescription>
                <div className="mt-4">
                  <span className="text-4xl font-medium text-zinc-50">$0</span>
                  <span className="text-zinc-500">/month</span>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm text-zinc-400">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    2,000 words/week
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    1 summary/day (500 words max)
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    Cloud storage
                  </li>
                </ul>
                <Link href="/login" className="block mt-6">
                  <Button variant="outline" className="w-full">
                    Start Free
                  </Button>
                </Link>
              </CardContent>
            </Card>

            {/* Pro Plan */}
            <Card className="border-indigo-500/50 relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-indigo-500 text-white text-xs rounded-full">
                Recommended
              </div>
              <CardHeader>
                <CardTitle className="text-2xl">Pro</CardTitle>
                <CardDescription>For serious writers</CardDescription>
                <div className="mt-4">
                  <span className="text-4xl font-medium text-zinc-50">$12</span>
                  <span className="text-zinc-500">/month</span>
                  <span className="ml-2 text-sm text-zinc-500 line-through">$15</span>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm text-zinc-400">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    20,000 words/day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    5 summaries/day (5,000 words)
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    10 prompts/day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    Advanced AI models
                  </li>
                </ul>
                <Link href="/login" className="block mt-6">
                  <Button variant="primary" className="w-full">
                    Upgrade to Pro
                  </Button>
                </Link>
              </CardContent>
            </Card>

            {/* Ultra Plan */}
            <Card className="border-yellow-500/20">
              <CardHeader>
                <CardTitle className="text-2xl flex items-center gap-2">
                  Ultra
                  <span className="text-xs px-2 py-0.5 rounded-full ultra-badge">
                    Enterprise
                  </span>
                </CardTitle>
                <CardDescription>Maximum power</CardDescription>
                <div className="mt-4">
                  <span className="text-4xl font-medium text-zinc-50">$120</span>
                  <span className="text-zinc-500">/month</span>
                  <span className="ml-2 text-sm text-zinc-500 line-through">$160</span>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm text-zinc-400">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    250,000 words/day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    50 summaries/day (30,000 words)
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    500 prompts/day
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    Premium AI models
                  </li>
                </ul>
                <Link href="/login" className="block mt-6">
                  <Button variant="outline" className="w-full">
                    Go Ultra
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-4 border-t border-zinc-800/50">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Image
            src="/logo.png"
            alt="LUGX"
            width={80}
            height={24}
            className="h-6 w-auto opacity-50"
          />
          <p className="text-sm text-zinc-500">
            © 2026 LUGX. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
