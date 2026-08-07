import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchRecentCalendarEvents, fetchRecentGmailHeaders } from "./gmail-ingest";
import { findOrCreateEntity, projectDisplayName, writeClaim } from "./claims";

/**
 * Nexus v0.2 build step 2 (SPEC.md §2.3, §7). Ported from nexus's
 * src/lib/relationships.ts::aggregateContacts, adapted to write the claims
 * graph instead of upserting a `contacts` row: each contact becomes an
 * `entities` row (resolved by email, never auto-merged by name — see
 * findOrCreateEntity), an `email` claim, and an `edges` row from the
 * ingesting user's own entity to theirs.
 *
 * Decay math is kept exactly as nexus computed it inline (MEETING_WEIGHT=3,
 * 90-day half-life) rather than switching to dawn-v0's SQL-side
 * recompute_relationship_strength() (migration 0008) — that function operates
 * on the `relationships`/`interactions` tables, not `edges`, and SPEC's
 * freshness/decay cron (build step 6) is the point where periodic decay
 * belongs; computing it twice here would be redundant, not more correct.
 */

const MEETING_WEIGHT = 3;
const RECENCY_HALF_LIFE_DAYS = 90;

interface ContactAccum {
  name: string;
  emailCount: number;
  meetingCount: number;
  lastInteractionAt: number;
}

/**
 * Parses a "Name <email@x.com>" style header value into an address + display
 * name. Two separate patterns, not one combined regex with an optional name
 * group: nexus's original single-regex version (`(?:"?([^"<]*)"?\s*)?<?...`)
 * greedily matches the name group even with no `<...>` present at all, so a
 * bare "ava@example.com" backtracks into `{ name: "av", email: "a@example.com" }`
 * — caught by network-ingest.test.ts before this ever reached a real ingest run.
 */
export function parseAddress(raw: string): { email: string; name: string } | null {
  const withName = raw.match(/^\s*"?([^"<]*)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (withName) {
    const email = withName[2].toLowerCase();
    return { email, name: withName[1].trim() || email };
  }
  const bare = raw.match(/^\s*([^<>\s]+@[^<>\s]+)\s*$/);
  if (bare) {
    const email = bare[1].toLowerCase();
    return { email, name: email };
  }
  return null;
}

export function splitAddresses(raw?: string): { email: string; name: string }[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => parseAddress(part))
    .filter((a): a is { email: string; name: string } => a !== null);
}

export function recencyWeight(timestampMs: number): number {
  const ageDays = (Date.now() - timestampMs) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, Math.max(ageDays, 0) / RECENCY_HALF_LIFE_DAYS);
}

export interface IngestSummary {
  entitiesTouched: number;
  edgesWritten: number;
  claimsWritten: number;
  failures: string[];
}

/**
 * Fetches Gmail + Calendar activity for `youEmail` and writes it into the
 * claims graph: one entity + one email claim per contact, one `knows` edge
 * from the ingesting user's entity to each contact, keyed on `source` so
 * re-running ingest against the same mailbox upserts rather than duplicates.
 */
export async function ingestGmailNetwork(
  client: SupabaseClient,
  accessToken: string,
  youEmail: string,
): Promise<IngestSummary> {
  const [headers, events] = await Promise.all([
    fetchRecentGmailHeaders(accessToken),
    fetchRecentCalendarEvents(accessToken),
  ]);

  const you = youEmail.toLowerCase();
  const contacts = new Map<string, ContactAccum>();

  const touch = (email: string, name: string, kind: "email" | "meeting", whenMs: number) => {
    if (email === you) return; // skip self
    const existing = contacts.get(email) ?? { name, emailCount: 0, meetingCount: 0, lastInteractionAt: 0 };
    if (kind === "email") existing.emailCount += 1;
    else existing.meetingCount += 1;
    existing.lastInteractionAt = Math.max(existing.lastInteractionAt, whenMs);
    // Prefer a real display name over a bare email if we find one later.
    if (name !== email && (existing.name === email || !existing.name)) existing.name = name;
    contacts.set(email, existing);
  };

  for (const header of headers) {
    const whenMs = header.date ? Date.parse(header.date) : Date.now();
    for (const addr of [...splitAddresses(header.from), ...splitAddresses(header.to), ...splitAddresses(header.cc)]) {
      touch(addr.email, addr.name, "email", whenMs);
    }
  }
  for (const event of events) {
    const whenMs = event.start ? Date.parse(event.start) : Date.now();
    for (const attendee of event.attendees) {
      const email = attendee.email?.toLowerCase();
      if (!email) continue;
      touch(email, attendee.displayName || email, "meeting", whenMs);
    }
  }

  const yourEntityId = await findOrCreateEntity(client, { kind: "person", matchHint: { email: you } });
  await writeClaim(client, {
    subjectId: yourEntityId,
    attribute: "email",
    value: you,
    source: `gmail:${you}`,
    method: "self_reported",
    confidence: 1,
    observedAt: new Date().toISOString(),
  });
  await projectDisplayName(client, yourEntityId);

  let entitiesTouched = 0;
  let edgesWritten = 0;
  let claimsWritten = 0;
  const failures: string[] = [];

  for (const [email, c] of contacts.entries()) {
    try {
      const entityId = await findOrCreateEntity(client, { kind: "person", matchHint: { email } });
      await writeClaim(client, {
        subjectId: entityId,
        attribute: "email",
        value: email,
        source: `gmail:${you}`,
        method: "inferred",
        confidence: 0.9,
        observedAt: new Date(c.lastInteractionAt).toISOString(),
      });
      if (c.name && c.name !== email) {
        await writeClaim(client, {
          subjectId: entityId,
          attribute: "name",
          value: c.name,
          source: `gmail:${you}`,
          method: "inferred",
          confidence: 0.7,
          observedAt: new Date(c.lastInteractionAt).toISOString(),
        });
      }
      await projectDisplayName(client, entityId);

      const rawScore = c.emailCount + c.meetingCount * MEETING_WEIGHT;
      const strength = Math.min(1, rawScore * recencyWeight(c.lastInteractionAt));
      const { error: edgeError } = await client.from("edges").upsert(
        {
          from_id: yourEntityId,
          to_id: entityId,
          kind: "knows",
          strength,
          source: `gmail:${you}`,
          observed_at: new Date(c.lastInteractionAt).toISOString(),
        },
        { onConflict: "from_id,to_id,kind,source" },
      );
      if (edgeError) throw new Error(edgeError.message);

      entitiesTouched += 1;
      edgesWritten += 1;
      claimsWritten += c.name && c.name !== email ? 2 : 1;
    } catch (err) {
      // One bad contact must not abort the rest of the sync — same posture as
      // intro-flow.ts's send batch: a malformed header shouldn't cost every
      // other contact in the same run its claims/edge.
      failures.push(`${email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { entitiesTouched, edgesWritten, claimsWritten, failures };
}
