import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Sentient (Indian Type Foundry, ITF Free Font License — see app/fonts/FFL.txt)
 * is Dawn's core typeface. Self-hosted as the two variable files so the whole
 * 200–800 weight range costs one request per style and nothing render-blocks
 * on a third-party CDN.
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

export const metadata: Metadata = {
  title: "Dawn",
  description:
    "Your networking agent. It works the room you never walk into, and brings back the person you needed to meet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${sentient.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
