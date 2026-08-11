/**
 * Dawn's front door, which is two different screens depending on who is at it.
 *
 * Signed out, `/` IS the pitch: the page that used to live at /about renders here,
 * because a visitor who has never seen Dawn needs the explanation and the sign-in
 * CTA, not a locked viewport with one button. /about itself is hidden for now — it
 * redirects here, and the links to it are gone (see app/about/page.tsx).
 *
 * Signed in, `/` stays the reference build's /Dawn/ home: a locked viewport holding
 * the wordmark lockup, a greeting, and four starter questions that each open a chat
 * already asking something. Onboarding is not a third case — `/chat` sends anyone who
 * hasn't finished it to `/onboarding` itself, so nothing here has to know.
 *
 * A server component on purpose. Reading the session here means the right screen and
 * the correct rail render on the first paint; `useSession()` in the client would flash
 * the signed-out state on every load, on the one screen where that is most visible.
 */

import Link from "next/link";
import { MessageCircle } from "lucide-react";

import { auth } from "../src/auth";
import { cn } from "@/lib/utils";
import { isAdmin } from "./lib/admin-auth";
import { AboutPage } from "./components/AboutPage";
import { DawnMark } from "./components/DawnMark";
import { DawnRail } from "./components/DawnRail";

export default async function Home() {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);

  // Unauthenticated landing experience: the pitch, in full. AboutPage reads the
  // session and renders its own rail, so there is nothing to thread through.
  if (!signedIn) return <AboutPage />;

  // Gates the Admin rail tab (see DawnRail).
  const admin = await isAdmin();

  // Google gives a full name; there is no separate first-name field to read.
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];

  // The home screen no longer opens an empty chat — it opens a chat that is already
  // asking something. Four starter questions the graph can actually answer, so the
  // first thing Dawn does is answer rather than sit at a blank prompt. Each one is
  // about *your* network, which is why this screen is the signed-in one.
  const questions = [
    "Who are my most active relationships?",
    "Who do I know at Anthropic?",
    "Who haven't I talked to in a while?",
    "Who could introduce me to someone at Stripe?",
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* The corner About link is hidden along with /about; the greeting now has the
          top-right corner to itself. */}
      {firstName && (
        <div
          style={{ "--dawn-delay": "180ms" } as React.CSSProperties}
          className="dawn-enter fixed top-[22px] right-[26px] z-10 font-serif text-[22px] tracking-[0.3px] text-dawn-bone"
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

        <div
          style={{ "--dawn-delay": "380ms" } as React.CSSProperties}
          className="dawn-enter grid w-full max-w-[560px] grid-cols-2 gap-3 px-6"
        >
          {questions.map((question, i) => (
            // Each question opens the chat already asking it.
            <Link
              key={question}
              href={`/chat?q=${encodeURIComponent(question)}`}
              style={{ "--dawn-delay": `${420 + i * 60}ms` } as React.CSSProperties}
              className={cn(
                "dawn-enter border-dawn-btn bg-dawn-input group flex items-start gap-3 rounded-2xl border",
                "px-4 py-3.5 text-left transition-colors hover:border-muted-foreground/40",
              )}
            >
              <MessageCircle
                className="text-muted-foreground group-hover:text-dawn-bone mt-0.5 size-[17px] shrink-0 transition-colors"
                strokeWidth={2}
              />
              <span className="text-muted-foreground group-hover:text-dawn-bone text-sm leading-snug transition-colors">
                {question}
              </span>
            </Link>
          ))}
        </div>
      </main>

      <DawnRail signedIn isAdmin={admin} />
    </div>
  );
}
