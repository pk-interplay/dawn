import type { Metadata } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Sentient (Indian Type Foundry, ITF Free Font License — see app/fonts/FFL.txt)
 * is Dawn's display face: the wordmark and section headings. Self-hosted as the
 * two variable files so the whole 200–800 weight range costs one request per
 * style and nothing render-blocks on a third-party CDN.
 */
const sentient = localFont({
  src: [
    {
      path: "./fonts/Sentient-Variable.woff2",
      weight: "200 800",
      style: "normal",
    },
    {
      path: "./fonts/Sentient-VariableItalic.woff2",
      weight: "200 800",
      style: "italic",
    },
  ],
  variable: "--font-sentient",
  display: "swap",
  fallback: ["ui-serif", "Georgia", "Cambria", "serif"],
});

/**
 * Inter carries body copy and every piece of UI chrome. The reference build
 * leaves this to the system stack (-apple-system / Segoe UI); loading Inter
 * pins the same shape across platforms instead of drifting per OS.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Dawn — Your Personal Super-Connector",
  description:
    "A hands-off connector. Put your professional info in, and Dawn sends you vetted, credible connections in return — the people you actually need to hire, raise from, sell to, learn from, or partner with.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${sentient.variable} ${inter.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
