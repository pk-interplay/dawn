"use client";

/**
 * Gmail authorize → ingest → review the draft profile → Confirm → you're in.
 *
 * Adapted from nexus's OnboardingScreen, with the step it never had. nexus generated
 * the profile during a spinner and auto-redirected after 900ms — the user never saw
 * what had been written about them, and it was live and network-visible immediately.
 * Here synthesis stages a draft, the draft is shown, and nothing is visible to anyone
 * else until Confirm.
 *
 * Accept-or-regenerate, not free-text editing. That matches what confirmation means:
 * an edited field would be the user's own words and should be written
 * `method: 'self_reported'` at full confidence, which is a different claim with a
 * different provenance and needs its own affordance. Regenerate is the honest escape
 * hatch for "that's not right" until then — and "Add guidance" lets the user steer a
 * regenerate ("I'm a founder, not an investor") without crossing into editing: the
 * text nudges the model's framing, it never becomes a self-reported claim.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Loader2, Pencil, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DawnMark } from "../components/DawnMark";

interface ProfileDraft {
  headline: string;
  bio: string;
  expertise: string[];
  interests: string[];
  goals: string[];
  suggestedIntros: string[];
}

interface IngestSummary {
  entitiesTouched: number;
  edgesWritten: number;
  claimsWritten: number;
  failures: string[];
}

type Stage =
  | { name: "ingesting" }
  | { name: "review"; draft: ProfileDraft; ingest: IngestSummary | null }
  | { name: "thin"; ingest: IngestSummary | null; reason: string }
  | { name: "done" }
  // `partial` is a confirm that wrote the claims but did not finish projecting the
  // member downstream. It is a success for the user's profile and a failure for their
  // visibility, and saying only "you're in the network" would be the wrong half.
  | { name: "partial"; message: string }
  | { name: "error"; message: string };

const THIN_REASON: Record<string, string> = {
  not_enough_activity: "There isn't enough recent sent mail yet to say anything real about you.",
  no_api_key: "The profile writer isn't configured on this deployment.",
  // The ingest ran out of its time budget before synthesis. The graph is written; the
  // profile is the part that did not happen, and Regenerate is the whole fix.
  timeout: "The sync ran long and stopped before writing your profile.",
};
const THIN_REASON_DEFAULT = "Dawn couldn't draft a profile this time.";

/** Room for MAX_ASKS lines at MAX_ASK_LENGTH, without the box becoming a document. */
const MAX_ASKS_CHARS = 1200;

/**
 * How long the ingest may go without saying anything before we call it dead.
 *
 * The route sends a `progress` heartbeat every couple of seconds through every phase,
 * so real silence this long means the connection is gone, not that the work is slow.
 * Generous enough to ride out a single retry-and-backoff inside the Gmail read.
 */
const STALL_TIMEOUT_MS = 45_000;

