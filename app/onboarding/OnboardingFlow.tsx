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
import { ArrowRight, Loader2, Pencil, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  | { name: "error"; message: string };

const INGEST_LINES = [
  "Reading who you email and meet — metadata only, never message content.",
  "Six months of Gmail and Calendar takes a moment.",
  "Working out what you're known for.",
];

interface StreamedContact {
  name: string;
  email: string;
}

const THIN_REASON: Record<string, string> = {
  not_enough_activity: "There isn't enough recent sent mail yet to say anything real about you.",
  no_api_key: "The profile writer isn't configured on this deployment.",
};
const THIN_REASON_DEFAULT = "Dawn couldn't draft a profile this time.";

export function OnboardingFlow({ firstName }: { firstName: string | null }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ name: "ingesting" });
  const [line, setLine] = useState(0);
  const [busy, setBusy] = useState(false);
  // The optional steer on the review screen: an expander plus its free text.
  const [showGuidance, setShowGuidance] = useState(false);
  const [guidance, setGuidance] = useState("");
  // Correspondents streamed back from the ingest, newest last. Feeds the live ticker.
  const [contacts, setContacts] = useState<StreamedContact[]>([]);
  // StrictMode mounts effects twice in dev. Without this guard the ingest — six months
  // of Gmail and a Sonnet call — runs twice on every local load.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      try {
        const res = await fetch("/api/onboarding/ingest", { method: "POST" });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Sync failed (${res.status})`);
        }

        // The route streams newline-delimited JSON: a "contact" per correspondent as
        // it's found, then a terminal "result" or "error". Read incrementally and hold
        // a buffer for the partial trailing line each chunk leaves behind.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handle = (event: Record<string, unknown>) => {
          if (event.type === "contact") {
            const name = String(event.name ?? "");
            const email = String(event.email ?? "");
            setContacts((prev) => [...prev, { name, email }]);
          } else if (event.type === "error") {
            setStage({ name: "error", message: String(event.error ?? "Something went wrong") });
          } else if (event.type === "result") {
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
      } catch (err) {
        setStage({ name: "error", message: err instanceof Error ? err.message : "Something went wrong" });
      }
    })();
  }, []);

  // Rotate the waiting copy so a long ingest doesn't look stalled.
  useEffect(() => {
    if (stage.name !== "ingesting") return;
    const id = setInterval(() => setLine((n) => (n + 1) % INGEST_LINES.length), 4500);
    return () => clearInterval(id);
  }, [stage.name]);

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
      const res = await fetch("/api/onboarding/confirm", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Confirm failed (${res.status})`);
      setStage({ name: "done" });
      // Long enough to read "You're in the network", short enough not to be a wait.
      setTimeout(() => router.replace("/chat"), 1400);
    } catch (err) {
      setStage({ name: "error", message: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  }, [router]);

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
          <p className="text-muted-foreground mt-6 flex items-center gap-2 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            {INGEST_LINES[line]}
          </p>
          <ContactTicker contacts={contacts} />
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

          <div className="border-dawn-btn bg-card mt-8 space-y-5 rounded-[--radius] border p-6">
            <p className="font-serif text-xl leading-snug tracking-[0.2px] text-dawn-bone">
              {stage.draft.headline}
            </p>
            <p className="text-sm leading-relaxed text-foreground">{stage.draft.bio}</p>
            <PillList label="Expertise" items={stage.draft.expertise} />
            <PillList label="Interests" items={stage.draft.interests} />
            <PillList label="Working toward" items={stage.draft.goals} />
          </div>

          {stage.draft.suggestedIntros.length > 0 && (
            <div className="mt-5">
              <Kicker>Intros Dawn guesses you&rsquo;d want</Kicker>
              <p className="text-muted-foreground mt-2 text-xs">
                Suggestions only — these are not saved, and nothing acts on them.
              </p>
              <ul className="mt-3 space-y-1.5">
                {stage.draft.suggestedIntros.map((s) => (
                  <li key={s} className="text-muted-foreground text-sm">
                    · {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

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

/**
 * A ~4-line window of correspondents streaming in from the ingest, newest at the
 * bottom, older ones scrolling up under a fade. Purely presentational — it renders
 * whatever the stream has handed us so far. Shows only the tail so a 2,000-contact
 * mailbox doesn't mount 2,000 rows; the running count carries the sense of scale.
 */
const TICKER_WINDOW = 4;

function ContactTicker({ contacts }: { contacts: StreamedContact[] }) {
  if (contacts.length === 0) return null;
  const tail = contacts.slice(-TICKER_WINDOW);

  return (
    <div className="mt-6">
      <div
        className="relative h-[5.5rem] overflow-hidden"
        // Fade the top edge so rows dissolve upward as new ones arrive.
        style={{
          maskImage: "linear-gradient(to bottom, transparent, black 38%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent, black 38%)",
        }}
      >
        <ul className="absolute inset-x-0 bottom-0 flex flex-col justify-end gap-1">
          {tail.map((c, i) => (
            // Key by position in the stream so each newly-arrived row remounts and
            // replays its fade-in, while the rows above it stay put.
            <li
              key={`${contacts.length - tail.length + i}-${c.email}`}
              className="dawn-enter flex items-baseline gap-2 text-sm"
            >
              <span className="text-dawn-bone truncate">{c.name || c.email}</span>
              {c.name && c.name !== c.email && (
                <span className="text-muted-foreground truncate text-xs">{c.email}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-dawn-head mt-2 text-[11px] font-medium tracking-[2.4px] uppercase">
        {contacts.length} {contacts.length === 1 ? "person" : "people"} so far
      </p>
    </div>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-dawn-head text-[11px] font-medium tracking-[2.4px] uppercase">{children}</p>
  );
}

function PillList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-dawn-head text-[11px] font-medium tracking-[2.4px] uppercase">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((item) => (
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
