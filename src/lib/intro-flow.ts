import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, textOf } from "./anthropic";
import type { MatchDirection, Person } from "./types";
import { MEETING_FORMATS, type MeetingFormat } from "../../lib/onboarding";
// Every send in this file goes through the gateway, which owns suppression, consent,
// rate limiting, the idempotency ledger, and the delivery switch (SPEC §3.2). This
// module used to import the transport directly; it no longer can, and CI enforces that.
// Imported under an alias because `send` is already a local variable name at three of
// the call sites below.
import {
  AGENTMAIL_INBOX_ID,
  send as sendViaGateway,
  type SendResult,
} from "./send-gateway";

// Orchestrates the double opt-in introduction lifecycle on top of a `matches`
// suggestion: create the introduction + conversation, email an opt-in, ingest
// replies, and once both sides are in, coordinate a time — recording the result
// as a durable `relationship` with proximity signal. Designed to be called from
// the cron routes (Node) so it reuses the app's Anthropic/Supabase clients.

const MODEL = "claude-opus-4-8";

// Single-sided testing mode auto-opts-in person B so the flow can reach scheduling
// with one real inbox. It must be opted INTO: the previous `!== "false"` default
// meant forgetting the variable silently marked a real human as having consented to
// an introduction nobody had asked them about.
export function isSingleSided(): boolean {
  return process.env.INTRO_TEST_SINGLE_SIDED === "true";
}

// Every Dawn-initiated email has to say how to stop it. `people.paused` and the
// `pause` triage decision handle the request, but nothing told recipients the word
// to use — so the only discoverable way to opt out was to ignore Dawn and hope.
const UNSUBSCRIBE_LINE = `\n\n—\nReply "unsubscribe" and I'll stop sending you introductions.`;

function withUnsubscribe(body: string): string {
  return body.includes("unsubscribe") ? body : body + UNSUBSCRIBE_LINE;
}

function nowIso() {
  return new Date().toISOString();
}

// ---- Nudge cadence ----------------------------------------------------------
// Silence is the majority outcome of a first ask, so it gets a real sequence rather
// than a single seven-day timeout. Two follow-ups, then the intro dies quietly — the
// side that DID say yes is deliberately not told it fell through, because a "this
// didn't work out" email is one more message about a person they never met.
//
// Three total emails per person per introduction is the ceiling this implies, and
// that ceiling is the point: a matchmaker that chases harder than that reads as a
// mailing list, and AgentMail's sending reputation is a shared, network-wide asset.
export const NUDGE_FIRST_DELAY_DAYS = 3;
export const NUDGE_REPEAT_DELAY_DAYS = 4;
export const MAX_NUDGES = 2;

/** An ISO timestamp `days` from now, for `introductions.next_action_at`. */
export function dueInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

// Supabase writes return `{ error }` instead of throwing, and most of the writes
// below used to discard it. That is how the `intros` insert failed on every single
// introduction without anyone noticing (RLS was enabled with no policies — see
// migration 0013), quietly disabling the frequency cap. State-tracking writes now
// at least leave a trace; the rate-limit write throws (see startIntroduction).
function warnOnError(op: string, error: { message: string } | null) {
  if (error) console.error(`[intro-flow] ${op} failed: ${error.message}`);
}

// ---- Person subset used in prompts / participant records --------------------

export interface Party {
  id: string;
  name: string;
  email: string | null;
  headline: string | null;
  timezone: string | null;
  /** Only used to decide whether an in-person meeting is worth proposing. */
  location: string | null;
}

export function toParty(p: Person): Party {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    headline: p.headline,
    timezone: p.timezone,
    location: p.location ?? null,
  };
}

// ---- Email drafting (Claude, forced-tool; deterministic fallback) -----------

const DRAFT_EMAIL_TOOL: Anthropic.Messages.Tool = {
  name: "draft_email",
  description: "Return the finished email Dawn will send.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "A short, specific subject line." },
      body: { type: "string", description: "The full plain-text email body, signed off as Dawn." },
    },
    required: ["subject", "body"],
  },
};

async function draftEmail(system: string, user: string): Promise<{ subject: string; body: string } | null> {
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      system,
      tools: [DRAFT_EMAIL_TOOL],
      tool_choice: { type: "tool", name: "draft_email" },
      messages: [{ role: "user", content: user }],
    });
    const tool = resp.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "draft_email",
    );
    if (!tool) return null;
    const { subject, body } = tool.input as { subject: string; body: string };
    return { subject, body };
  } catch {
    return null;
  }
}

export async function draftOptInEmail(helped: Party, suggested: Party, rationale: string) {
  const drafted = await draftEmail(
    `You are Dawn, a warm, concise professional-networking agent. You write short, natural plain-text emails. No markdown, no placeholders like "[Name]" — ready to send as-is.`,
    `Draft a double opt-in introduction email to ${helped.name}. You want to introduce them to ${suggested.name}` +
      `${suggested.headline ? ` (${suggested.headline})` : ""}. Reason this is a strong match: ${rationale}. ` +
      `Explain the value briefly and ask if they'd be open to the intro — tell them to just reply "yes" and you'll introduce them once the other person is in. Sign off as Dawn.`,
  );
  if (drafted) return drafted;
  return {
    subject: `An intro idea for you — ${suggested.name}`,
    body:
      `Hi ${helped.name},\n\n` +
      `I came across ${suggested.name}${suggested.headline ? ` (${suggested.headline})` : ""} and think you two should meet. ` +
      `${rationale}\n\n` +
      `Would you be open to an introduction? Just reply "yes" and I'll check they're up for it too, then put you in touch.\n\n— Dawn`,
  };
}

/**
 * The second half of double opt-in: person A has said yes, now ask person B.
 *
 * Framed differently from A's invite on purpose. B did not ask for anything and may
 * never have heard of Dawn, so the email has to establish who's asking, that A has
 * already agreed, and what's in it for B — without implying B has committed to
 * anything. This email did not exist before: B was auto-opted-in and never contacted.
 */
export async function draftSecondSideOptInEmail(helped: Party, suggested: Party, rationale: string) {
  const drafted = await draftEmail(
    `You are Dawn, a warm, concise professional-networking agent. You write short, natural plain-text emails. No markdown, no placeholders like "[Name]" — ready to send as-is.`,
    `Draft an introduction request to ${suggested.name}, who has NOT heard from you before in this thread. ` +
      `${helped.name}${helped.headline ? ` (${helped.headline})` : ""} has already said they would like to meet them. ` +
      `Reason the two are a strong match: ${rationale}. ` +
      `Briefly introduce yourself as an agent that makes introductions, say who wants to meet them and why it could be worth their time, ` +
      `and make clear nothing is scheduled and they are free to decline. Ask them to reply "yes" if they're open to it and you'll introduce the two of them by email. Sign off as Dawn.`,
  );
  if (drafted) return drafted;
  return {
    subject: `${helped.name} would like to meet you`,
    body:
      `Hi ${suggested.name},\n\n` +
      `I'm Dawn — I make introductions between people who should know each other. ` +
      `${helped.name}${helped.headline ? ` (${helped.headline})` : ""} would like to meet you. ` +
      `${rationale}\n\n` +
      `Nothing is scheduled and there's no obligation. If you're open to it, just reply "yes" and I'll introduce you both by email — you can take it from there.\n\n— Dawn`,
  };
}

