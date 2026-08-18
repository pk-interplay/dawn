import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchGmailActivity,
  type CalendarEventAttendees,
  type Deadline,
  type GmailActivity,
  type ReadProgress,
  type GmailHeaderSet,
} from "./gmail-ingest";
import {
  createPersonEntities,
  findOrCreateEntity,
  loadEmailIndex,
  projectDisplayName,
  projectDisplayNames,
  writeClaim,
  writeClaims,
  type ClaimInput,
} from "./claims";

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
  /** True when a budget stopped the run early, so the graph is a subset of the mailbox. */
  truncated: boolean;
}

/** How many rows to put in one insert/upsert. Big enough to be a handful of round
 *  trips over a large mailbox, small enough that one failed chunk loses little. */
const WRITE_CHUNK = 500;

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
  opts: {
    onContact?: (contact: { name: string; email: string }) => void;
    /**
     * Handed the mailbox read this ingest just performed. Gmail's per-minute quota
     * is per user, and a six-month read is most of that minute — so a caller that
     * also needs the same headers (profile synthesis, right after this) takes them
     * from here instead of reading the mailbox a second time.
     */
    onActivity?: (activity: GmailActivity) => void;
    /** Progress through the graph write, for callers showing a live status. */
    onWriteProgress?: (written: number, total: number) => void;
    /** Progress through the mailbox read — the longest and most paced phase. */
    onReadProgress?: ReadProgress;
    /**
     * Wall-clock ceiling for the whole ingest, as epoch ms. Past it the run stops and
     * returns `truncated: true` rather than continuing into a caller that has already
     * run out of time to report the result.
     */
    deadline?: Deadline;
    /**
     * Narrows the Gmail read. The shallow onboarding ingest passes the last 30
     * days; the 6-month remainder is the backfill cron's job. Calendar always
     * reads its full default window — it is cheap and not the latency problem.
     */
    window?: { after: Date; before?: Date };
    /** Fires when the calendar leg finishes — the two legs run concurrently, so
     *  this is the only way a caller can tick "calendar" off before the Gmail
     *  read completes. */
    onCalendarDone?: (events: CalendarEventAttendees[]) => void;
  } = {},
): Promise<IngestSummary> {
  const { onContact, onActivity, onWriteProgress, onReadProgress, deadline, window, onCalendarDone } =
    opts;
  const you = youEmail.toLowerCase();

  // Surface each real correspondent the moment its header batch arrives, so the
  // onboarding screen can stream names in during the fetch rather than staring at a
  // spinner. Never leaks message content — only the From/To/Cc display names, which
  // is exactly what the ingest already keys on.
  const onBatch = onContact
    ? (batch: GmailHeaderSet[]) => {
        for (const h of batch) {
          for (const addr of [
            ...splitAddresses(h.from),
            ...splitAddresses(h.to),
            ...splitAddresses(h.cc),
          ]) {
            if (addr.email !== you) onContact({ name: addr.name, email: addr.email });
          }
        }
      }
    : undefined;

  // Quota window keyed by the user, not the token — see quotaWindowFor().
  const activity = await fetchGmailActivity(accessToken, {
    onBatch,
    deadline,
    onProgress: onReadProgress,
    quotaKey: you,
    window,
    onCalendarDone,
  });
  onActivity?.(activity);

  return writeActivityToGraph(client, youEmail, activity, {
    mode: "snapshot",
    deadline,
    onWriteProgress,
  });
}

/**
 * The aggregate-and-write half of the ingest, split from the mailbox read so
 * the incremental sync (gmail-sync.ts) can feed it a history DELTA instead of a
 * full six-month snapshot.
 *
 * `mode` decides what an edge write means:
 *  - "snapshot": the activity IS the full lookback window, so the computed
 *    strength simply replaces whatever the edge had (the original behavior).
 *  - "incremental": the activity is only what changed since the last sync, so
 *    the new strength is the prior strength decayed to now PLUS the delta —
 *    letting a raw delta overwrite the edge would clobber six months of signal
 *    with one afternoon's email.
 */
