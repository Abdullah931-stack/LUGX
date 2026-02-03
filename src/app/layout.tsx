import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const ibmPlexArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-ibm-plex-arabic",
  subsets: ["arabic"],
  weight: ["300", "400", "500", "600"],
});

export const metadata: Metadata = {
  title: "LUGX - AI-Powered Text Editing Platform",
  description: "Professional cloud-based text editing with AI-powered correction, improvement, summarization, translation, and prompt generation.",
  keywords: ["AI", "text editor", "writing", "translation", "summarization", "cloud"],
  authors: [{ name: "LUGX Team" }],
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${ibmPlexArabic.variable} font-sans antialiased bg-zinc-950 min-h-screen`}
      >
        {children}
      </body>
    </html>
  );
}