/**
 * The formats this person said they'd accept, as the fixed `MEETING_FORMATS`
 * values. Empty for anyone who onboarded before the format question existed, or
 * who skipped it — which the caller reads as "no opinion", not "refuses everything".
 */
async function fetchMeetingFormats(
  client: SupabaseClient,
  personId: string,
): Promise<Set<string>> {
  const { data, error } = await client
    .from("person_preferences")
    .select("value")
    .eq("person_id", personId)
    .eq("kind", "format")
    .eq("active", true);
  warnOnError("person_preferences format read", error);
  return new Set((data ?? []).map((r) => r.value as string));
}

/**
 * What Dawn should propose, given what both people said they'd accept.
 *
 * Only an overlap counts. One person wanting coffee is not a reason to propose it
 * to someone who asked for async email — and where there's no overlap at all (or
 * nobody has answered) the honest move is to fall back to times, which is what
 * every intro did before this existed.
 */
function sharedFormats(a: Set<string>, b: Set<string>): MeetingFormat[] {
  // MEETING_FORMATS is ordered by how much of a commitment each one is, so this
  // comes back warmest-first: propose the biggest thing they've BOTH agreed to
  // rather than defaulting to the most cautious.
  return MEETING_FORMATS.filter((format) => a.has(format) && b.has(format));
}

/**
 * `people.location` is free text, so this is a deliberately conservative check —
 * it only says yes when both sides wrote the same thing.
 *
 * The exclusion list matters more than the comparison. "Remote" is the common
 * value for someone with no fixed city, and two people who both wrote it are the
 * *least* likely pair to share a neighbourhood — matching on it would invite two
 * strangers on different continents out for coffee. A false negative here just
 * means Dawn proposes a call, which is the behaviour we had anyway.
 */
const NOT_A_PLACE = new Set(["remote", "anywhere", "distributed", "global", "n/a", "unknown"]);

function inSameCity(a: string | null, b: string | null): boolean {
  const left = a?.trim().toLowerCase();
  const right = b?.trim().toLowerCase();
  if (!left || !right) return false;
  if (NOT_A_PLACE.has(left) || NOT_A_PLACE.has(right)) return false;
  return left === right;
}

/**
 * The email the whole product exists to send: both sides said yes, so name each of
 * them to the other, say why they should meet, and hand the thread over.
 *
 * This replaces the scheduling email that used to sit here. The difference is not
 * cosmetic — the old email proposed three specific times and kept Dawn in the middle
 * until something was booked, which made Dawn a standing dependency on every
 * relationship it created and meant a meeting only happened if Dawn's calendar
 * wrangling worked. A matchmaker's job is the handoff.
 *
 * The meeting-format preferences are still read, because they change what to suggest
 * even when Dawn isn't the one arranging it: two people who both asked to start over
 * email should not be told to grab coffee. Dawn suggests a shape and stops; the two
 * of them settle the details.
 */
async function draftWarmIntroEmail(
  client: SupabaseClient,
  helped: Party,
  suggested: Party,
  rationale: string,
) {
  const tzNote = [helped.timezone, suggested.timezone].filter(Boolean).join(" and ") || "their timezones";

  const [helpedFormats, suggestedFormats] = await Promise.all([
    fetchMeetingFormats(client, helped.id),
    fetchMeetingFormats(client, suggested.id),
  ]);
  const sameCity = inSameCity(helped.location, suggested.location);

  // Coffee is the one format that needs a second fact to be sensible: two people
  // who both like coffee but live apart still need a call. When that's the case the
  // answer isn't the generic fallback — it's the next thing they both agreed to,
  // which for most people is a video call they already ticked.
  const shared = sharedFormats(helpedFormats, suggestedFormats);
  const format =
    shared[0] === "in_person_coffee" && !sameCity ? (shared[1] ?? null) : (shared[0] ?? null);

  // What to suggest they do — a suggestion only. Dawn is not arranging any of these,
  // so none of these branches proposes a specific time: naming times commits Dawn to
  // chasing whether they were taken, which is exactly the loop being removed.
  let formatInstruction: string;
  if (format === "in_person_coffee") {
    formatInstruction =
      `They have both said they'd like to meet in person, and they are both in ${helped.location} — suggest they grab a coffee. ` +
      `Do not propose specific times or a venue; leave both to them.`;
  } else if (format === "phone_call") {
    formatInstruction =
      `They have both said they'd prefer a phone call over video — suggest a call. Do not propose specific times.`;
  } else if (format === "async_email") {
    formatInstruction =
      `Neither wants to start with a meeting — they both said they'd rather begin over email. Do not suggest a call at all; ` +
      `invite them to simply carry on in this thread.`;
  } else {
    // Includes video_call, no overlap, and nobody having answered.
    formatInstruction =
      `Suggest they find half an hour for a call in the next couple of weeks. Do not propose specific times — they can sort ` +
      `that out between themselves.`;
  }

  const drafted = await draftEmail(
    `You are Dawn, a professional-networking agent making a warm introduction between two people who have each separately agreed to it. ` +
      `Warm, concise, plain text, ready to send. You are handing off, not coordinating: never propose specific times, never ask them ` +
      `to report back to you, and never imply you will follow up.`,
    `Write the introduction email. BOTH ${helped.name} and ${suggested.name} are recipients — address them both by name. ` +
      `Tell each of them who the other is and what they do: ${helped.name}${helped.headline ? ` is ${helped.headline}` : ""}; ` +
      `${suggested.name}${suggested.headline ? ` is ${suggested.headline}` : ""}. ` +
      `Say specifically why the two of them are worth each other's time: ${rationale}. ` +
      `${formatInstruction} They are in ${tzNote}, so if you mention timing at all keep it vague. ` +
      `Close by explicitly leaving it with them. Keep it short and sign off as Dawn.`,
  );
  if (drafted) return drafted;

  // Fallbacks for a failed model call. Each still does the one essential job — say
  // who each person is and why — because an intro email without that is just two
  // strangers cc'd on a greeting.
  const bios =
    `${helped.name}${helped.headline ? ` — ${helped.headline}` : ""}\n` +
    `${suggested.name}${suggested.headline ? ` — ${suggested.headline}` : ""}`;

  if (format === "async_email") {
    return {
      subject: `${helped.name} ↔ ${suggested.name}`,
      body:
        `Hi ${helped.name} and ${suggested.name},\n\n` +
        `You've both said you're up for this, and you both mentioned you'd rather start over email — so here you are.\n\n` +
        `${bios}\n\n` +
        `Why I thought of you two: ${rationale}\n\n` +
        `I'll leave you to it — just reply to each other here.\n\n— Dawn`,
    };
  }
  if (format === "in_person_coffee") {
    return {
      subject: `${helped.name} ↔ ${suggested.name}`,
      body:
        `Hi ${helped.name} and ${suggested.name},\n\n` +
        `You've both said you're up for this, and you're both in ${helped.location} — so a coffee seems right.\n\n` +
        `${bios}\n\n` +
        `Why I thought of you two: ${rationale}\n\n` +
        `Over to you both to find a time and a place.\n\n— Dawn`,
    };
  }
  return {
    subject: `${helped.name} ↔ ${suggested.name}`,
    body:
      `Hi ${helped.name} and ${suggested.name},\n\n` +
      `You've both said you're up for this, so let me introduce you properly.\n\n` +
      `${bios}\n\n` +
      `Why I thought of you two: ${rationale}\n\n` +
      `Worth half an hour, I think. I'll leave the two of you to sort out when.\n\n— Dawn`,
  };
}

