import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import { fetchRecentGmailHeaders, fetchRecentCalendarEvents } from "./gmail-ingest";
import { parseAddress, splitAddresses } from "./network-ingest";
import { domainOf, GENERIC_DOMAINS } from "./domains";

/**
 * Draft a public profile for a user from their own mailbox activity.
 *
 * Adapted from nexus's `synthesizeUserProfile`, with one structural difference that
 * shapes everything below: **nexus read message bodies and this does not.**
 *
 * nexus fetched Gmail with `format=full` and fed the model 2000 characters of each
 * outbound message. dawn-v0's ingest is `format=metadata` on purpose (SPEC step 4 is
 * where bodies arrive, behind the review queue that is supposed to govern content-
 * derived claims). So the evidence here is: outbound SUBJECT LINES, who the person
 * emails, the domains those people are at, and calendar event titles.
 *
 * That is genuinely thinner, and the prompt is written to be honest about it rather
 * than to paper over it — subject lines support "works on payments infrastructure"
 * and do not support a confident account of someone's writing voice or their
 * reasoning. nexus's `voiceNotes` field is dropped entirely: its only consumer was
 * `draftColdEmail`, which does not exist here, and inferring tone from subject lines
 * alone would be invention.
 *
 * The draft is returned, never persisted by this function. Staging and the Confirm
 * step are the caller's job (see app/api/onboarding/*), because nothing here should be
 * network-visible until the user has actually looked at it.
 */

export const ProfileDraftSchema = z.object({
  headline: z
    .string()
    .describe(
      "A punchy one-line professional identity, e.g. 'Seed investor focused on dev tools & infra'",
    ),
  bio: z
    .string()
    .describe(
      "2-4 sentence third-person bio a stranger in the network could read to understand who this person is and what they do",
    ),
  expertise: z
    .array(z.string())
    .describe("Domains/topics they clearly have real depth in, inferred from activity"),
  interests: z
    .array(z.string())
    .describe(
      "Things they seem into — professional or personal — beyond their core expertise",
    ),
  goals: z
    .array(z.string())
    .describe(
      "What they currently seem to be working toward, inferred from recent activity. Empty array if the signal doesn't support a guess.",
    ),
  suggestedIntros: z
    .array(z.string())
    .describe(
      "Specific, concrete types of intros this person might be open to giving or receiving, inferred from who is already in their network — e.g. 'Seed-stage fintech founders', 'LPs looking at climate funds'. Be specific rather than generic; empty array if there is not enough signal to guess.",
    ),
});

export type ProfileDraft = z.infer<typeof ProfileDraftSchema>;

export const SYNTHESIS_MODEL = "claude-sonnet-5";

/** Below this many outbound messages there is nothing worth synthesising from. */
const MIN_OUTBOUND = 3;

/** Subject lines are the whole evidence base, so send a generous slice. */
const MAX_SUBJECTS = 120;
const MAX_DOMAINS = 25;
const MAX_EVENTS = 40;

export interface SynthesisResult {
  draft: ProfileDraft | null;
  generated: boolean;
  /** Why nothing was generated, for copy the user can act on. */
  reason: "ok" | "not_enough_activity" | "no_api_key";
  evidence: { subjects: number; domains: number; events: number };
}

