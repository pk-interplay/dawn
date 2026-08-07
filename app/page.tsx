/**
 * Dawn's home screen, following /Dawn/ on the reference build: a locked viewport
 * holding nothing but the wordmark lockup and a single pill, with the icon rail
 * pinned to the right and an About link in the corner.
 *
 * The reference's pill opens a chat, and now so does this one. It used to route by
 * where the visitor stood — sign in, finish onboarding, or a dashboard — because
 * there was no chat to open, which made the app's one button a promise it couldn't
 * keep. Two destinations now: signed out it starts Google sign-in, and signed in it
 * goes to the chat. Onboarding is not a third case; `/chat` sends anyone who hasn't
 * finished it to `/onboarding` itself, so the button never has to know.
 *
 * A server component on purpose. Reading the session here means the greeting and the
 * correct rail render on the first paint; `useSession()` in the client would flash
 * the signed-out state on every load, on the one screen where that is most visible.
 */

import Link from "next/link";
import { MessageCircle } from "lucide-react";

import { auth } from "../src/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DawnMark } from "./components/DawnMark";
import { DawnRail } from "./components/DawnRail";

export default async function Home() {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);

  // Google gives a full name; there is no separate first-name field to read.
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];

  const href = signedIn ? "/chat" : "/api/auth/signin?callbackUrl=%2Fonboarding";
  const label = firstName
    ? `Chat With Your Personal Super-Connector, ${firstName}`
    : "Chat with Dawn";

  return (
    <div className="flex h-screen overflow-hidden">
      {/* The greeting takes the top-left corner when it's there, so About drops below it. */}
      <Link
        href="/about"
        style={{ "--dawn-delay": "380ms" } as React.CSSProperties}
        className={cn(
          "dawn-enter fixed left-[26px] z-12 font-serif text-xl tracking-[0.3px]",
          "text-dawn-bone opacity-85 transition-opacity duration-150 hover:opacity-100",
          firstName ? "top-[60px]" : "top-[26px]",
        )}
      >
        About
      </Link>

      {firstName && (
        <div
          style={{ "--dawn-delay": "180ms" } as React.CSSProperties}
          className="dawn-enter fixed top-[22px] left-[26px] z-10 font-serif text-[22px] tracking-[0.3px] text-dawn-bone"
        >
          Hello {firstName}!
        </div>
      )}

      <main className="relative flex flex-1 flex-col items-center justify-center gap-8">
        <h1
          style={{ "--dawn-delay": "240ms" } as React.CSSProperties}
          className="dawn-enter flex items-center gap-4 leading-none text-dawn-bone sm:gap-[22px]"
        >
          <DawnMark idSuffix="home" className="h-12 shrink-0 select-none sm:h-[62px]" />
          <span className="font-serif text-[68px] leading-none tracking-[0.5px] sm:text-[88px]">
            Dawn
          </span>
        </h1>

        <Button
          asChild
          variant="pill"
          size="pill"
          style={{ "--dawn-delay": "380ms" } as React.CSSProperties}
          className="dawn-enter dawn-shimmer max-w-[90vw]"
        >
          <Link href={href}>
            <MessageCircle className="size-[17px] text-muted-foreground" strokeWidth={2} />
            <span className="truncate">{label}</span>
          </Link>
        </Button>

        {!signedIn && (
          <p
            style={{ "--dawn-delay": "480ms" } as React.CSSProperties}
            className="dawn-enter text-muted-foreground max-w-[80vw] text-center text-[13px]"
          >
            Sign in with Google. Dawn reads your Gmail and Calendar metadata — who and
            when, never message content — to build your side of the network.
          </p>
        )}
      </main>

      <DawnRail signedIn={signedIn} />
    </div>
  );
}