/**
 * A follow-up to one side that hasn't answered its opt-in ask.
 *
 * Deliberately shorter and softer than the original, and it never repeats the full
 * pitch: someone who ignored the first email does not need a second copy of it, they
 * need a one-line out. `attempt` is 1-indexed, and the second nudge says outright
 * that it is the last one — the honest version of a follow-up sequence tells you when
 * it ends, and it also gives the recipient a reason to answer now.
 */
export async function draftNudgeEmail(
  recipient: Party,
  other: Party,
  attempt: number,
) {
  const isFinal = attempt >= MAX_NUDGES;
  const drafted = await draftEmail(
    `You are Dawn, a professional-networking agent. You are following up ONCE on an introduction you suggested and have not heard back about. ` +
      `Very short — three sentences at most. Warm, never guilt-trippy, no "just circling back". Plain text, ready to send. ` +
      `Do not re-pitch the match in detail; they already have that email.`,
    `Follow up with ${recipient.name} about the introduction to ${other.name}` +
      `${other.headline ? ` (${other.headline})` : ""} that you suggested and haven't heard back on. ` +
      `Make it easy to answer either way — a "yes" or a "no thanks" are equally fine. ` +
      (isFinal
        ? `This is your last follow-up: say plainly that you won't chase it again, so they know silence closes it.`
        : `Keep it light and leave the door open.`) +
      ` Sign off as Dawn.`,
  );
  if (drafted) return drafted;
  return {
    subject: `Re: ${other.name}`,
    body:
      `Hi ${recipient.name},\n\n` +
      `Just checking whether you'd like me to introduce you to ${other.name}${other.headline ? ` (${other.headline})` : ""}. ` +
      `A "no thanks" is a perfectly good answer.\n\n` +
      (isFinal
        ? `This is the last I'll ask about this one — if I don't hear back I'll let it go.\n\n— Dawn`
        : `— Dawn`),
  };
}

// ---- Reply intent parsing (Claude, structured) ------------------------------

export type PreferenceKind = "wants" | "avoids" | "timing" | "format" | "intro_style";

/** A durable, reusable belief about someone — not a one-off fact about one intro. */
export interface PreferenceSignal {
  kind: PreferenceKind;
  value: string;
  confidence: number;
}

export interface ReplyIntent {
  opted_in: "yes" | "no" | "unclear";
  proposed_times: string[];
  chosen_time: string | null;
  summary: string;
  // Everything below was previously thrown away. `decline_reason` and
  // `preference_signals` are what let matching improve instead of repeating
  // itself; `requests_pause` and `off_topic` are what let the inbox say no.
  decline_reason: string | null;
  preference_signals: PreferenceSignal[];
  requests_pause: boolean;
  off_topic: boolean;
}

const PREFERENCE_KINDS = ["wants", "avoids", "timing", "format", "intro_style"] as const;

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    opted_in: { type: "string", enum: ["yes", "no", "unclear"] },
    proposed_times: { type: "array", items: { type: "string" } },
    chosen_time: { type: ["string", "null"] },
    summary: { type: "string" },
    decline_reason: { type: ["string", "null"] },
    preference_signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: PREFERENCE_KINDS },
          value: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["kind", "value", "confidence"],
        additionalProperties: false,
      },
    },
    requests_pause: { type: "boolean" },
    off_topic: { type: "boolean" },
  },
  required: [
    "opted_in",
    "proposed_times",
    "chosen_time",
    "summary",
    "decline_reason",
    "preference_signals",
    "requests_pause",
    "off_topic",
  ],
  additionalProperties: false,
} as const;

export interface ReplyContext {
  /** Whether this reply arrived inside a live introduction thread. */
  inIntroduction?: boolean;
  /** Who Dawn suggested, so the model can tell "not them" from "not now". */
  suggestedName?: string | null;
}

/**
 * One model call classifies the whole reply: the state-machine fields the intro
 * flow needs, the durable preference signal the reranker will later consume, and
 * the two gating booleans. Deliberately not split into separate calls — inbound
 * email is the highest-volume LLM surface in the product and every extra call is
 * paid per message received.
 */
