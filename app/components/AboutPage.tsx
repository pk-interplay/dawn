/**
 * The About page, following the pitch at interplay.bot/Dawn/pitch.html: a
 * stated hero, three numbered steps, who it's for, and a closing ask. Copy is
 * taken from the pitch verbatim — including Dawn's voice, which refers to the
 * agent as "she".
 *
 * The layout follows the pitch too. Sections carry no dividers of their own; the
 * only rules on the page are the ones bracketing the numbered steps and the
 * footer. Headings are serif, everything else is sans, and the single pill is
 * the only button treatment — the reference is explicit about wanting no chips
 * or badges in body content, so the page stays as quiet as the home screen.
 *
 * Static, so this stays a server component: the rail is the one client piece.
 */

import Link from "next/link";

import { auth } from "@/src/auth";
import { Button } from "@/components/ui/button";
import { isAdmin } from "@/app/lib/admin-auth";
import { startGoogleSignIn } from "@/app/lib/auth-actions";
import { DawnMark } from "./DawnMark";
import { DawnRail } from "./DawnRail";

// Every CTA on this page is the same action, because there is only one way in.
// It used to read "Join the Waitlist" pointing at /join — there is no waitlist and
// no /join: signing in with Google IS onboarding, and it lands on the ingest flow.
// The action is `startGoogleSignIn` (a POST server action), NOT a link to
// /api/auth/signin — see that file for why a GET there loops back to home.

const STEPS = [
  {
    number: "01",
    title: "Set up your profile.",
    body: "Tell Dawn who you are, what you do, and what you're looking for right now. A job. A check. A hire. A customer. A co-founder. Press. Advice. Anything. The more honest the ask, the better the matches.",
  },
  {
    number: "02",
    title: "Keep Dawn updated.",
    body: "Send her a note whenever your world shifts — you closed the round, you're hiring your first engineer, you just moved cities. Dawn adjusts what she's looking for on your behalf. Your profile stays alive without you rewriting it.",
  },
  {
    number: "03",
    title: "Get vetted intros in your inbox.",
    body: "When Dawn finds someone credible whose goals line up with yours, she emails you both — with context, common ground, and a reason to talk. Every match is screened for fit and legitimacy. Not scraped from a feed. Not paid for by an advertiser. Not a stranger cold-pitching your inbox.",
  },
];

/** 88px of right padding past 900px keeps content clear of the fixed rail. */
const GUTTER = "px-8 max-[820px]:px-5 min-[900px]:pr-[88px]";

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3.5 text-[11px] tracking-[2.4px] text-dawn-head uppercase">{children}</p>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-5 max-w-[780px] font-serif text-[42px] leading-[1.15] font-normal tracking-[0.2px] text-dawn-bone max-[820px]:text-[32px]">
      {children}
    </h2>
  );
}

