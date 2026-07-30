"use client";

import { motion } from "motion/react";
import type { ReplyIntentView, Step } from "./types";
import { DecisionBadge, timeAgo } from "../monitor/shared";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function Avatar({ label, dawn }: { label: string; dawn: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        "grid size-7 shrink-0 place-items-center rounded-full border text-[10px] font-medium",
        dawn ? "border-foreground/25 bg-foreground text-background" : "border-border bg-secondary text-secondary-foreground",
      ].join(" ")}
    >
      {label}
    </span>
  );
}

/**
 * What Dawn took from a reply. This is the half of the exchange an email client
 * can't show you: the same message as a set of fields the state machine can act
 * on. Empty and absent fields are dropped rather than rendered as "—", so the
 * panel only ever claims what was actually extracted.
 */
function IntentPanel({ intent, decision }: { intent: ReplyIntentView; decision: string | null }) {
  const rows: Array<[string, string]> = [];

  if (intent.opted_in) rows.push(["opted in", intent.opted_in]);
  if (intent.chosen_time) rows.push(["chose", intent.chosen_time]);
  if (intent.proposed_times?.length) rows.push(["proposed", intent.proposed_times.join(" · ")]);
  if (intent.decline_reason) rows.push(["because", intent.decline_reason]);
  if (intent.requests_pause) rows.push(["asked to pause", "yes"]);
  if (intent.off_topic) rows.push(["off topic", "yes"]);

  const signals = intent.preference_signals ?? [];

  return (
    <div className="border-border/60 bg-muted/40 mt-3 rounded-md border border-dashed p-3">
      <p className="text-muted-foreground mb-2 text-[10px] tracking-wide uppercase">
        What Dawn read from this
      </p>

      {intent.summary && <p className="mb-2 text-xs italic">“{intent.summary}”</p>}

      <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      {signals.length > 0 && (
        <div className="mt-2">
          <p className="text-muted-foreground mb-1 text-xs">
            Learned for future matching
            <span className="ml-1 font-normal">— applies beyond this introduction</span>
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {signals.map((s, i) => (
              <li
                key={`${s.kind}-${i}`}
                className="border-border/60 bg-background rounded-md border px-2 py-0.5 text-xs"
              >
                <span className="text-muted-foreground">{s.kind}</span> {s.value}
                <span className="text-muted-foreground"> · {Math.round(s.confidence * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {decision && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Triaged as</span>
          <DecisionBadge decision={decision} />
        </div>
      )}
    </div>
  );
}

/**
 * One email, rendered the way a mail client would — sender, recipients, subject,
 * body — with the extracted intent hanging off the bottom of inbound replies.
 *
 * `active` is the email the playhead is on. Earlier emails stay on screen but
 * recede, so the thread reads as history rather than as six competing cards.
 */
export default function EmailCard({
  step,
  active,
  caption,
}: {
  step: Step;
  active: boolean;
  caption: string;
}) {
  const fromDawn = step.speaker.role === "dawn";
  // Inbound webhook payloads don't record a recipient list, but there is only one
  // place a reply can have arrived: Dawn's inbox. Naming it beats rendering "to —".
  const to =
    step.recipients.map((r) => r.name ?? r.email).join(", ") || (fromDawn ? "—" : "Dawn");

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: active ? 1 : 0.55, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      aria-current={active ? "true" : undefined}
      className={[
        "rounded-lg border p-4",
        active ? "border-foreground/30 bg-card shadow-sm" : "border-border/60 bg-card/40",
        fromDawn ? "" : "sm:ml-6",
      ].join(" ")}
    >
      <header className="flex items-start gap-2.5">
        <Avatar label={fromDawn ? "D" : initials(step.speaker.name)} dawn={fromDawn} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium">{step.speaker.name}</span>
            <span className="text-muted-foreground text-xs">to {to}</span>
            <span className="text-muted-foreground ml-auto text-xs">{timeAgo(step.createdAt)}</span>
          </div>
          {step.speaker.email && (
            <p className="text-muted-foreground truncate text-xs">{step.speaker.email}</p>
          )}
        </div>
      </header>

      {step.speaker.viaOperator && (
        // Pilot reality worth stating out loud: the operator answers as every
        // persona from one mailbox, and triage attributed this reply by thread.
        <p className="text-muted-foreground mt-2 text-xs">
          Sent from {step.speaker.email} · attributed to {step.speaker.name} by thread
        </p>
      )}

      {step.subject && <p className="mt-3 text-sm font-medium">{step.subject}</p>}

      <p className="mt-1.5 text-sm whitespace-pre-wrap">
        {step.body?.trim() || <span className="text-muted-foreground">(empty body)</span>}
      </p>

      {step.intent && <IntentPanel intent={step.intent} decision={step.triage?.decision ?? null} />}

      {active && <p className="text-muted-foreground mt-3 text-xs">{caption}</p>}
    </motion.article>
  );
}
