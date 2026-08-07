"use client";

/**
 * The right-hand icon rail from the reference build (/Dawn/dawn.css §2).
 *
 * It is `fixed` rather than a flex sibling on purpose: hovering grows it from
 * 56px to 200px to reveal labels, and taking it out of flow means the page
 * content behind it never shifts when that happens.
 *
 * Two differences from the reference worth naming. It injected the label spans
 * with JS by reading each button's `aria-label` — here they are just JSX, so the
 * absolutely-positioned `.tooltip` those labels replaced is not ported at all.
 * And auth is real: `signedIn` is passed down from a server component that read
 * the NextAuth session, rather than the reference's `sessionStorage` stub.
 *
 * Taking `signedIn` as a prop rather than calling `useSession()` is deliberate — it
 * keeps this a leaf component with no SessionProvider requirement, so the pages
 * that render it (`/`, `/about`, `/chat`) stay server components that read the
 * session once and render the correct rail on the first paint. `useSession()` would
 * flash the signed-out rail on every load.
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import {
  HelpCircle,
  LogIn,
  LogOut,
  MessageCircle,
  Settings,
  Shield,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

const GATE_MESSAGE = "Please Sign In to Access This Feature";
const SOON_MESSAGE = "Coming Soon";

interface RailItem {
  label: string;
  icon: LucideIcon;
  /** Navigates here when set; otherwise `onSelect` runs. */
  href?: string;
  onSelect?: () => void;
}

export function DawnRail({ signedIn = false }: { signedIn?: boolean }) {
  const router = useRouter();
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function flash(message: string) {
    setToast(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3000);
  }

  // Signed out, the first two slots recruit; signed in, they become the account
  // controls. Same positions either way, which is what the reference's
  // `.rail-item-*` display swaps achieve.
  //
  // There is one provider and one entry point, so "Sign In" and "Sign Up" are the
  // same action — the second slot points at the chat instead of duplicating it.
  // "My Account" is gone with /me; a claims-backed profile view is the follow-up.
  const accountItems: RailItem[] = signedIn
    ? [
        { label: "Sign Out", icon: LogOut, onSelect: () => void signOut({ redirectTo: "/" }) },
        { label: "Chat", icon: MessageCircle, href: "/chat" },
      ]
    : [
        { label: "Sign In", icon: LogIn, onSelect: () => router.push("/api/auth/signin?callbackUrl=%2Fonboarding") },
        { label: "About", icon: HelpCircle, href: "/about" },
      ];

  const toolItems: RailItem[] = [
    // There is no settings route in this app yet, so the slot is kept for shape
    // and says so rather than linking nowhere.
    { label: "Settings", icon: Settings, onSelect: () => flash(SOON_MESSAGE) },
    signedIn
      ? { label: "Admin", icon: Shield, href: "/admin" }
      : { label: "Admin", icon: Shield, onSelect: () => flash(GATE_MESSAGE) },
    { label: "Help", icon: HelpCircle, onSelect: () => flash(SOON_MESSAGE) },
  ];

  return (
    <>
      {/* Top-centre toast, per dawn-index.html, with dawn.css §7's softer spring. */}
      <div
        aria-live="polite"
        className={cn(
          "pointer-events-none fixed top-[22px] left-1/2 z-100 -translate-x-1/2 rounded-[10px]",
          "border border-[#2e3645] bg-[#1a1f29] px-[18px] py-2.5",
          "text-[13.5px] font-medium text-[#e5e7eb] shadow-[0_8px_24px_rgba(0,0,0,0.4)]",
          "transition-[opacity,transform] duration-200 ease-[cubic-bezier(.34,1.56,.64,1)]",
          toast ? "translate-y-0 opacity-100" : "-translate-y-5 opacity-0",
        )}
      >
        {toast ?? GATE_MESSAGE}
      </div>

      <nav
        aria-label="Account"
        style={{ "--dawn-delay": "60ms" } as React.CSSProperties}
        className={cn(
          "group/rail dawn-enter fixed inset-y-0 right-0 z-20 flex w-14 flex-col",
          "items-center justify-between border-l border-border bg-background py-3.5",
          "transition-[width] duration-[260ms] ease-[cubic-bezier(.22,.61,.36,1)] hover:w-[200px]",
        )}
      >
        <RailGroup items={accountItems} />
        <RailGroup items={toolItems} />
      </nav>
    </>
  );
}

function RailGroup({ items }: { items: RailItem[] }) {
  return (
    <div className="flex flex-col items-center gap-2.5">
      {items.map((item) => (
        <RailButton key={item.label} item={item} />
      ))}
    </div>
  );
}

function RailButton({ item }: { item: RailItem }) {
  const Icon = item.icon;

  const shell = cn(
    "group/btn relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center",
    "overflow-visible rounded-[10px] border-0 bg-transparent",
    "transition-[background,width,padding] duration-[220ms] ease-[cubic-bezier(.22,.61,.36,1)]",
    "hover:bg-[#1a1f29]",
    // The rail expanding is what widens each button and left-aligns its contents.
    "group-hover/rail:w-[176px] group-hover/rail:justify-start group-hover/rail:gap-3 group-hover/rail:pl-[11px]",
  );

  const body = (
    <>
      <Icon
        strokeWidth={2}
        className="size-[18px] shrink-0 text-muted-foreground transition-colors duration-[120ms] group-hover/btn:text-dawn-bone"
      />
      <span
        className={cn(
          "pointer-events-none ml-0 max-w-0 -translate-x-1.5 overflow-hidden",
          "text-[13.5px] leading-none font-medium whitespace-nowrap opacity-0",
          "text-muted-foreground group-hover/btn:text-dawn-bone",
          "transition-[opacity,transform,max-width,color] duration-[180ms] delay-[60ms]",
          "group-hover/rail:pointer-events-auto group-hover/rail:ml-1",
          "group-hover/rail:max-w-40 group-hover/rail:translate-x-0 group-hover/rail:opacity-100",
        )}
      >
        {item.label}
      </span>
    </>
  );

  if (item.href) {
    return (
      <Link href={item.href} aria-label={item.label} className={shell}>
        {body}
      </Link>
    );
  }

  return (
    <button type="button" aria-label={item.label} onClick={item.onSelect} className={shell}>
      {body}
    </button>
  );
}
