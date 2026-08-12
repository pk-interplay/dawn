"use client";

/**
 * The left rail, rebuilt on shadcn's Sidebar primitives (components/ui/sidebar).
 *
 * This replaces the hand-rolled DawnRail: a `fixed` element that grew from 56px to
 * 200px on hover and faked its labels with max-width transitions. The shadcn version
 * is `collapsible="icon"`, so the same two states are real — a 3rem icon rail and a
 * 16rem labelled sidebar — with a toggle, keyboard shortcut (⌘B), tooltips on the
 * collapsed icons, a mobile sheet, and the open state persisted to a cookie. It
 * starts collapsed, which is how the rail always looked at rest.
 *
 * `DawnShell` is the layout half: SidebarProvider + SidebarInset. Pages render it
 * around their own content instead of dropping a fixed rail next to it, which is what
 * lets the content actually reflow when the sidebar opens.
 *
 * Auth stays a prop rather than `useSession()` — the pages that render this read the
 * session server-side, so the correct rail is in the first paint with no signed-out
 * flash, and no SessionProvider is needed anywhere.
 */

import Link from "next/link";
import { signIn, signOut } from "next-auth/react";
import { LogIn, LogOut, MessageCircle, Shield, UserRound, type LucideIcon } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

interface RailItem {
  label: string;
  icon: LucideIcon;
  /** Navigates here when set; otherwise `onSelect` runs. */
  href?: string;
  onSelect?: () => void;
}

export function DawnShell({
  signedIn = false,
  isAdmin = false,
  children,
}: {
  signedIn?: boolean;
  /** Gates the Admin item: only the allowlisted operators (admin-auth.ts) see it. */
  isAdmin?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider defaultOpen={false} className="h-svh min-h-0 overflow-hidden">
      <DawnSidebar signedIn={signedIn} isAdmin={isAdmin} />
      <SidebarInset className="min-h-0 overflow-hidden">{children}</SidebarInset>
    </SidebarProvider>
  );
}

export function DawnSidebar({
  signedIn = false,
  isAdmin = false,
}: {
  signedIn?: boolean;
  isAdmin?: boolean;
}) {
  // Navigation lives at the top; the account control sits at the bottom, where the
  // account control conventionally is. Signed out that bottom slot recruits instead.
  //
  // There is one provider and one entry point, so "Sign In" and "Sign Up" are the same
  // action. Google sign-in needs a POST with CSRF, which next-auth/react's signIn does;
  // a GET to /api/auth/signin does NOT work here, because pages.signIn is "/" and that
  // route just redirects back to the landing page in a loop (see app/page.tsx).
  const navItems: RailItem[] = signedIn
    ? [
        { label: "Chat", icon: MessageCircle, href: "/chat" },
        { label: "Profile", icon: UserRound, href: "/profile" },
      ]
    : [];

  // Settings and Help are both gone: neither had a destination, so each slot only ever
  // flashed a "coming soon" toast. Restore them when the routes exist.
  const footerItems: RailItem[] = [
    ...(isAdmin ? [{ label: "Admin", icon: Shield, href: "/admin" } as RailItem] : []),
    signedIn
      ? { label: "Sign Out", icon: LogOut, onSelect: () => void signOut({ redirectTo: "/" }) }
      : {
          label: "Sign In",
          icon: LogIn,
          onSelect: () => void signIn("google", { callbackUrl: "/onboarding" }),
        },
  ];

  return (
    <Sidebar collapsible="icon" className="border-border">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarTrigger className="text-muted-foreground hover:text-dawn-bone size-8" />
              </SidebarMenuItem>
              {navItems.map((item) => (
                <RailMenuItem key={item.label} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {footerItems.map((item) => (
            <RailMenuItem key={item.label} item={item} />
          ))}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function RailMenuItem({ item }: { item: RailItem }) {
  const Icon = item.icon;

  return (
    <SidebarMenuItem>
      {/* `tooltip` is what the collapsed rail shows in place of the label — the same
          job the old build's aria-label-driven spans did, minus the hover-grow. */}
      <SidebarMenuButton asChild={Boolean(item.href)} tooltip={item.label} onClick={item.onSelect}>
        {item.href ? (
          <Link href={item.href}>
            <Icon />
            <span>{item.label}</span>
          </Link>
        ) : (
          <>
            <Icon />
            <span>{item.label}</span>
          </>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