export function OnboardingFlow({
  firstName,
  initialDraft = null,
}: {
  firstName: string | null;
  /**
   * A draft already staged in `profile_drafts`, read server-side by the page. When
   * present the ingest is skipped entirely and this goes straight to review — the work
   * is already done and re-running it is what used to strand people on the spinner.
   */
  initialDraft?: ProfileDraft | null;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(
    initialDraft ? { name: "review", draft: initialDraft, ingest: null } : { name: "ingesting" },
  );
  const [busy, setBusy] = useState(false);
  // The optional steer on the review screen: an expander plus its free text.
  const [showGuidance, setShowGuidance] = useState(false);
  const [guidance, setGuidance] = useState("");
  // Which setup steps have finished. Email and Calendar run concurrently
  // server-side and may complete in either order; display order is fixed in
  // SetupChecklist below.
  const [stepDone, setStepDone] = useState({ email: false, calendar: false });
  // Expertise/interests/goals the user dismissed, lowercased. Never written as claims.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // The asks box. Seeded from the model's suggestions, then it's the user's text.
  const [asks, setAsks] = useState("");
  // Seed once per draft — a regenerate reseeds, but typing must never be overwritten.
  const seededFor = useRef<string | null>(null);

  const hide = useCallback((item: string) => {
    setHidden((prev) => new Set(prev).add(item.toLowerCase()));
  }, []);
  const unhideAll = useCallback(() => setHidden(new Set()), []);
  // StrictMode mounts effects twice in dev. Without this guard the ingest — a
  // Gmail read and a Sonnet call — runs twice on every local load.
  const started = useRef(false);

  useEffect(() => {
    // A draft was already staged and the page handed it to us. Nothing to ingest.
    if (initialDraft) return;
    if (started.current) return;
    started.current = true;

    // Aborts the request when the stream goes quiet for STALL_TIMEOUT_MS. Without this a
    // connection that is open but dead — the far side gone, nothing arriving — holds the
    // spinner indefinitely, because `reader.read()` simply never resolves.
    const controller = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, STALL_TIMEOUT_MS);
    };

    (async () => {
      // Whether a terminal `result`/`error` event ever arrived. The whole point: the
      // stream closing is NOT the same thing as the work finishing, and treating the two
      // as equivalent is what left people watching a spinner for half an hour after the
      // serverless function behind it had already been killed.
      let terminal = false;

      try {
        armStallTimer();
        const res = await fetch("/api/onboarding/ingest", {
          method: "POST",
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Sync failed (${res.status})`);
        }

        // The route streams newline-delimited JSON: "progress" heartbeats throughout,
        // a "step" when the calendar leg lands, then a terminal "result" or "error".
        // It also still emits "contact"/"evidence"/"draft_partial" for older clients;
        // those fall through `handle` unrendered — the checklist is the whole show.
        // Read incrementally and hold a buffer for the partial trailing line each
        // chunk leaves behind.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handle = (event: Record<string, unknown>) => {
          if (event.type === "progress") {
            const phase = String(event.phase ?? "");
            // The route's Promise.all guarantees ordering the events alone can't:
            // reaching "writing" proves the calendar leg finished, and reaching
            // "synthesizing" proves the whole Email leg (read + graph write) did.
            // So the checklist works even if the `step` event never arrives.
            if (phase === "writing")
              setStepDone((s) => (s.calendar ? s : { ...s, calendar: true }));
            if (phase === "synthesizing") setStepDone({ email: true, calendar: true });
          } else if (event.type === "step") {
            const step = String(event.step ?? "");
            if (step === "email" || step === "calendar")
              setStepDone((s) => ({ ...s, [step]: true }));
          } else if (event.type === "error") {
            terminal = true;
            setStage({ name: "error", message: String(event.error ?? "Something went wrong") });
          } else if (event.type === "result") {
            terminal = true;
            if (event.draft) {
              setStage({
                name: "review",
                draft: event.draft as ProfileDraft,
                ingest: (event.ingest as IngestSummary) ?? null,
              });
            } else {
              setStage({
                name: "thin",
                ingest: (event.ingest as IngestSummary) ?? null,
                reason: THIN_REASON[String(event.reason)] ?? THIN_REASON_DEFAULT,
              });
            }
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armStallTimer();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const raw of lines) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            try {
              handle(JSON.parse(trimmed));
            } catch {
              // A malformed line is not worth aborting a live ingest over; skip it.
            }
          }
        }

        // The stream ended without ever saying how it went. The server was killed
        // mid-flight, or something between here and it dropped the connection. The graph
        // write is incremental, so their network may well be partly synced — which is
        // why this offers going on as well as trying again, and does not claim to know
        // that nothing happened.
        if (!terminal) {
          setStage({
            name: "error",
            message:
              "The sync stopped before it finished. Your network may be partly synced — " +
              "try again, or continue and finish setting up later.",
          });
        }
      } catch (err) {
        if (!terminal) {
          setStage({
            name: "error",
            message: stalled
              ? "The sync stopped responding. Try again, or continue and finish setting up later."
              : err instanceof Error
                ? err.message
                : "Something went wrong",
          });
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    })();

    return () => {
      if (stallTimer) clearTimeout(stallTimer);
    };
  }, [initialDraft]);

  // Seed the asks box from the model's guesses, once per draft. Keyed on the draft's
  // own suggestions so a regenerate reseeds, while a re-render never clobbers typing.
  useEffect(() => {
    if (stage.name !== "review") return;
    const key = stage.draft.suggestedIntros.join(" ");
    if (seededFor.current === key) return;
    seededFor.current = key;
    setAsks(stage.draft.suggestedIntros.join("\n"));
  }, [stage]);

  const regenerate = useCallback(async (steer?: string) => {
    const guidanceText = steer?.trim() ?? "";
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/synthesize", {
        method: "POST",
        headers: guidanceText ? { "Content-Type": "application/json" } : undefined,
        body: guidanceText ? JSON.stringify({ guidance: guidanceText }) : undefined,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Regenerate failed (${res.status})`);
      if (body.draft) {
        setStage((prev) => ({
          name: "review",
          draft: body.draft,
          ingest: prev.name === "review" ? prev.ingest : null,
        }));
      } else {
        // Synthesis succeeded at doing nothing — usually still not enough signal. Without
        // this the button just flickers and the screen is unchanged, which reads as broken
        // rather than as an answer.
        setStage((prev) => ({
          name: "thin",
          ingest: prev.name === "thin" || prev.name === "review" ? prev.ingest : null,
          reason: THIN_REASON[String(body.reason)] ?? THIN_REASON_DEFAULT,
        }));
      }
    } catch (err) {
      setStage({ name: "error", message: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  }, []);

  const confirm = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `hidden` only ever subtracts from the staged draft, and `asks` is the user's
        // own text — neither can author a claim. See the route header.
        body: JSON.stringify({ hidden: [...hidden], asks }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Confirm failed (${res.status})`);

      // The route reports two things that can fail without failing the request, and both
      // used to be dropped on the floor here: `embedded: false` means the downstream
      // projection did not complete, so this member has no embedding and the matching
      // cron cannot see them; `claimsFailed` means part of the profile did not write.
      // Telling someone "you're in the network" in either case is not true enough.
      const claimsFailed = Number(body.claimsFailed ?? 0);
      if (body.embedded === false || claimsFailed > 0) {
        setStage({
          name: "partial",
          message:
            body.embedded === false
              ? "Your profile is saved, but Dawn couldn't finish setting you up for matching. " +
                "You're in — this just needs another pass before you'll show up to others."
              : `Your profile is saved, but ${claimsFailed} ${claimsFailed === 1 ? "detail" : "details"} didn't write.`,
        });
        return;
      }

      setStage({ name: "done" });
      // Long enough to read "You're in the network", short enough not to be a wait.
      setTimeout(() => router.replace("/chat"), 1400);
    } catch (err) {
      setStage({ name: "error", message: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  }, [router, hidden, asks]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-16">
      <div className="dawn-enter mb-10 flex items-center gap-3 text-dawn-bone">
        <DawnMark idSuffix="onboarding" className="h-7 shrink-0 select-none" />
        <span className="font-serif text-[28px] leading-none tracking-[0.3px]">Dawn</span>
      </div>

      {stage.name === "ingesting" && (
        <div className="dawn-enter">
          <Kicker>Setting up</Kicker>
          <h1 className="mt-3 font-serif text-[34px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
            {firstName ? `One moment, ${firstName}.` : "One moment."}
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">This only happens once.</p>
          <SetupChecklist email={stepDone.email} calendar={stepDone.calendar} />
        </div>
      )}

      {stage.name === "review" && (
        <div className="dawn-enter">
          <Kicker>Your profile</Kicker>
          <h1 className="mt-3 font-serif text-[34px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
            Here&rsquo;s what Dawn made of you.
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">
            Written from your Gmail and Calendar metadata — who you email and meet, and
            what your subject lines are about. Never the contents of a message. This is
            the only thing about you other people in the network can see, and nobody can
            see it until you confirm.
          </p>

          {/* Above the profile, because this is the one part the user actually writes —
              and the answer Dawn acts on. The profile below it is Dawn's account of
              them; this is theirs. */}
          <div className="mt-8">
            <Kicker>What kinds of intros do you want?</Kicker>
            <p className="text-muted-foreground mt-2 text-xs">
              Dawn guessed from your network — edit freely, one per line. This is saved
              in your words, and it&rsquo;s what Dawn looks for on your behalf.
            </p>
            <textarea
              value={asks}
              onChange={(e) => setAsks(e.target.value)}
              disabled={busy}
              rows={5}
              maxLength={MAX_ASKS_CHARS}
              placeholder="e.g. Seed-stage fintech founders raising now&#10;Operators who've scaled a support team past 50"
              className="border-dawn-btn bg-card text-foreground placeholder:text-muted-foreground focus-visible:ring-ring mt-3 w-full resize-none rounded-[--radius] border p-3 text-sm leading-relaxed outline-none focus-visible:ring-2"
            />
          </div>

          <div className="border-dawn-btn bg-card mt-6 space-y-5 rounded-[--radius] border p-6">
            <p className="font-serif text-xl leading-snug tracking-[0.2px] text-dawn-bone">
              {stage.draft.headline}
            </p>
            <p className="text-sm leading-relaxed text-foreground">{stage.draft.bio}</p>
            <PillList
              label="Expertise"
              items={stage.draft.expertise}
              hidden={hidden}
              onHide={hide}
            />
            <PillList
              label="Interests"
              items={stage.draft.interests}
              hidden={hidden}
              onHide={hide}
            />
            <PillList
              label="Working toward"
              items={stage.draft.goals}
              hidden={hidden}
              onHide={hide}
            />
            {hidden.size > 0 && (
              <p className="text-muted-foreground text-xs">
                {hidden.size} removed — {""}
                <button
                  type="button"
                  onClick={unhideAll}
                  className="hover:text-dawn-bone underline underline-offset-2"
                >
                  undo
                </button>
              </p>
            )}
          </div>

          {stage.ingest && (
            <p className="text-muted-foreground mt-6 text-xs">
              {stage.ingest.entitiesTouched} people and {stage.ingest.edgesWritten}{" "}
              relationships added to the network.
            </p>
          )}

          {showGuidance && (
            <div className="mt-6">
              <Kicker>Steer the rewrite</Kicker>
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                disabled={busy}
                rows={2}
                maxLength={500}
                autoFocus
                placeholder="Optional — tell Dawn what to change. e.g. “I'm a founder, not an investor” or “lead with my climate work”."
                className="border-dawn-btn bg-card text-foreground placeholder:text-muted-foreground focus-visible:ring-ring mt-2 w-full resize-none rounded-[--radius] border p-3 text-sm leading-relaxed outline-none focus-visible:ring-2"
              />
            </div>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button variant="pill" size="pill" disabled={busy} onClick={confirm} className="dawn-shimmer">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
              Confirm and join the network
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => regenerate(guidance)}>
              <RefreshCw className="size-3.5" />
              {guidance.trim() ? "Regenerate with guidance" : "Regenerate"}
            </Button>
            {!showGuidance && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setShowGuidance(true)}>
                <Pencil className="size-3.5" />
                Add guidance
              </Button>
            )}
          </div>
        </div>
      )}

      {stage.name === "thin" && (
        <div className="dawn-enter">
          <Kicker>Almost there</Kicker>
          <h1 className="mt-3 font-serif text-[34px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
            You&rsquo;re in, without a profile.
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">{stage.reason}</p>
          {stage.ingest && (
            <p className="text-muted-foreground mt-4 text-sm">
              Your network still synced — {stage.ingest.entitiesTouched} people and{" "}
              {stage.ingest.edgesWritten} relationships. You can search it now, and write
              a profile once there&rsquo;s more to go on.
            </p>
          )}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button variant="pill" size="pill" asChild className="dawn-shimmer">
              <a href="/chat">
                <ArrowRight className="size-4" />
                Go to the chat
              </a>
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => regenerate()}>
              <RefreshCw className="size-3.5" />
              Try again
            </Button>
          </div>
        </div>
      )}

      {stage.name === "done" && (
        <div className="dawn-enter">
          <Kicker>Done</Kicker>
          <h1 className="mt-3 font-serif text-[34px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
            You&rsquo;re in the network.
          </h1>
          <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            Opening the chat…
          </p>
          {/* The redirect is a single setTimeout with no retry. If that navigation fails
              this is otherwise another terminal spinner, so leave a way through by hand. */}
          <p className="text-muted-foreground mt-4 text-xs">
            <a href="/chat" className="hover:text-dawn-bone underline underline-offset-2">
              Open the chat
            </a>
          </p>
        </div>
      )}

      {stage.name === "partial" && (
        <div className="dawn-enter">
          <Kicker>Almost there</Kicker>
          <h1 className="mt-3 font-serif text-[34px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
            You&rsquo;re in, with one thing outstanding.
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">{stage.message}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button variant="pill" size="pill" asChild className="dawn-shimmer">
              <a href="/chat">
                <ArrowRight className="size-4" />
                Go to the chat
              </a>
            </Button>
          </div>
        </div>
      )}

      {stage.name === "error" && (
        <div className="dawn-enter">
          <Kicker>Something went wrong</Kicker>
          <h1 className="mt-3 font-serif text-[34px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
            That didn&rsquo;t work.
          </h1>
          <p className="text-destructive mt-3 text-sm">{stage.message}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button variant="pill" size="pill" onClick={() => window.location.reload()}>
              Try again
            </Button>
            {/* An error here does not mean the ingest failed — it may well have
                succeeded before synthesis broke — so going on is a real option. */}
            <Button variant="ghost" size="sm" asChild>
              <a href="/chat">Continue anyway</a>
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-dawn-head text-[11px] font-medium tracking-[2.4px] uppercase">{children}</p>
  );
}

/**
 * The three things setup does. Email and Calendar tick independently — they run
 * concurrently server-side and can finish in either order — and Profile setup
 * starts once both are in. A checkmark answers "how much of this is left"
 * without promising a duration nobody can predict: the mailbox read is paced
 * against a quota and genuinely does not know when it will finish.
 */
function SetupChecklist({ email, calendar }: { email: boolean; calendar: boolean }) {
  const items = [
    { label: "Email", state: email ? "done" : "active" },
    { label: "Calendar", state: calendar ? "done" : "active" },
    { label: "Profile setup", state: email && calendar ? "active" : "todo" },
  ] as const;

  return (
    <ol className="mt-6 space-y-2">
      {items.map(({ label, state }) => (
        <li
          key={label}
          className={cn(
            "text-muted-foreground flex items-center gap-2.5 text-sm transition-opacity duration-500",
            state === "todo" && "opacity-35",
          )}
        >
          {state === "done" ? (
            <Check className="size-3.5 shrink-0 opacity-60" strokeWidth={2.5} />
          ) : state === "active" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin opacity-70" strokeWidth={2.5} />
          ) : (
            <span aria-hidden className="bg-muted-foreground size-1.5 shrink-0 rounded-full" />
          )}
          <span className={cn(state === "active" && "dawn-working text-dawn-bone")}>
            {label}
            {state === "active" && "…"}
          </span>
        </li>
      ))}
    </ol>
  );
}


/**
 * `onHide` is what separates the review screen from the streaming preview: with it,
 * each pill becomes a button that removes itself, and a removed item is filtered out
 * before Confirm ever sends it. Without it the list is inert, which is what a
 * half-written draft should be.
 */
function PillList({
  label,
  items,
  hidden,
  onHide,
}: {
  label: string;
  items: string[];
  hidden?: Set<string>;
  onHide?: (item: string) => void;
}) {
  const visible = hidden ? items.filter((i) => !hidden.has(i.toLowerCase())) : items;
  if (!visible.length) return null;

  if (onHide) {
    return (
      <div>
        <p className="text-dawn-head text-[11px] font-medium tracking-[2.4px] uppercase">
          {label}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {visible.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onHide(item)}
              title="Remove — this won't be saved to your profile"
              className="bg-muted text-muted-foreground hover:border-muted-foreground/40 hover:text-dawn-bone group flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-xs transition-colors"
            >
              {item}
              <X className="size-3 opacity-40 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-dawn-head text-[11px] font-medium tracking-[2.4px] uppercase">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {visible.map((item) => (
          <span
            key={item}
            className="bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
