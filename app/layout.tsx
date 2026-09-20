import type { Metadata } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import Providers from "./providers";
import NavConnectionStatus from "@/components/NavConnectionStatus";

const display = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Veylnor Reel Generator",
  description: "Clip sequencing for Veylnor Reels",
};

const NAV = [
  { href: "/clips", label: "Clips" },
  { href: "/songs", label: "Songs" },
  { href: "/generate", label: "Generate" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="font-body min-h-screen">
        <Providers>
          <header className="border-b border-panelBorder">
            <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
              <Link href="/generate" className="font-display text-xl tracking-wide text-goldSoft">
                Veylnor
              </Link>
              <nav className="flex items-center gap-6">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="text-sm text-muted hover:text-ink transition-colors"
                  >
                    {item.label}
                  </Link>
                ))}
                <NavConnectionStatus />
              </nav>
            </div>
          </header>
          <main className="max-w-5xl mx-auto px-6 py-10">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
