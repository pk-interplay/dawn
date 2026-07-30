import type { PersonRef } from "../monitor/types";

export interface ExchangeSummary {
  id: string;
  state: string;
  a_response: string;
  b_response: string;
  created_at: string;
  updated_at: string;
  person_a: PersonRef;
  person_b: PersonRef;
  messageCount: number;
  inboundCount: number;
  lastMessageAt: string | null;
}

/** Who is speaking. `a`/`b` are the two parties; `other` is a third member a
 *  forwarded reply resolved to. */
export type SpeakerRole = "dawn" | "a" | "b" | "other" | "unknown";

export interface Speaker {
  role: SpeakerRole;
  name: string;
  email: string | null;
  /** The reply arrived from an address that isn't this person's — the operator
   *  answering as a persona during a pilot. */
  viaOperator: boolean;
}

export interface Recipient {
  email: string;
  name: string | null;
  role: string;
}

/**
 * Dawn's structured read of an inbound reply — `messages.parsed`, written from
 * ReplyIntent in src/lib/intro-flow.ts. Every field is optional here: rows
 * predating a field, and the regex fallback used when the LLM call fails, both
 * store a partial object.
 */
export interface ReplyIntentView {
  opted_in?: "yes" | "no" | "unclear";
  proposed_times?: string[];
  chosen_time?: string | null;
  summary?: string;
  decline_reason?: string | null;
  preference_signals?: Array<{ kind: string; value: string; confidence: number }>;
  requests_pause?: boolean;
  off_topic?: boolean;
}

/** One email in the trail. The unit of playback. */
export interface Step {
  id: string;
  conversationId: string;
  purpose: string;
  direction: "inbound" | "outbound";
  speaker: Speaker;
  recipients: Recipient[];
  subject: string | null;
  body: string | null;
  createdAt: string;
  /** Dawn's extracted read of an inbound reply; null on outbound. */
  intent: ReplyIntentView | null;
  triage: {
    decision: string;
    replied: boolean;
    classification: Record<string, unknown>;
  } | null;
}

export interface ExchangeDetail {
  introduction: {
    id: string;
    state: string;
    a_response: string;
    b_response: string;
    rationale: string | null;
    channel: string;
    created_at: string;
    updated_at: string;
    person_a: PersonRef;
    person_b: PersonRef;
    match: { id: string; score: number | null; direction: string; status: string } | null;
  };
  conversations: Array<{
    id: string;
    purpose: string;
    state: string;
    subject: string | null;
    thread_id: string | null;
    created_at: string;
  }>;
  steps: Step[];
}