export async function synthesizeProfile(opts: {
  accessToken: string;
  email: string;
  name: string | null;
  /**
   * Optional free-text steer from the user on a regenerate — "I'm a founder, not an
   * investor", "focus on my climate work". It shapes emphasis and framing; it does not
   * license inventing claims the evidence doesn't support (the prompt says so).
   */
  guidance?: string | null;
}): Promise<SynthesisResult> {
  const you = opts.email.trim().toLowerCase();

  const [headers, events] = await Promise.all([
    fetchRecentGmailHeaders(opts.accessToken),
    fetchRecentCalendarEvents(opts.accessToken),
  ]);

  // Outbound only. Inbound subject lines describe what other people want, and a
  // profile built from your inbox reads like a profile of everyone who emails you.
  const outboundSubjects: string[] = [];
  const domainCounts = new Map<string, number>();

  for (const h of headers) {
    const from = h.from ? parseAddress(h.from) : null;
    const isOutbound = from?.email?.toLowerCase() === you;
    if (isOutbound && h.subject?.trim()) outboundSubjects.push(h.subject.trim());

    // Counterparties from both directions — who is in the network is symmetric,
    // even though what you write about is not.
    const counterparties = [
      ...(isOutbound ? [] : from ? [from] : []),
      ...splitAddresses(h.to),
      ...splitAddresses(h.cc),
    ];
    for (const c of counterparties) {
      const email = c.email?.toLowerCase();
      if (!email || email === you) continue;
      const domain = domainOf(email);
      if (!domain || GENERIC_DOMAINS.has(domain)) continue;
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
  }

  const evidence = {
    subjects: outboundSubjects.length,
    domains: domainCounts.size,
    events: events.length,
  };

  if (outboundSubjects.length < MIN_OUTBOUND) {
    return { draft: null, generated: false, reason: "not_enough_activity", evidence };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { draft: null, generated: false, reason: "no_api_key", evidence };
  }

  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DOMAINS)
    .map(([domain, count]) => `${domain} (${count})`);

  const eventTitles = [...new Set(events.map((e) => e.summary?.trim()).filter(Boolean))].slice(
    0,
    MAX_EVENTS,
  );

  const guidance = opts.guidance?.trim();

  const context = [
    `Name: ${opts.name ?? "(unknown)"}`,
    `Email: ${opts.email}`,
    `Organisations they exchange mail with most (domain and how many contacts there): ${
      topDomains.join(", ") || "(none identified)"
    }`,
    `Recent meeting titles: ${eventTitles.join(" · ") || "(none)"}`,
    `Subject lines of email they SENT, most recent first:\n${outboundSubjects
      .slice(0, MAX_SUBJECTS)
      .map((s) => `- ${s}`)
      .join("\n")}`,
  ].join("\n\n");

  const { object } = await generateObject({
    model: anthropic(SYNTHESIS_MODEL),
    schema: ProfileDraftSchema,
    prompt:
      `Synthesize a public profile for someone, to show to other people in a shared ` +
      `professional network (a VC firm's internal network of investors, founders, and ` +
      `operators).\n\n` +
      `IMPORTANT — what you are and are not working from. You have the SUBJECT LINES of ` +
      `email this person sent, the organisations they correspond with, and their meeting ` +
      `titles. You do NOT have the body of any message, and you never will here. So: ` +
      `infer what someone works on, who they work with, and what they are pushing ` +
      `forward — subject lines support that well. Do NOT infer their personality, their ` +
      `writing style, their seniority, or their opinions; that is not in this evidence. ` +
      `A subject line is a topic, not a position.\n\n` +
      `Use your judgement about what is genuinely worth surfacing. Do not pad a field ` +
      `with generic filler when the evidence doesn't support it — an empty array is a ` +
      `better answer than a vague one, and "Experienced professional with a passion for ` +
      `innovation" is worse than nothing. Never quote a subject line verbatim; they are ` +
      `private, and some name people or deals. Write as if this were the person's own ` +
      `public bio, grounded only in what the activity actually shows.\n\n` +
      `Also suggest concrete types of intros they might be open to, based on the kinds ` +
      `of organisations already in their network. These are suggestions the person can ` +
      `accept or ignore, never a stated preference.\n\n` +
      (guidance
        ? `The person reviewed a previous draft and asked you to steer this one: ` +
          `"${guidance}". Honour it as direction on emphasis and framing. It does not ` +
          `override the evidence rules above — if they ask for something the activity ` +
          `doesn't support, lean the framing their way but don't invent claims.\n\n`
        : "") +
      context,
  });

  return { draft: object, generated: true, reason: "ok", evidence };
}

/** One-line description of what a draft was inferred from, stored as claim evidence. */
export function describeEvidence(evidence: SynthesisResult["evidence"]): string {
  return (
    `Inferred by ${SYNTHESIS_MODEL} from Gmail/Calendar metadata: ` +
    `${evidence.subjects} outbound subject lines, ${evidence.domains} correspondent ` +
    `organisations, ${evidence.events} calendar events. No message bodies were read.`
  );
}

