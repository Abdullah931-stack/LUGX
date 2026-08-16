/**
 * Site Configuration
 */

export const siteConfig = {
    name: "LUGX",
    description: "AI-Powered Professional Text Editing Platform",
    url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",

    // Navigation links
    navLinks: [
        { href: "/dashboard", label: "Dashboard" },
        { href: "/workspace", label: "Workspace" },
        { href: "/account", label: "Account" },
    ],

    // Supported languages
    languages: [
        { code: "en", name: "English", dir: "ltr" },
        { code: "ar", name: "العربية", dir: "rtl" },
    ] as const,

    // Default language (auto-detected from browser)
    defaultLanguage: "en",

    // Contact/Support
    support: {
        email: "support@lugx.app",
        getHelpUrl: "/support",
    },
};

export type Language = typeof siteConfig.languages[number];