export async function writeActivityToGraph(
  client: SupabaseClient,
  youEmail: string,
  activity: GmailActivity,
  opts: {
    mode: "snapshot" | "incremental";
    deadline?: Deadline;
    onWriteProgress?: (written: number, total: number) => void;
  },
): Promise<IngestSummary> {
  const { mode, deadline, onWriteProgress } = opts;
  const you = youEmail.toLowerCase();
  const outOfTime = () => deadline !== undefined && Date.now() >= deadline;
  const { headers, events } = activity;

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
  let truncated = false;
  const failures: string[] = [];

  const entries = [...contacts.entries()];
  const total = entries.length;
  onWriteProgress?.(0, total);

  /**
   * Everything below is written in bulk, and that is the difference between an ingest
   * that finishes and one that gets killed.
   *
   * It used to be a loop over contacts doing six sequential Supabase round trips each —
   * resolve, claim email, claim name, project the display name (two more), upsert the
   * edge. At a wholly ordinary ~50ms per trip that is ~300ms per contact, so a mailbox
   * with a thousand correspondents spent five minutes here on its own, after a paced
   * Gmail read that had already taken over a minute. The route's ceiling is 300s. It
   * never stood a chance, and because the write is incremental the user was left with a
   * half-built graph and a spinner that never resolved.
   *
   * Same rows, same conflict keys, same append-only claim semantics — a few round trips
   * per five hundred contacts instead of six per contact.
   */

  // One query for every email already in the graph, instead of one lookup per contact.
  const emailIndex = await loadEmailIndex(client);

  const known = new Map<string, string>();
  const missing: string[] = [];
  for (const [email] of entries) {
    const existing = emailIndex.get(email);
    if (existing) known.set(email, existing);
    else missing.push(email);
  }

  // Create the entities that do not exist yet, then immediately claim their addresses.
  // The claim is not optional: an entity with no email claim cannot be resolved, so the
  // next ingest makes a second one for the same person — the split-identity bug called
  // out in findOrCreateEntity.
  for (let i = 0; i < missing.length; i += WRITE_CHUNK) {
    const chunk = missing.slice(i, i + WRITE_CHUNK);
    try {
      const ids = await createPersonEntities(client, chunk.length);
      const identityClaims: ClaimInput[] = [];
      chunk.forEach((email, index) => {
        const entityId = ids[index];
        if (!entityId) return;
        known.set(email, entityId);
        identityClaims.push({
          subjectId: entityId,
          attribute: "email",
          value: email,
          source: "identity",
          method: "self_reported",
          confidence: 1,
          observedAt: new Date().toISOString(),
          evidence: "Address this entity was created from.",
        });
      });
      const { failed } = await writeClaims(client, identityClaims);
      for (const f of failed) {
        // An unclaimed new entity is worse than no entity: drop it from this run so the
        // next one resolves the address properly instead of writing to a ghost.
        const email = f.input.value as string;
        known.delete(email);
        failures.push(`${email}: could not claim address — ${f.error}`);
      }
    } catch (err) {
      for (const email of chunk) {
        failures.push(`${email}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Incremental mode folds new activity into the existing edge instead of
  // replacing it: read the prior strength for every touched contact (the delta
  // set is small), decay it to now, and add the delta's contribution.
  const priorEdges = new Map<string, { strength: number | null; observed_at: string | null }>();
  if (mode === "incremental" && known.size) {
    const ids = [...known.values()];
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const { data, error } = await client
        .from("edges")
        .select("to_id, strength, observed_at")
        .eq("from_id", yourEntityId)
        .eq("kind", "knows")
        .eq("source", `gmail:${you}`)
        .in("to_id", ids.slice(i, i + WRITE_CHUNK));
      if (error) {
        failures.push(`prior edges read at ${i}: ${error.message}`);
        break;
      }
      for (const row of data ?? []) {
        priorEdges.set(row.to_id as string, {
          strength: row.strength as number | null,
          observed_at: row.observed_at as string | null,
        });
      }
    }
  }

  // The observation claims for this run, and the edges. Built in memory, written in
  // chunks, and counted only for contacts that actually have an entity to hang off.
  const observationClaims: ClaimInput[] = [];
  const edgeRows: Record<string, unknown>[] = [];

  for (const [email, c] of entries) {
    const entityId = known.get(email);
    if (!entityId) continue;
    const observedAt = new Date(c.lastInteractionAt).toISOString();

    observationClaims.push({
      subjectId: entityId,
      attribute: "email",
      value: email,
      source: `gmail:${you}`,
      method: "inferred",
      confidence: 0.9,
      observedAt,
    });
    if (c.name && c.name !== email) {
      observationClaims.push({
        subjectId: entityId,
        attribute: "name",
        value: c.name,
        source: `gmail:${you}`,
        method: "inferred",
        confidence: 0.7,
        observedAt,
      });
    }

    const rawScore = c.emailCount + c.meetingCount * MEETING_WEIGHT;
    const deltaStrength = rawScore * recencyWeight(c.lastInteractionAt);
    // Snapshot: the delta IS the whole window; carried is zero and this reduces
    // to the original formula. Incremental: decay the prior to now, then add.
    const prior = priorEdges.get(entityId);
    const carried =
      prior?.strength != null && prior.observed_at
        ? prior.strength * recencyWeight(Date.parse(prior.observed_at))
        : 0;
    // An incremental delta can be OLDER than the edge (the backfill feeds
    // months-old mail). The edge's observed_at must never regress: it is the
    // decay anchor, and letting old mail rewind it would make the next pass
    // decay the combined strength as if the recent signal were months stale.
    const priorMs = prior?.observed_at ? Date.parse(prior.observed_at) : 0;
    const edgeObservedAt =
      mode === "incremental" && priorMs > c.lastInteractionAt
        ? (prior!.observed_at as string)
        : observedAt;
    edgeRows.push({
      from_id: yourEntityId,
      to_id: entityId,
      kind: "knows",
      strength: Math.min(1, carried + deltaStrength),
      source: `gmail:${you}`,
      observed_at: edgeObservedAt,
    });
    entitiesTouched += 1;
  }

  for (let i = 0; i < observationClaims.length; i += WRITE_CHUNK) {
    // A chunk that fails degrades to per-row inserts inside writeClaims, so one bad
    // value costs itself and not the other 499 — the posture the serial loop had.
    const { written, failed } = await writeClaims(
      client,
      observationClaims.slice(i, i + WRITE_CHUNK),
    );
    claimsWritten += written.length;
    for (const f of failed) failures.push(`${String(f.input.value)}: ${f.error}`);
  }

  for (let i = 0; i < edgeRows.length; i += WRITE_CHUNK) {
    const chunk = edgeRows.slice(i, i + WRITE_CHUNK);
    const { error } = await client
      .from("edges")
      .upsert(chunk, { onConflict: "from_id,to_id,kind,source" });
    if (error) {
      failures.push(`edges chunk at ${i}: ${error.message}`);
    } else {
      edgesWritten += chunk.length;
    }
    onWriteProgress?.(Math.min(i + chunk.length, total), total);
    if (outOfTime()) {
      truncated = true;
      failures.push("stopped early: ran out of time before every edge was written");
      break;
    }
  }

  // Last, and in bulk: the denormalised display name. Skipping the rows that already
  // agree with their claims makes a re-ingest nearly free here.
  try {
    await projectDisplayNames(client, [...known.values()]);
  } catch (err) {
    // A stale display_name is cosmetic and rebuildable from claims at any time; it must
    // not cost the run the graph it just wrote.
    failures.push(`display names: ${err instanceof Error ? err.message : String(err)}`);
  }

  onWriteProgress?.(total, total);
  return { entitiesTouched, edgesWritten, claimsWritten, failures, truncated };
}
