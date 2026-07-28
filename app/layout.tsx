import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dawn",
  description: "The agent that knows where you're going.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
