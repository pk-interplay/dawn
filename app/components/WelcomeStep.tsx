"use client";

import { ArrowRight, Mail, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { GeneratedProfile } from "@/lib/member";
import { DAWN_EMAIL } from "@/lib/email";

/**
 * The last screen of onboarding: you're in.
 *
 * Two jobs, in this order of importance:
 *
 * 1. **Say they're in, and reflect back what Dawn heard.** Onboarding used to end on
 *    a Gmail handoff — "draft this email and send it to Dawn" — which left the member
 *    doing admin at the exact moment they should be feeling like they'd joined
 *    something. Their own goals in their own words is the payoff for the chat.
 *
 * 2. **Set the expectations the next three days will test.** A member who doesn't
 *    know intros are coming reads the first one as spam, and one who doesn't know
 *    how to answer replies to nobody. So: how many emails, that consent is asked
 *    before any details are shared, that plain "yes"/"no" works, and how to stop.
 *
 * The pilot disclosure is here too, and deliberately not in fine print. The
 * counterparts are fictional; if a member only finds that out when a calendar
 * invite fails to materialise, the trust that makes the rest of the test
 * meaningful is gone.
 */
export function WelcomeStep({
  profile,
  onDone,
}: {
  profile: GeneratedProfile;
  onDone: () => void;
}) {
  const goals = profile.goals.slice(0, 4);
  const firstName = profile.name.trim().split(/\s+/)[0] || "there";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-10 px-4 py-12">
      <div className="space-y-3 text-center">
        <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-sm">
          <Sparkles className="size-4" /> Dawn
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          You&apos;re in, {firstName}.
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed">
          Dawn knows what you&apos;re working on and who could help. From here it works
          over email — nothing else for you to do.
        </p>
      </div>

      {goals.length > 0 && (
        <div className="space-y-3">
          <p className="text-muted-foreground text-center text-xs tracking-wide uppercase">
            What Dawn is looking for on your behalf
          </p>
          <ul className="space-y-2">
            {goals.map((goal) => (
              <li
                key={goal}
                className="bg-muted/40 rounded-lg px-4 py-3 text-sm leading-relaxed"
              >
                {goal}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-4 text-sm leading-relaxed">
        <div className="flex gap-3">
          <Mail className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <p>
            Over the next few days you&apos;ll get a handful of introductions a day from{" "}
            <span className="font-medium">{DAWN_EMAIL}</span>. Each one says who the
            person is and why Dawn thinks it&apos;s worth your time.
          </p>
        </div>
        <div className="flex gap-3">
          <ArrowRight className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <p>
            Reply <span className="font-medium">yes</span> or{" "}
            <span className="font-medium">no</span> — that&apos;s the whole interface.
            Dawn only shares your details once both of you have said yes, then it
            works out a time. Reply <span className="font-medium">unsubscribe</span> to
            stop, or tell it what you&apos;d rather see and it will remember.
          </p>
        </div>
      </div>

      <p className="text-muted-foreground border-t pt-6 text-xs leading-relaxed">
        <span className="font-medium">About this test:</span> the people Dawn
        introduces you to are fictional, and their replies come from the teammate
        running the pilot. Everything on your side is real — the matching against what
        you just said, the emails, and what you write back. Answer them exactly as you
        would if the person were real; that&apos;s the part we&apos;re trying to learn
        from. Nobody is expecting you to hold a meeting.
      </p>

      <div className="text-center">
        <Button size="lg" onClick={onDone}>
          See my profile <ArrowRight className="size-4" />
        </Button>
      </div>
    </main>
  );
}