/** Flush with the canvas and borderless, so the rail reads the same as on home. */
function TopBar() {
  return (
    <header className="sticky top-0 z-15 bg-background">
      <div className={`mx-auto flex max-w-[980px] items-center justify-between py-3.5 ${GUTTER}`}>
        <Link
          href="/"
          className="inline-flex items-center gap-3 font-serif text-[26px] tracking-[0.3px] text-dawn-bone"
        >
          <DawnMark idSuffix="brand" className="h-[26px] shrink-0" />
          Dawn
        </Link>
        <form action={startGoogleSignIn}>
          <Button type="submit" variant="pill" size="pill-sm">
            Continue with Gmail
          </Button>
        </form>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="flex flex-col items-center gap-8 pt-[100px] pb-20 text-center">
      <h1 className="flex items-center gap-6 leading-none text-dawn-bone max-[820px]:gap-4">
        <DawnMark idSuffix="hero" className="h-[72px] shrink-0 max-[820px]:h-[52px]" />
        <span className="font-serif text-[96px] leading-none tracking-[0.5px] max-[820px]:text-[68px]">
          Dawn
        </span>
      </h1>

      <p className="max-w-[720px] font-serif text-[30px] leading-[1.3] tracking-[0.2px] text-dawn-bone italic max-[820px]:text-2xl">
        A Hands-Off Connector. Networking, Democratized.
      </p>

      <p className="max-w-[640px] text-[17px] leading-[1.6] text-muted-foreground">
        Put your professional info in. Dawn sends you vetted, credible connections in return
        — the people you actually need to hire, raise from, sell to, learn from, or partner
        with. No feed to scroll. No cold DMs to send. Just the right introduction, in your
        inbox, when it matters.
      </p>

      <form action={startGoogleSignIn}>
        <Button type="submit" variant="pill" size="pill-lg" className="dawn-shimmer">
          Continue with Gmail
        </Button>
      </form>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="py-16">
      <Kicker>How it works</Kicker>
      <SectionHeading>Three steps. That&apos;s it.</SectionHeading>
      <p className="max-w-[700px] text-[17px] leading-[1.65] text-muted-foreground">
        The best-connected people in the world get warm intros without lifting a finger. Dawn
        gives everyone else the same edge — not by making you work a network, but by working
        one for you.
      </p>

      {/* Rules between the steps are the only dividers on the page. */}
      <div className="mt-10 flex flex-col">
        {STEPS.map((step, i) => (
          <div
            key={step.number}
            className={`grid grid-cols-[80px_1fr] gap-6 border-t border-border py-7 max-[820px]:grid-cols-[60px_1fr] max-[820px]:gap-4 ${
              i === STEPS.length - 1 ? "border-b" : ""
            }`}
          >
            <span className="font-serif text-[40px] leading-none text-muted-foreground max-[820px]:text-3xl">
              {step.number}
            </span>
            <div>
              <h3 className="mb-2.5 font-serif text-[26px] leading-tight font-normal tracking-[0.2px] text-dawn-bone">
                {step.title}
              </h3>
              <p className="max-w-[620px] text-[15.5px] leading-[1.65] text-muted-foreground">
                {step.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WhoItsFor() {
  return (
    <section className="py-16">
      <Kicker>Who it&apos;s for</Kicker>
      <SectionHeading>Anyone, honestly.</SectionHeading>
      <p className="max-w-[700px] text-[17px] leading-[1.65] text-muted-foreground">
        Dawn works for anyone who has ever wished they knew the right person. Founders raising
        a round. Investors sourcing the next deal. Job seekers looking for a warm introduction
        instead of the eighth application. Hiring managers hunting for that hard-to-find
        engineer. Sales teams trying to reach a real decision-maker. Operators scaling into new
        markets. Anyone with something to build, someone to find, or a door they&apos;ve been
        trying to open.
      </p>

      <blockquote className="mt-12 max-w-[780px] rounded-md border-l-2 border-dawn-bone bg-dawn-bone/8 px-10 py-9 font-serif text-2xl leading-[1.4] text-dawn-bone italic max-[820px]:px-6 max-[820px]:py-6 max-[820px]:text-xl">
        If networking is what stands between you and the next thing, Dawn is for you.
      </blockquote>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="py-16">
      <div className="flex flex-col items-center gap-[22px] rounded-[22px] border border-dawn-btn bg-card px-10 py-16 text-center max-[820px]:px-6 max-[820px]:py-10">
        <h2 className="font-serif text-[42px] leading-[1.15] font-normal tracking-[0.2px] text-dawn-bone max-[820px]:text-[32px]">
          The connection you need is one email away.
        </h2>
        <p className="max-w-[620px] text-base leading-relaxed text-muted-foreground">
          Join the waitlist. We&apos;ll send you a set-up link the moment your seat opens.
        </p>
        <form action={startGoogleSignIn}>
          <Button type="submit" variant="pill" size="pill-lg" className="dawn-shimmer">
            Continue with Gmail
          </Button>
        </form>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-20 flex items-center justify-between gap-4 border-t border-border pt-8 pb-5 text-[13px] text-dawn-head max-[820px]:flex-col max-[820px]:items-start">
      <p>© Dawn — built quietly.</p>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-dawn-bone">
          Home
        </Link>
        <span aria-hidden>·</span>
        <form action={startGoogleSignIn} className="inline">
          <button type="submit" className="transition-colors hover:text-dawn-bone">
            Sign In
          </button>
        </form>
      </div>
    </footer>
  );
}

export async function AboutPage() {
  // Server component, so the rail renders in its signed-in state on first paint
  // rather than flashing the signed-out one.
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);
  const admin = signedIn && (await isAdmin());

  return (
    <>
      <TopBar />
      <main className={`mx-auto max-w-[980px] pb-[120px] max-[820px]:pb-20 ${GUTTER}`}>
        <Hero />
        <HowItWorks />
        <WhoItsFor />
        <ClosingCta />
        <SiteFooter />
      </main>
      <DawnRail signedIn={signedIn} isAdmin={admin} />
    </>
  );
}
