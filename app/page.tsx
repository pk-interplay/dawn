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

import { auth, signIn } from "../src/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DawnMark } from "./components/DawnMark";
import { DawnRail } from "./components/DawnRail";

export default async function Home() {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);

  // Google gives a full name; there is no separate first-name field to read.
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];

  // Starting Google sign-in needs a POST with CSRF through `signIn`, not a GET to
  // /api/auth/signin — which, because pages.signIn is "/", just redirects back to
  // this page and loops. So the signed-out button submits a server action instead
  // of being a link.
  async function startSignIn() {
    "use server";
    await signIn("google", { redirectTo: "/onboarding" });
  }

  // The home screen no longer opens an empty chat — it opens a chat that is already
  // asking something. Four starter questions the graph can actually answer, so the
  // first thing Dawn does is answer rather than sit at a blank prompt.
  const questions = [
    "Who are my most active relationships?",
    "Who do I know at Anthropic?",
    "Who haven't I talked to in a while?",
    "Who could introduce me to someone at Stripe?",
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* The greeting takes the top-right corner when it's there, so About drops below it.
          Both sit on the right now that the rail owns the left edge. */}
      <Link
        href="/about"
        style={{ "--dawn-delay": "380ms" } as React.CSSProperties}
        className={cn(
          "dawn-enter fixed right-[26px] z-12 font-serif text-xl tracking-[0.3px]",
          "text-dawn-bone opacity-85 transition-opacity duration-150 hover:opacity-100",
          firstName ? "top-[60px]" : "top-[26px]",
        )}
      >
        About
      </Link>

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
          {questions.map((question, i) =>
            signedIn ? (
              // Signed in, the question opens the chat already asking it.
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
            ) : (
              // Signed out, any of them starts sign-in first; onboarding comes next.
              <form
                key={question}
                action={startSignIn}
                style={{ "--dawn-delay": `${420 + i * 60}ms` } as React.CSSProperties}
                className="dawn-enter"
              >
                <button
                  type="submit"
                  className={cn(
                    "border-dawn-btn bg-dawn-input group flex h-full w-full items-start gap-3 rounded-2xl border",
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
                </button>
              </form>
            ),
          )}
        </div>

        {!signedIn && (
          <p
            style={{ "--dawn-delay": "480ms" } as React.CSSProperties}
            className="dawn-enter text-muted-foreground max-w-[80vw] text-center text-[13px]"
          >
            Maps your network from who you email and meet — metadata only, never message content.
          </p>
        )}
      </main>

      <DawnRail signedIn={signedIn} />
    </div>
  );
}