export async function parseReplyIntent(
  replyText: string,
  context: ReplyContext = {},
): Promise<ReplyIntent> {
  const contextLine = context.inIntroduction
    ? `This reply arrived inside a live introduction thread${
        context.suggestedName ? ` where Dawn suggested ${context.suggestedName}` : ""
      }.`
    : `This reply did NOT arrive inside a live introduction thread.`;

  try {
    const resp = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: 900,
        output_config: { format: { type: "json_schema", schema: INTENT_SCHEMA } },
        messages: [
          {
            role: "user",
            content:
              `Someone emailed Dawn, a professional-networking agent that proposes introductions. Classify their message.\n\n` +
              `${contextLine}\n\n` +
              `Message:\n"""${replyText}"""\n\n` +
              `opted_in: "yes" if they're clearly open to the intro/meeting, "no" if declining, "unclear" otherwise.\n` +
              `proposed_times: any specific times THEY suggested. chosen_time: the single time they picked from options offered, else null.\n` +
              `summary: one short sentence.\n` +
              `decline_reason: if they declined, the actual reason in their own terms ("already knows them", "wrong stage", "not hiring right now"), else null. Do not invent a reason they didn't give.\n` +
              `preference_signals: durable, reusable preferences worth remembering for FUTURE introductions. ` +
              `"wants" / "avoids" describe kinds of people or opportunities; "timing" describes when they do or don't want intros; ` +
              `"format" describes how they like to meet; "intro_style" describes how they want Dawn to approach them. ` +
              `Only include something that would still be true next month — a reaction to this one person is not a preference. ` +
              `Set confidence near 1.0 when they stated it outright and near 0.3 when you are inferring it. Return an empty array if nothing durable was said.\n` +
              `requests_pause: true if they want Dawn to stop emailing them, unsubscribe, or take a break.\n` +
              `off_topic: true if they are asking Dawn for something outside proposing and coordinating introductions — general questions, research, advice, or an open request to be introduced to someone unspecified.`,
          },
        ],
      },
      { timeout: 30_000 },
    );
    const parsed = JSON.parse(textOf(resp)) as ReplyIntent;
    // The model can still omit array/boolean fields; normalise so callers and the
    // DB writes downstream never see undefined.
    return {
      ...parsed,
      proposed_times: parsed.proposed_times ?? [],
      preference_signals: (parsed.preference_signals ?? []).filter(
        (s) => s && PREFERENCE_KINDS.includes(s.kind) && typeof s.value === "string" && s.value.trim(),
      ),
      decline_reason: parsed.decline_reason ?? null,
      requests_pause: Boolean(parsed.requests_pause),
      off_topic: Boolean(parsed.off_topic),
    };
  } catch {
    // Heuristic fallback so the flow never dead-ends. It cannot infer preferences,
    // so it returns none rather than guessing — a wrong belief is worse than none.
    const yes = /\b(yes|sure|sounds good|love to|happy to|let's|coffee|meet)\b/i.test(replyText);
    const no = /\b(no|not interested|pass|decline|can't|cannot)\b/i.test(replyText);
    const pause = /\b(unsubscribe|stop emailing|stop sending|opt out|take me off|pause)\b/i.test(replyText);
    return {
      opted_in: no ? "no" : yes ? "yes" : "unclear",
      proposed_times: [],
      chosen_time: null,
      summary: "Heuristic classification (LLM parse unavailable).",
      decline_reason: null,
      preference_signals: [],
      requests_pause: pause,
      off_topic: false,
    };
  }
}

// ---- Outcome + preference persistence ---------------------------------------

/**
 * Close a conversation once its introduction can no longer move.
 *
 * `conversations.state` has existed since 0010 and nothing ever set it to
 * 'closed'. Left open, a booked or declined thread stays a live binding target:
 * the inbound fallback (which picks the most recent OPEN conversation a sender
 * participates in) would keep resolving new replies onto a dead introduction.
 */
async function closeIntroductionConversations(client: SupabaseClient, introductionId: string) {
  // Scoped to the introduction, not a single conversation: double opt-in gives each
  // side its own AgentMail thread, so closing only the one a reply arrived on would
  // leave the other still open and bindable.
  const { error } = await client
    .from("conversations")
    .update({ state: "closed", updated_at: nowIso() })
    .eq("introduction_id", introductionId);
  warnOnError("conversations update (closed)", error);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Write the real-world outcome of an introduction back onto its `matches` row.
 *
 * This is the link that makes matching evolve rather than repeat itself.
 * `fetchRejectedIds` and `fetchCalibration` (src/lib/candidates.ts) both read
 * `matches.status`, and both are already wired into the run-matches cron — but
 * until now nothing ever wrote a status from an actual email reply. Every run
 * started from the same blank slate and could happily re-suggest someone who had
 * already said no.
 */
export async function recordMatchOutcome(
  client: SupabaseClient,
  args: { matchId: string | null; aId: string; bId: string; status: "accepted" | "rejected" },
) {
  if (args.matchId) {
    const { error } = await client
      .from("matches")
      .update({ status: args.status })
      .eq("id", args.matchId);
    warnOnError(`matches.status -> ${args.status}`, error);
    return;
  }
  // Introductions started from the admin UI (and the three seeded before this
  // existed) can have a null match_id. Fall back to the canonical pair columns,
  // which are unique per pair as of migration 0003.
  const low = args.aId < args.bId ? args.aId : args.bId;
  const high = args.aId < args.bId ? args.bId : args.aId;
  const { error } = await client
    .from("matches")
    .update({ status: args.status })
    .eq("person_low", low)
    .eq("person_high", high);
  warnOnError(`matches.status -> ${args.status} (by pair)`, error);
}

/**
 * Persist durable preference signal extracted from a reply.
 *
 * Deliberately does NOT store `decline_reason`. The classifier already separates
 * the two: the reason someone turned down ONE person ("already knows them") versus
 * the reusable rules that reason implies ("only operators at Series B or later"),
 * which arrive as `preference_signals`. Filing the former as an `avoids` preference
 * produced entries like avoid "already knows them" — useless as a filter and actively
 * misleading in the matching prompt. The reason is still preserved verbatim on
 * `messages.parsed` and `inbound_events.classification`, and the pair itself is
 * excluded via `matches.status = 'rejected'`.
 *
 * Upserts, so someone repeating themselves across replies doesn't accumulate
 * duplicate beliefs (unique on person_id + kind + value — see 0015).
 */
export async function recordPreferences(
  client: SupabaseClient,
  args: {
    personId: string;
    signals: PreferenceSignal[];
    evidenceMessageId?: string | null;
  },
): Promise<number> {
  const rows = args.signals
    .map((s) => ({
      person_id: args.personId,
      kind: s.kind,
      value: s.value.trim().replace(/\s+/g, " "),
      source: "email_reply",
      confidence: clamp01(s.confidence),
      evidence_message_id: args.evidenceMessageId ?? null,
      updated_at: nowIso(),
    }))
    .filter((r) => r.value.length > 0);

  if (!rows.length) return 0;
  const { error } = await client
    .from("person_preferences")
    .upsert(rows, { onConflict: "person_id,kind,value" });
  warnOnError("person_preferences upsert", error);
  return error ? 0 : rows.length;
}

/**
 * Honour an unsubscribe. `people.paused` has existed since 0007 and is checked by
 * the run-matches scan, but nothing ever set it — there was no way for a member to
 * make Dawn stop.
 */
export async function pausePerson(client: SupabaseClient, personId: string) {
  const { error } = await client
    .from("people")
    .update({ paused: true })
    .eq("id", personId);
  warnOnError("people.paused -> true", error);
}

// ---- Relationship + interaction helpers -------------------------------------

export async function upsertRelationship(
  client: SupabaseClient,
  aId: string,
  bId: string,
  patch: { status?: string; source?: string; strengthBump?: number } = {},
) {
  const low = aId < bId ? aId : bId;
  const high = aId < bId ? bId : aId;
  const { data: existing } = await client
    .from("relationships")
    .select("*")
    .eq("person_low", low)
    .eq("person_high", high)
    .maybeSingle();

  if (existing) {
    const { data, error } = await client
      .from("relationships")
      .update({
        status: patch.status ?? existing.status,
        last_interaction_at: nowIso(),
        strength: Math.min(1, Number(existing.strength) + (patch.strengthBump ?? 0)),
        updated_at: nowIso(),
      })
      .eq("id", existing.id)
      .select()
      .single();
    warnOnError("relationships update", error);
    return data;
  }

  const { data, error } = await client
    .from("relationships")
    .insert({
      person_a_id: aId,
      person_b_id: bId,
      status: patch.status ?? "introduced",
      source: patch.source ?? "dawn_intro",
      strength: Math.min(1, 0.1 + (patch.strengthBump ?? 0)),
    })
    .select()
    .single();
  warnOnError("relationships insert", error);
  return data;
}

export async function logInteraction(
  client: SupabaseClient,
  e: {
    relationship_id: string | null;
    person_id: string;
    counterparty_id: string | null;
    type: "intro_sent" | "opted_in" | "meeting_scheduled" | "meeting_completed" | "message";
    weight?: number;
    metadata?: Record<string, unknown>;
  },
) {
  const { error } = await client.from("interactions").insert({
    relationship_id: e.relationship_id,
    person_id: e.person_id,
    counterparty_id: e.counterparty_id ?? null,
    type: e.type,
    weight: e.weight ?? 0.1,
    metadata: e.metadata ?? {},
  });
  warnOnError(`interactions insert (${e.type})`, error);
}

// ---- Kick off an introduction (called by the run-matches cron) --------------

export interface StartIntroParams {
  helped: Person; // person A — the member we're helping
  suggested: Person; // person B — the suggested match
  matchId?: string | null;
  direction: MatchDirection;
  rationale: string;
}

export interface StartIntroResult {
  introductionId: string;
  conversationId: string;
  threadId: string | null;
  state: string;
  simulated: boolean;
  emailedTo: string | null;
  /** Set when the opt-in email failed to send; the introduction is `expired`. */
  sendError?: string;
}

export async function startIntroduction(
  client: SupabaseClient,
  p: StartIntroParams,
): Promise<StartIntroResult> {
  const singleSided = isSingleSided();
  const helped = toParty(p.helped);
  const suggested = toParty(p.suggested);

  // 1. Introduction row. In single-sided test mode, person B is auto-opted-in
  //    so the flow can reach scheduling with a single real recipient.
  const { data: intro, error: iErr } = await client
    .from("introductions")
    .insert({
      match_id: p.matchId ?? null,
      person_a_id: helped.id,
      person_b_id: suggested.id,
      state: "proposed",
      rationale: p.rationale,
      b_response: singleSided ? "yes" : "pending",
    })
    .select()
    .single();
  if (iErr) throw new Error(iErr.message);

  // 2. Conversation (the persisted email thread).
  const { data: convo, error: cErr } = await client
    .from("conversations")
    .insert({
      introduction_id: intro.id,
      inbox_id: AGENTMAIL_INBOX_ID,
      purpose: "opt_in",
      participants: [
        { person_id: helped.id, email: helped.email, role: "helped" },
        { person_id: suggested.id, email: suggested.email, role: "suggested" },
      ],
    })
    .select()
    .single();
  if (cErr) throw new Error(cErr.message);

  // 3. Append to the intros log BEFORE sending. This row is the rate-limit ledger
  //    that /api/cron/run-matches counts to honour each member's intro_cadence, so
  //    it must be durable before we cause an irreversible side effect. Failing
  //    closed (no email) is far cheaper than failing open (re-emailing every member
  //    on every run) — which is precisely what happened while RLS was silently
  //    rejecting this insert. A spurious row if the send later fails is harmless:
  //    it costs one skipped cadence window, and `introductions` records the truth.
  const { error: introsErr } = await client.from("intros").insert({
    requester_ref: helped.id,
    introduced_to_id: suggested.id,
    rationale: p.rationale,
    channel: "email",
  });
  if (introsErr) {
    throw new Error(
      `Refusing to send: could not record this intro in the rate-limit ledger (${introsErr.message}).`,
    );
  }

  // 4. Draft + send the opt-in email to person A only (testing).
  const draft = await draftOptInEmail(helped, suggested, p.rationale);
  // Compute the outgoing body ONCE and persist that exact string. Sending
  // withUnsubscribe(body) while storing the bare draft makes `messages` a record of
  // an email that was never sent — and the unsubscribe footer is the one part you
  // most need to be able to prove you included.
  const outgoing = withUnsubscribe(draft.body);
  let send: SendResult = { messageId: null, threadId: null, simulated: true };
  let sendError: string | null = null;
  if (helped.email) {
    // The gateway returns rather than throws for ordinary refusals, but it deliberately
    // DOES throw when its own safety checks are the thing that broke — an unreadable
    // suppression table or a failed ledger write. Left unhandled either escapes
    // startIntroduction into the /api/cron/run-matches try block, which 500s the WHOLE
    // batch: one bad send would silently skip every remaining member. Contain it here
    // so the batch continues, and mark this one introduction terminal below so the pair
    // stays retryable on the next run.
    try {
      const result = await sendViaGateway(client, {
        introductionId: intro.id,
        kind: "opt_in_a",
        to: [helped.email],
        subject: draft.subject,
        text: outgoing,
      });
      send = result;
      // A refusal is not an exception, but it is still a reason not to claim delivery.
      // `failure: null` is the drafted case — the gate is closed and this is expected,
      // so it must NOT be treated as an error (see the branch below, which would
      // otherwise expire every introduction the moment delivery is switched off).
      if (result.failure !== null) sendError = result.failure;
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      console.error(`[intro-flow] opt-in send failed for ${helped.email}: ${sendError}`);
    }
  }

  // 4a. Nothing reached person A. Do not record an outbound message or advance to
  //     `a_invited` — both would claim a delivery that never happened. Marking the
  //     introduction `expired` (terminal) frees the pair to be retried, rather than
  //     stranding it in a non-terminal state that the duplicate guard treats as
  //     active for the next 7 days. The `intros` ledger row from step 3 stands: it
  //     costs this member one cadence window, which is the documented trade.
  if (sendError !== null) {
    warnOnError(
      "introductions update (send failed)",
      (
        await client
          .from("introductions")
          .update({ state: "expired", updated_at: nowIso() })
          .eq("id", intro.id)
      ).error,
    );
    warnOnError(
      "conversations update (send failed)",
      (
        await client
          .from("conversations")
          .update({ state: "closed", updated_at: nowIso() })
          .eq("id", convo.id)
      ).error,
    );
    return {
      introductionId: intro.id,
      conversationId: convo.id,
      threadId: null,
      state: "expired",
      simulated: false,
      emailedTo: null,
      sendError,
    };
  }

  // 5. Persist the outbound message + thread id, advance state.
  warnOnError(
    "messages insert (opt-in)",
    (
      await client.from("messages").insert({
        conversation_id: convo.id,
        agentmail_message_id: send.messageId,
        direction: "outbound",
        from_email: AGENTMAIL_INBOX_ID,
        to_emails: helped.email ? [helped.email] : [],
        subject: draft.subject,
        body: outgoing,
      })
    ).error,
  );
  warnOnError(
    "conversations update (thread id)",
    (
      await client
        .from("conversations")
        .update({ thread_id: send.threadId, subject: draft.subject, updated_at: nowIso() })
        .eq("id", convo.id)
    ).error,
  );
  warnOnError(
    "introductions update (a_invited)",
    (
      await client
        .from("introductions")
        .update({
          state: "a_invited",
          // A now owes us a reply. Arming the clock here (rather than letting the
          // nudge sweep infer a due time from `updated_at`) means every later state
          // change can re-arm or disarm it explicitly, so a row is never both
          // terminal and due.
          awaiting: "a",
          next_action_at: dueInDays(NUDGE_FIRST_DELAY_DAYS),
          updated_at: nowIso(),
        })
        .eq("id", intro.id)
    ).error,
  );

  // 6. Seed the relationship + first interaction.
  const rel = await upsertRelationship(client, helped.id, suggested.id, {
    status: "introduced",
    source: "dawn_intro",
    strengthBump: 0.05,
  });
  await logInteraction(client, {
    relationship_id: rel?.id ?? null,
    person_id: helped.id,
    counterparty_id: suggested.id,
    type: "intro_sent",
    weight: 0.15,
  });

  return {
    introductionId: intro.id,
    conversationId: convo.id,
    threadId: send.threadId,
    state: "a_invited",
    simulated: send.simulated,
    emailedTo: helped.email,
  };
}

// ---- Second-side invite (the other half of double opt-in) -------------------

/**
 * Ask person B whether they're open to the introduction A just accepted.
 *
 * B gets their OWN conversation row and therefore its own AgentMail thread. Two
 * reasons: B's reply must not land in A's thread (each side's opt-in is private to
 * them), and inbound triage binds replies by `thread_id` — a single shared thread id
 * could not tell A's reply from B's. `conversations.introduction_id` is a plain FK,
 * so several conversations per introduction is already supported.
 *
 * Returns whether an email actually went out.
 */
async function inviteSecondSide(
  client: SupabaseClient,
  p: { introductionId: string; helped: Party; suggested: Party; rationale: string },
): Promise<boolean> {
  const { data: convo, error: cErr } = await client
    .from("conversations")
    .insert({
      introduction_id: p.introductionId,
      inbox_id: AGENTMAIL_INBOX_ID,
      purpose: "opt_in",
      participants: [
        { person_id: p.suggested.id, email: p.suggested.email, role: "suggested" },
        { person_id: p.helped.id, email: p.helped.email, role: "helped" },
      ],
    })
    .select()
    .single();
  if (cErr) {
    warnOnError("conversations insert (second side)", cErr);
    return false;
  }

  const draft = await draftSecondSideOptInEmail(p.helped, p.suggested, p.rationale);
  const outgoing = withUnsubscribe(draft.body);
  const send = await sendViaGateway(client, {
    introductionId: p.introductionId,
    kind: "opt_in_b",
    replyToMessageId: null, // B has no prior message to thread onto.
    to: [p.suggested.email],
    subject: draft.subject,
    text: outgoing,
  });

  warnOnError(
    "messages insert (second-side opt-in)",
    (
      await client.from("messages").insert({
        conversation_id: convo.id,
        agentmail_message_id: send.messageId,
        direction: "outbound",
        from_email: AGENTMAIL_INBOX_ID,
        to_emails: p.suggested.email ? [p.suggested.email] : [],
        subject: draft.subject,
        body: outgoing,
      })
    ).error,
  );
  warnOnError(
    "conversations update (second-side thread id)",
    (
      await client
        .from("conversations")
        .update({ thread_id: send.threadId, subject: draft.subject, updated_at: nowIso() })
        .eq("id", convo.id)
    ).error,
  );

  // The caller turns this boolean into a human-readable note whose false branch reads
  // "…has no reachable email address". So the question being answered is specifically
  // "did we have somewhere to send it", NOT "did it leave the building" — a drafted
  // message under a closed delivery gate has a perfectly good address and must not be
  // reported as an unreachable one.
  return send.failure !== "no_recipient";
}

// ---- Advance an introduction when a reply arrives (called by /api/agent/inbound)

export interface AdvanceResult {
  state: string;
  action:
    | "opted_in_waiting"
    | "invited_second_side"
    | "introduced"
    // Only reachable for rows already in `scheduling` when the handoff shipped; new
    // introductions terminate at `introduced` and never enter the scheduling states.
    | "scheduled"
    | "declined"
    | "noop";
  note: string;
}

/**
 * Apply an inbound reply to its introduction and move the state machine forward.
 * `replierId` is which participant replied; `replyToMessageId` is the AgentMail
 * message id to reply on (kept threaded). Returns what action was taken.
 */
export async function advanceOnReply(
  client: SupabaseClient,
  args: {
    introductionId: string;
    conversationId: string;
    replierId: string;
    intent: ReplyIntent;
    replyToMessageId: string | null;
    /** Row id of the stored inbound `messages` record, for preference provenance. */
    replyMessageRowId?: string | null;
  },
): Promise<AdvanceResult> {
  const { data: intro } = await client
    .from("introductions")
    .select("*")
    .eq("id", args.introductionId)
    .single();
  if (!intro) return { state: "unknown", action: "noop", note: "introduction not found" };

  const isA = args.replierId === intro.person_a_id;
  const respField = isA ? "a_response" : "b_response";

  // Whatever the outcome, anything durable the member said is worth keeping.
  // People often reveal a preference while accepting, not only while declining.
  await recordPreferences(client, {
    personId: args.replierId,
    signals: args.intent.preference_signals,
    evidenceMessageId: args.replyMessageRowId ?? null,
  });

  if (args.intent.opted_in === "no") {
    warnOnError(
      "introductions update (declined)",
      (
        await client
          .from("introductions")
          .update({
            [respField]: "no",
            state: "declined",
            // Terminal — disarm, so the nudge sweep can never chase someone who has
            // explicitly said no.
            awaiting: null,
            next_action_at: null,
            updated_at: nowIso(),
          })
          .eq("id", intro.id)
      ).error,
    );
    // Close the loop: mark the underlying suggestion rejected so the reranker's
    // exclusion list and calibration examples pick this up on the next run.
    await recordMatchOutcome(client, {
      matchId: intro.match_id ?? null,
      aId: intro.person_a_id,
      bId: intro.person_b_id,
      status: "rejected",
    });
    await closeIntroductionConversations(client, intro.id);
    return {
      state: "declined",
      action: "declined",
      note: args.intent.decline_reason
        ? `Participant declined: ${args.intent.decline_reason}`
        : "Participant declined.",
    };
  }

  // A reply that picks a time while we are already scheduling is a BOOKING, not a
  // fresh opt-in, and must be checked before the generic "yes" branch. "Wednesday
  // 2pm works great" classifies as opted_in: "yes", which used to re-enter the
  // both-opted-in branch and propose times all over again — so `scheduled` was
  // unreachable from any natural reply and the flow could loop indefinitely.
  const isBooking = intro.state === "scheduling" && Boolean(args.intent.chosen_time);

  if (!isBooking && args.intent.opted_in === "yes") {
    const aResp = isA ? "yes" : intro.a_response;
    const bResp = isA ? intro.b_response : "yes";
    const bothIn = aResp === "yes" && bResp === "yes";

    // Load both parties for a scheduling draft.
    const { data: people } = await client
      .from("people")
      .select("id, name, email, headline, timezone")
      .in("id", [intro.person_a_id, intro.person_b_id]);
    const byId = new Map((people ?? []).map((p) => [p.id, p as Party]));
    const helped = byId.get(intro.person_a_id)!;
    const suggested = byId.get(intro.person_b_id)!;

    // Record opt-in on the relationship.
    const rel = await upsertRelationship(client, intro.person_a_id, intro.person_b_id, {
      status: bothIn ? "connected" : "introduced",
      strengthBump: 0.2,
    });
    await logInteraction(client, {
      relationship_id: rel?.id ?? null,
      person_id: args.replierId,
      counterparty_id: isA ? intro.person_b_id : intro.person_a_id,
      type: "opted_in",
      weight: 0.25,
    });

    if (!bothIn) {
      // A said yes and B has never been contacted → this is the moment to ask B.
      // Previously the flow just parked here waiting for a reply from someone who
      // had never received an email, until expire-intros swept it.
      if (isA && intro.b_response === "pending") {
        const invited = await inviteSecondSide(client, {
          introductionId: intro.id,
          helped,
          suggested,
          rationale: intro.rationale ?? "You have overlapping interests.",
        });
        warnOnError(
          "introductions update (b_invited)",
          (
            await client
              .from("introductions")
              .update({
                a_response: "yes",
                state: "b_invited",
                // The wait transfers to B, and B's nudge allowance is its own
                // counter — A having been chased twice must not shorten B's rope.
                awaiting: "b",
                next_action_at: dueInDays(NUDGE_FIRST_DELAY_DAYS),
                updated_at: nowIso(),
              })
              .eq("id", intro.id)
          ).error,
        );
        return {
          state: "b_invited",
          action: "invited_second_side",
          note: invited
            ? `${helped.name} is in; asked ${suggested.name} if they're open to it.`
            : `${helped.name} is in, but ${suggested.name} has no reachable email address.`,
        };
      }

      // Waiting on the other side — but only if they have actually been asked and
      // are still pending. If they already answered "no" there is nobody left to
      // chase, and arming the clock would have the sweep nudging a person who has
      // already declined.
      const otherPending = (isA ? intro.b_response : intro.a_response) === "pending";
      warnOnError(
        "introductions update (one side opted in)",
        (
          await client
            .from("introductions")
            .update({
              [respField]: "yes",
              state: isA ? "a_opted_in" : "b_opted_in",
              awaiting: otherPending ? (isA ? "b" : "a") : null,
              next_action_at: otherPending ? dueInDays(NUDGE_FIRST_DELAY_DAYS) : null,
              updated_at: nowIso(),
            })
            .eq("id", intro.id)
        ).error,
      );
      return { state: isA ? "a_opted_in" : "b_opted_in", action: "opted_in_waiting", note: "One side in; awaiting the other." };
    }

    // Both in → send the warm introduction to BOTH parties and step out. This is the
    // terminal happy path: Dawn's job was to find the pair and get consent from each
    // side, and it is now done. (It previously proposed times here and stayed in the
    // thread until a booking; see draftWarmIntroEmail for why that changed.)
    const draft = await draftWarmIntroEmail(
      client,
      helped,
      suggested,
      intro.rationale ?? "You have overlapping interests.",
    );
    const introBody = withUnsubscribe(draft.body);
    const recipients = [helped.email, suggested.email].filter((e): e is string => Boolean(e));
    const send = await sendViaGateway(client, {
      introductionId: intro.id,
      kind: "introduction",
      // Deliberately NOT threaded. AgentMail's reply() takes no recipient list — it
      // answers whoever sent the parent — so threading here would deliver the
      // introduction to one side only. A fresh send is the only way to address both
      // parties.
      replyToMessageId: null,
      to: recipients,
      subject: draft.subject,
      text: introBody,
    });
    warnOnError(
      "messages insert (warm intro)",
      (
        await client.from("messages").insert({
          conversation_id: args.conversationId,
          agentmail_message_id: send.messageId,
          direction: "outbound",
          from_email: AGENTMAIL_INBOX_ID,
          to_emails: recipients,
          subject: draft.subject,
          body: introBody,
        })
      ).error,
    );
    warnOnError(
      "introductions update (introduced)",
      (
        await client
          .from("introductions")
          .update({
            a_response: aResp,
            b_response: bResp,
            state: "introduced",
            // Terminal: nobody owes Dawn a reply, so disarm the clock. Leaving a due
            // time on a finished row is how a sweep ends up nudging people about an
            // introduction that already happened.
            awaiting: null,
            next_action_at: null,
            updated_at: nowIso(),
          })
          .eq("id", intro.id)
      ).error,
    );
    warnOnError(
      "conversations update (introduced)",
      (
        await client
          .from("conversations")
          .update({ purpose: "intro", updated_at: nowIso() })
          .eq("id", args.conversationId)
      ).error,
    );
    // The success signal for the reranker now fires here rather than on a booked
    // meeting, because there is no longer a booking for Dawn to observe. It is an
    // honestly weaker proxy for "this was a good match" — both sides said yes, which
    // is not the same as them getting on — but losing the feedback loop entirely
    // would be worse. Inferring an actual meeting would need reply detection on the
    // handed-off thread, which is a later addition.
    await recordMatchOutcome(client, {
      matchId: intro.match_id ?? null,
      aId: intro.person_a_id,
      bId: intro.person_b_id,
      status: "accepted",
    });
    await closeIntroductionConversations(client, intro.id);

    return { state: "introduced", action: "introduced", note: "Both opted in; sent the introduction." };
  }

  // Already scheduling and they picked a time → lock it in.
  if (isBooking) {
    const rel = await upsertRelationship(client, intro.person_a_id, intro.person_b_id, {
      status: "met",
      strengthBump: 0.3,
    });
    await logInteraction(client, {
      relationship_id: rel?.id ?? null,
      person_id: args.replierId,
      counterparty_id: isA ? intro.person_b_id : intro.person_a_id,
      type: "meeting_scheduled",
      weight: 0.4,
      metadata: { chosen_time: args.intent.chosen_time },
    });
    warnOnError(
      "introductions update (scheduled)",
      (
        await client
          .from("introductions")
          .update({ state: "scheduled", awaiting: null, next_action_at: null, updated_at: nowIso() })
          .eq("id", intro.id)
      ).error,
    );
    // A meeting actually booked is the strongest positive signal the product gets;
    // feed it back so the reranker's calibration examples include real wins.
    await recordMatchOutcome(client, {
      matchId: intro.match_id ?? null,
      aId: intro.person_a_id,
      bId: intro.person_b_id,
      status: "accepted",
    });
    await closeIntroductionConversations(client, intro.id);
    return { state: "scheduled", action: "scheduled", note: `Locked in: ${args.intent.chosen_time}` };
  }

  return { state: intro.state, action: "noop", note: "No state change (unclear reply)." };
}

// ---- Nudge a stalled introduction (called by /api/cron/nudge-intros) --------

export interface NudgeResult {
  introductionId: string;
  /** 'nudged' sent a follow-up; 'expired' used up the last one; 'skipped' did nothing. */
  action: "nudged" | "expired" | "skipped";
  side: "a" | "b" | null;
  attempt: number;
  note: string;
}

/**
 * Follow up with whichever side of an introduction has gone quiet, or retire the
 * introduction once its allowance is spent.
 *
 * The row's own `awaiting` column decides who to chase, and that side's own counter
 * decides whether to chase at all — so this is safe to call on any row the sweep
 * hands it, including one that raced with an inbound reply between the sweep's
 * SELECT and this call. Every exit path either re-arms `next_action_at` or clears it,
 * because a row left due-and-unchanged is one the sweep will pick up forever.
 */
export async function nudgeIntroduction(
  client: SupabaseClient,
  introductionId: string,
): Promise<NudgeResult> {
  const { data: intro } = await client
    .from("introductions")
    .select("*")
    .eq("id", introductionId)
    .single();
  if (!intro) {
    return { introductionId, action: "skipped", side: null, attempt: 0, note: "introduction not found" };
  }

  // Re-check state at execution time. The sweep selected this row a moment ago and a
  // reply may have landed since; nudging someone who has just answered is the single
  // worst failure mode this route has, so it is checked twice rather than once.
  const NUDGEABLE = ["proposed", "a_invited", "b_invited", "a_opted_in", "b_opted_in"];
  if (!NUDGEABLE.includes(intro.state) || !intro.awaiting) {
    warnOnError(
      "introductions update (nudge disarm)",
      (
        await client
          .from("introductions")
          .update({ next_action_at: null, updated_at: nowIso() })
          .eq("id", intro.id)
      ).error,
    );
    return {
      introductionId,
      action: "skipped",
      side: null,
      attempt: 0,
      note: `state '${intro.state}' is no longer waiting on anyone; clock disarmed`,
    };
  }

  const side: "a" | "b" = intro.awaiting === "a" ? "a" : "b";
  const recipientId = side === "a" ? intro.person_a_id : intro.person_b_id;
  const otherId = side === "a" ? intro.person_b_id : intro.person_a_id;
  const sent = (side === "a" ? intro.a_nudges : intro.b_nudges) ?? 0;
  const countField = side === "a" ? "a_nudges" : "b_nudges";

  // Allowance spent → retire it silently. The other side is deliberately NOT told
  // this fell through: they said yes to meeting a person, and "that didn't work out"
  // is one more email about someone they never met. They will get a different match.
  if (sent >= MAX_NUDGES) {
    warnOnError(
      "introductions update (nudges exhausted)",
      (
        await client
          .from("introductions")
          .update({ state: "expired", awaiting: null, next_action_at: null, updated_at: nowIso() })
          .eq("id", intro.id)
      ).error,
    );
    await closeIntroductionConversations(client, intro.id);
    return {
      introductionId,
      action: "expired",
      side,
      attempt: sent,
      note: `no reply after ${sent} follow-ups; expired quietly`,
    };
  }

  const { data: people } = await client
    .from("people")
    .select("id, name, email, headline, timezone, location, paused")
    .in("id", [recipientId, otherId]);
  const byId = new Map((people ?? []).map((p) => [p.id, p]));
  const recipientRow = byId.get(recipientId);
  const otherRow = byId.get(otherId);

  // A member who asked Dawn to stop must not be chased. `paused` is checked here and
  // not only in candidate selection because pausing happens *between* the original
  // ask and the follow-up — that gap is exactly what a nudge sequence introduces.
  if (!recipientRow || !recipientRow.email || recipientRow.paused) {
    warnOnError(
      "introductions update (unreachable recipient)",
      (
        await client
          .from("introductions")
          .update({ state: "expired", awaiting: null, next_action_at: null, updated_at: nowIso() })
          .eq("id", intro.id)
      ).error,
    );
    await closeIntroductionConversations(client, intro.id);
    return {
      introductionId,
      action: "skipped",
      side,
      attempt: sent,
      note: recipientRow?.paused ? "recipient is paused; expired without nudging" : "recipient unreachable",
    };
  }

  // Thread onto that side's own conversation. Each side has its own (see
  // inviteSecondSide) precisely so their opt-ins stay private, so the nudge has to
  // pick the right one — a follow-up for B landing in A's thread would leak that B
  // was asked at all.
  const { data: convos } = await client
    .from("conversations")
    .select("id, participants")
    .eq("introduction_id", intro.id);
  const convo =
    (convos ?? []).find((c) => {
      const first = Array.isArray(c.participants) ? c.participants[0] : null;
      return first && (first as { person_id?: string }).person_id === recipientId;
    }) ?? (convos ?? [])[0];
  if (!convo) {
    return { introductionId, action: "skipped", side, attempt: sent, note: "no conversation to thread onto" };
  }

  // Reply to the last thing we sent them, so the follow-up appears under the original
  // ask rather than as a second unexplained email from a stranger.
  const { data: lastOutbound } = await client
    .from("messages")
    .select("agentmail_message_id")
    .eq("conversation_id", convo.id)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const attempt = sent + 1;
  const draft = await draftNudgeEmail(
    recipientRow as Party,
    (otherRow ?? { id: otherId, name: "someone", email: null, headline: null, timezone: null, location: null }) as Party,
    attempt,
  );
  const outgoing = withUnsubscribe(draft.body);

  let send: SendResult = { messageId: null, threadId: null, simulated: true };
  try {
    send = await sendViaGateway(client, {
      introductionId: intro.id,
      kind: "nudge",
      // The nudge counter is the idempotency discriminator: nudges are the one kind
      // that legitimately repeats, so without `attempt` the second follow-up would
      // collide with the first on the unique index and be dropped as a duplicate.
      attempt,
      replyToMessageId: lastOutbound?.agentmail_message_id ?? null,
      to: [recipientRow.email],
      subject: draft.subject,
      text: outgoing,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[intro-flow] nudge send failed for ${recipientRow.email}: ${message}`);
    // Back off a full cycle rather than burning the attempt: the send failing is
    // Dawn's problem, not evidence the recipient is ignoring us. The counter is
    // untouched, so the allowance still buys two delivered follow-ups.
    warnOnError(
      "introductions update (nudge send failed)",
      (
        await client
          .from("introductions")
          .update({ next_action_at: dueInDays(NUDGE_REPEAT_DELAY_DAYS), updated_at: nowIso() })
          .eq("id", intro.id)
      ).error,
    );
    return { introductionId, action: "skipped", side, attempt: sent, note: `send failed: ${message}` };
  }

  warnOnError(
    "messages insert (nudge)",
    (
      await client.from("messages").insert({
        conversation_id: convo.id,
        agentmail_message_id: send.messageId,
        direction: "outbound",
        from_email: AGENTMAIL_INBOX_ID,
        to_emails: [recipientRow.email],
        subject: draft.subject,
        body: outgoing,
      })
    ).error,
  );

  // Re-arm even on the final attempt: the next sweep is what turns a spent allowance
  // into `expired` (the branch at the top of this function). Without a due time that
  // row would wait for expire-intros' seven-day backstop instead.
  warnOnError(
    "introductions update (nudged)",
    (
      await client
        .from("introductions")
        .update({
          [countField]: attempt,
          next_action_at: dueInDays(NUDGE_REPEAT_DELAY_DAYS),
          updated_at: nowIso(),
        })
        .eq("id", intro.id)
    ).error,
  );

  return {
    introductionId,
    action: "nudged",
    side,
    attempt,
    note: `follow-up ${attempt}/${MAX_NUDGES} sent to ${recipientRow.name}`,
  };
}
