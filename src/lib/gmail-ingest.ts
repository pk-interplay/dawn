/**
 * Nexus v0.2 build step 2 (SPEC.md §3.4, §7). Ported from nexus's
 * src/lib/google.ts, with one deliberate change: nexus's fetchRecentGmailHeaders
 * actually calls Gmail with `format=full` and decodes/truncates the body
 * (confirmed in the source it was ported from) — this port switches to
 * `format=metadata` and drops body extraction entirely. Metadata-only is the
 * default path for this step (SPEC: "ListThreads/SearchThreads return
 * metadata-only rows by default, so this is the default path, not a
 * workaround"); body content and extract_claims are step 4, not this one.
 *
 * Quota is the binding constraint here, not latency. Gmail bills every call in
 * "quota units" against a *per-user, per-minute* budget of 15,000 (see
 * QUOTA_LIMIT_UNITS). messages.get costs 5 units, so 3,000 header fetches in one
 * minute exhausts a user's entire minute — which a six-month mailbox reaches in
 * seconds if you just fan out as fast as the network allows. Three things keep
 * this inside the budget, and all three are load-bearing:
 *   1. Every ingest run gets a hard ceiling of MAX_UNITS_PER_RUN units for one
 *      user — one minute's worth of quota, total. When it runs out the run stops
 *      and returns what it has; it never keeps spending into a 403.
 *   2. QuotaWindow paces that spend to QUOTA_BUDGET_UNITS/minute per mailbox, so
 *      the ceiling is approached over ~75 seconds rather than in one burst.
 *   3. googleFetch treats a quota 403 as retriable (it is *not* a permission
 *      error) and pauses the whole window when one lands.
 * Sent mail is listed and fetched before received, so a flood of inbound cannot
 * crowd the user's own sent mail out of the budget (the failure mode a single
 * undifferentiated cap caused before).
 */

/** How far back to look for emails/meetings. Keeps latency and API usage bounded. */
const LOOKBACK_MONTHS = 6;
/**
 * How many message-metadata fetches to run concurrently. Gmail enforces a
 * per-user *concurrency* limit (distinct from the per-minute quota) and rejects
 * excess simultaneous requests with 429 "Too many concurrent requests for user"
 * (reason: rateLimitExceeded). 20 tripped it reliably.
 *
 * This is the ingest's real latency knob, and it is safe to raise now in a way it
 * was not before: QuotaWindow caps the sustained *rate* and googleFetch retries a
 * concurrency 429 with backoff, so overshooting costs a retry rather than a failed
 * run. A measured run spent 2,955 of 15,000 units on 588 messages — nowhere near
 * the per-minute ceiling — so the round trips, not the quota, were the wait. 15
 * keeps a margin under the 20 that broke; drop it if 429s start appearing in the
 * `[gmail-ingest]` logs.
 */
const BATCH_SIZE = 15;
/** Max attempts per request before giving up (1 initial + retries). */
const MAX_ATTEMPTS = 5;

/**
 * How long one Google request may take before we give up on it.
 *
 * `fetch` has no default timeout, so without this a connection that opens and then
 * stops delivering hangs until the platform kills the whole function — which, for a
 * streaming caller, is indistinguishable from the work being slow and takes the
 * caller's chance to report anything down with it.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The longest we will honour a `Retry-After` or wait out a quota penalty.
 *
 * Google is free to ask for a five-minute stand-down; we are not free to give it one.
 * `quota.pause` applies the same interval to every in-flight worker for this mailbox,
 * so an uncapped value parks the entire run — and the run has a caller waiting on it
 * with a budget of its own. Past this point, failing the request is the better answer
 * than blocking on it.
 */
const MAX_BACKOFF_MS = 30_000;

/** Gmail's published quota cost per call, in units. */
const UNITS_MESSAGES_LIST = 5;
const UNITS_MESSAGES_GET = 5;

/** Google's per-project, per-user, per-minute ceiling. Documented, not enforced by us. */
const QUOTA_LIMIT_UNITS = 15_000;
/**
 * What we allow ourselves per minute per mailbox. 80% of the ceiling: the headroom
 * covers retries, a second request for the same user landing on this instance, and
 * the fact that Google's minute and ours are not the same minute.
 */
const QUOTA_BUDGET_UNITS = Math.floor(QUOTA_LIMIT_UNITS * 0.8);
const QUOTA_WINDOW_MS = 60_000;
/** How long to stand down after Google tells us we blew the per-minute budget anyway. */
const QUOTA_PENALTY_MS = 10_000;

/**
 * The hard ceiling on what one ingest run may spend for one user: 15,000 quota
 * units — exactly one minute of that user's Google budget. At 5 units per
 * messages.get that is ~3,000 messages, and paced at QUOTA_BUDGET_UNITS/minute it
 * takes ~75 seconds, which fits inside the routes' maxDuration with room left for
 * synthesis. When the budget runs out the run stops and returns what it has.
 */
const MAX_UNITS_PER_RUN = 15_000;
/**
 * The share of a run's budget sent mail may claim before received mail is listed.
 * Sent is the high-signal half — it is what the profile is written from — and is
 * usually far smaller, so it goes first and takes what it needs up to this share;
 * received mail then spends whatever is left.
 */
const SENT_UNIT_SHARE = 0.4;

/**
 * Inbound categories that are never network signal: bulk marketing, social
 * notifications, mailing-list traffic, and Google Chat. Excluding them in the
 * query (rather than fetching and discarding) is the cheapest quota win available
 * — on a busy mailbox it is most of the volume.
 */
const RECEIVED_EXCLUSIONS =
  "-in:sent -in:chats -in:draft -category:promotions -category:social -category:forums";

export interface GmailHeaderSet {
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  subject?: string;
  /** Gmail's own message id. */
  gmailMessageId?: string;
  gmailThreadId?: string;
}

export interface CalendarEventAttendees {
  start?: string;
  summary?: string;
  attendees: { email: string; displayName?: string }[];
}

/**
 * One mailbox read: Gmail headers plus Calendar events. Bundled because both the
 * graph ingest and profile synthesis need the same read, and fetching it twice for
 * one user is what put us over the per-minute quota in the first place. Callers
 * that need both pass this between them rather than re-reading the mailbox.
 */
export interface GmailActivity {
  headers: GmailHeaderSet[];
  events: CalendarEventAttendees[];
}

/**
 * Where the mailbox read has got to, for a caller showing a live status.
 *
 * The read is the longest phase of onboarding and it is paced deliberately — the
 * quota window blocks whole batches for up to a minute at a time — so without a
 * running count the screen has nothing to say for minutes and looks hung when it is
 * merely waiting its turn.
 */
export interface ReadProgressUpdate {
  phase: "sent" | "received";
  fetched: number;
  total: number;
}

export type ReadProgress = (update: ReadProgressUpdate) => void;

function lookbackDate(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - LOOKBACK_MONTHS);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A wall-clock ceiling for the whole read, as an epoch-ms timestamp.
 *
 * The quota machinery below bounds how much a run may *spend*; this bounds how long it
 * may *take*. They are different limits and a run can hit either: pacing 15,000 units at
 * 12,000/minute takes over a minute on its own, and the caller's own budget may be
 * shorter than that. Everything that loops checks this so the read ends by returning
 * less rather than by being killed.
 */
export type Deadline = number | undefined;

const expired = (deadline: Deadline): boolean => deadline !== undefined && Date.now() >= deadline;

/** Milliseconds left, or Infinity when the caller set no deadline. */
const timeLeft = (deadline: Deadline): number =>
  deadline === undefined ? Infinity : deadline - Date.now();

/** Why a Google call failed, and therefore whether retrying it can help. */
export type GoogleFailureKind = "quota" | "rate" | "transient" | "terminal";

/**
 * A 403 from Google is usually terminal (missing scope, revoked grant) but the
 * per-minute quota rejection arrives as a 403 too — `"status": "PERMISSION_DENIED"`
 * with `"reason": "rateLimitExceeded"` in `usageLimits`. Retrying that one is
 * correct; the previous version of this file classified it as terminal, so the
 * first time a mailbox outran its minute the entire ingest failed outright.
 */
const QUOTA_BODY_PATTERN = /rateLimitExceeded|RATE_LIMIT_EXCEEDED|usageLimits|Quota exceeded/i;

export function classifyGoogleFailure(status: number, body: string): GoogleFailureKind {
  if (status === 429) return "rate";
  if (status === 403 && QUOTA_BODY_PATTERN.test(body)) return "quota";
  if (status >= 500) return "transient";
  return "terminal";
}

/**
 * A sliding one-minute window of quota spend for a single mailbox. `spend` resolves
 * only once the requested units fit under QUOTA_BUDGET_UNITS, so concurrent workers
 * self-pace instead of racing to the ceiling.
 */
export class QuotaWindow {
  private spends: { at: number; units: number }[] = [];
  private pausedUntil = 0;

  constructor(
    private readonly budget = QUOTA_BUDGET_UNITS,
    private readonly windowMs = QUOTA_WINDOW_MS,
  ) {}

  /** Units currently counted against the window, for tests and logging. */
  spentInWindow(now = Date.now()): number {
    this.prune(now);
    return this.spends.reduce((total, s) => total + s.units, 0);
  }

  /** Stand every worker down for `ms` — used when Google rejects us despite the budget. */
  pause(ms: number, now = Date.now()): void {
    this.pausedUntil = Math.max(this.pausedUntil, now + ms);
  }

  /** How long a caller must wait before `units` fit. 0 means "go now". */
  waitFor(units: number, now = Date.now()): number {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    this.prune(now);
    const spent = this.spends.reduce((total, s) => total + s.units, 0);
    if (spent + units <= this.budget) return 0;
    // The oldest spend is the first one to fall out of the window and free room.
    const oldest = this.spends[0];
    return oldest ? oldest.at + this.windowMs - now : 0;
  }

  /** Records the spend immediately — a request that will be made is a request that counts. */
  record(units: number, now = Date.now()): void {
    this.spends.push({ at: now, units });
  }

  async spend(units: number): Promise<void> {
    for (;;) {
      const wait = this.waitFor(units);
      if (wait <= 0) {
        this.record(units);
        return;
      }
      // +25ms so we wake up just after the window has actually moved on.
      await sleep(wait + 25);
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.spends.length > 0 && this.spends[0].at <= cutoff) this.spends.shift();
  }
}

/**
 * The quota units one ingest run may spend for one user. Distinct from QuotaWindow:
 * the window controls the *rate* (units per minute) and blocks until there is room;
 * the budget is a *total* and never blocks — callers ask `canAfford` before issuing
 * another call and stop when the answer is no.
 *
 * `charge` is unconditional so retries inside googleFetch are counted honestly
 * rather than silently exempted. That admits a bounded overshoot — the in-flight
 * batch can finish its retries after the budget is technically spent, at most
 * BATCH_SIZE × MAX_ATTEMPTS × 5 units past the line — which is why the ceiling is a
 * ceiling on the run's *work*, not a promise about its last few requests.
 */
export class RunBudget {
  private spent = 0;

  constructor(private readonly total = MAX_UNITS_PER_RUN) {}

  remaining(): number {
    return Math.max(0, this.total - this.spent);
  }

  spentUnits(): number {
    return this.spent;
  }

  canAfford(units: number): boolean {
    return this.spent + units <= this.total;
  }

  charge(units: number): void {
    this.spent += units;
  }
}

/**
 * One window per mailbox, keyed by access token. The quota is per user, so a
 * shared window would throttle unrelated users against each other. Tokens rotate
 * on refresh (a rotated token starts with a fresh window — absorbed by the 20%
 * headroom), so the map is capped and evicted oldest-first rather than grown.
 */
const QUOTA_WINDOW_LIMIT = 32;
const quotaWindows = new Map<string, QuotaWindow>();

function quotaWindowFor(token: string): QuotaWindow {
  const existing = quotaWindows.get(token);
  if (existing) {
    // Re-insert so iteration order tracks recency for the eviction below.
    quotaWindows.delete(token);
    quotaWindows.set(token, existing);
    return existing;
  }
  const created = new QuotaWindow();
  quotaWindows.set(token, created);
  if (quotaWindows.size > QUOTA_WINDOW_LIMIT) {
    const oldest = quotaWindows.keys().next();
    if (!oldest.done) quotaWindows.delete(oldest.value);
  }
  return created;
}

async function googleFetch(
  token: string,
  url: string,
  units: number,
  budget?: RunBudget,
  deadline?: Deadline,
) {
  const quota = quotaWindowFor(token);

  for (let attempt = 1; ; attempt++) {
    await quota.spend(units);
    budget?.charge(units);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      // Bounded so a stalled connection fails this request instead of the whole run.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return res.json();

    const body = await res.text().catch(() => "");
    const kind = classifyGoogleFailure(res.status, body);
    if (kind === "terminal" || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Google API request failed (${res.status}): ${url}\n${body}`);
    }

    // Honor Retry-After when Google sends it. Otherwise: a blown per-minute quota
    // needs to wait out a chunk of that minute (seconds, not milliseconds), while a
    // concurrency 429 or a 5xx clears almost immediately. Jitter keeps a batch's
    // retries from resynchronizing into another spike.
    const retryAfter = Number(res.headers.get("retry-after"));
    let backoff: number;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      backoff = retryAfter * 1000;
    } else if (kind === "quota") {
      backoff = QUOTA_PENALTY_MS * attempt;
    } else {
      backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    }
    // Google's asks are advisory; the caller's deadline is not. Capping here bounds
    // both this sleep and the `quota.pause` below it, which would otherwise stand the
    // whole mailbox down for as long as Google felt like naming.
    backoff = Math.min(backoff, MAX_BACKOFF_MS);

    // No point sleeping past the deadline only to fail after it: give up now and let the
    // caller report what it already has.
    if (backoff >= timeLeft(deadline)) {
      throw new Error(
        `Google API request failed (${res.status}) and the retry does not fit in the remaining time budget`,
      );
    }

    if (kind === "quota") {
      // Our accounting says we had room and Google disagreed, so our window is the
      // thing that is wrong. Stand every in-flight worker down for the same interval
      // instead of letting each one discover the rejection on its own.
      quota.pause(backoff);
      console.warn(
        `[gmail-ingest] per-minute quota exceeded; pausing this mailbox for ${Math.round(backoff / 1000)}s`,
      );
    }
    await sleep(backoff);
  }
}

/**
 * Pages users.messages.list for one query and returns up to `cap` message ids,
 * newest first (Gmail's own ordering). Stops early if the run budget cannot afford
 * another page. Logs when either limit truncates the result — a silently truncated
 * ingest reads as a complete one.
 */
async function listMessageIds(
  token: string,
  budget: RunBudget,
  q: string,
  cap: number,
  label: string,
  deadline?: Deadline,
) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let truncatedBy: "cap" | "budget" | "time" | null = null;

  do {
    if (!budget.canAfford(UNITS_MESSAGES_LIST)) {
      truncatedBy = "budget";
      break;
    }
    if (expired(deadline)) {
      truncatedBy = "time";
      break;
    }

    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", q);
    // Never ask for more than we can still keep. Gmail's own per-page max is 500.
    url.searchParams.set("maxResults", String(Math.min(500, cap - ids.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const page = await googleFetch(token, url.toString(), UNITS_MESSAGES_LIST, budget, deadline);
    ids.push(...(page.messages ?? []).map((m: { id: string }) => m.id));
    pageToken = page.nextPageToken;

    if (ids.length >= cap) {
      if (pageToken) truncatedBy = "cap";
      break;
    }
  } while (pageToken);

  if (truncatedBy) {
    const why =
      truncatedBy === "cap"
        ? "direction's share of the run budget"
        : truncatedBy === "budget"
          ? "run budget exhausted"
          : "time budget exhausted";
    console.info(
      `[gmail-ingest] ${label}: stopped listing at ${ids.length} messages (${why}; more exist in the ${LOOKBACK_MONTHS}-month window)`,
    );
  }
  return ids.slice(0, cap);
}

/**
 * Fetches header metadata for a list of message ids, BATCH_SIZE at a time, and
 * stops as soon as the run budget can no longer afford a batch. Returns what it
 * managed to fetch — a short run is a smaller graph, not a failed one.
 */
async function fetchHeaders(
  token: string,
  budget: RunBudget,
  ids: string[],
  label: string,
  onBatch?: (batch: GmailHeaderSet[]) => void,
  deadline?: Deadline,
  onProgress?: (fetchedInThisDirection: number, totalInThisDirection: number) => void,
): Promise<GmailHeaderSet[]> {
  const headers: GmailHeaderSet[] = [];
  onProgress?.(0, ids.length);

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    if (!budget.canAfford(batch.length * UNITS_MESSAGES_GET)) {
      console.info(
        `[gmail-ingest] ${label}: run budget exhausted after ${headers.length}/${ids.length} messages`,
      );
      break;
    }
    // A partial read still produces a usable graph, so stopping here is a smaller
    // result — not a failed run. Overrunning would cost the caller its whole reply.
    if (expired(deadline)) {
      console.info(
        `[gmail-ingest] ${label}: time budget exhausted after ${headers.length}/${ids.length} messages`,
      );
      break;
    }

    const results = await Promise.all(
      batch.map(async (id) => {
        const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
        msgUrl.searchParams.set("format", "metadata");
        msgUrl.searchParams.append("metadataHeaders", "From");
        msgUrl.searchParams.append("metadataHeaders", "To");
        msgUrl.searchParams.append("metadataHeaders", "Cc");
        msgUrl.searchParams.append("metadataHeaders", "Date");
        msgUrl.searchParams.append("metadataHeaders", "Subject");
        const msg = await googleFetch(
          token,
          msgUrl.toString(),
          UNITS_MESSAGES_GET,
          budget,
          deadline,
        );
        const get = (name: string) =>
          (msg.payload?.headers ?? []).find(
            (h: { name: string; value: string }) => h.name.toLowerCase() === name.toLowerCase(),
          )?.value as string | undefined;
        return {
          from: get("From"),
          to: get("To"),
          cc: get("Cc"),
          date: get("Date"),
          subject: get("Subject"),
          gmailMessageId: msg.id as string | undefined,
          gmailThreadId: msg.threadId as string | undefined,
        };
      }),
    );
    headers.push(...results);
    onBatch?.(results);
    onProgress?.(headers.length, ids.length);
  }

  return headers;
}

/** Lists recent Gmail messages and returns just the headers we need (From/To/Cc/Date/Subject).
 * Metadata-only: no message body is fetched or stored.
 *
 * Sent mail is listed and fetched first, then received mail spends whatever is left
 * of the run's MAX_UNITS_PER_RUN budget — so inbound volume can never crowd out the
 * user's own sent mail, and the whole run has a hard ceiling of one minute's worth
 * of that user's Gmail quota.
 *
 * `onBatch` (optional) is called with each batch of headers as it comes back from
 * Gmail, so a caller can surface ingest progress live (e.g. the onboarding ticker)
 * instead of waiting for the whole lookback window to page in. */
export async function fetchRecentGmailHeaders(
  token: string,
  onBatch?: (batch: GmailHeaderSet[]) => void,
  budget: RunBudget = new RunBudget(),
  deadline?: Deadline,
  onProgress?: ReadProgress,
): Promise<GmailHeaderSet[]> {
  const after = Math.floor(lookbackDate().getTime() / 1000);
  const seen = new Set<string>();

  // Sent is fetched before received is even listed, so the totals arrive in two parts.
  // Carrying the finished direction forward keeps the count monotonic — a progress
  // number that resets to zero halfway through reads as a restart, not as progress.
  let doneBefore = 0;
  let totalBefore = 0;
  const report = (direction: "sent" | "received") => (fetched: number, total: number) =>
    onProgress?.({
      phase: direction,
      fetched: doneBefore + fetched,
      total: totalBefore + total,
    });

  // Sent first, and interleaved list→fetch rather than listing both directions up
  // front: spending the budget in priority order is what makes "sent wins" true.
  const sentCap = Math.floor((budget.remaining() * SENT_UNIT_SHARE) / UNITS_MESSAGES_GET);
  const sentIds = await listMessageIds(
    token,
    budget,
    `in:sent after:${after}`,
    sentCap,
    "sent",
    deadline,
  );
  sentIds.forEach((id) => seen.add(id));
  const sent = await fetchHeaders(
    token,
    budget,
    sentIds,
    "sent",
    onBatch,
    deadline,
    report("sent"),
  );
  doneBefore = sent.length;
  totalBefore = sentIds.length;

  // Whatever survives the sent pass belongs to received mail.
  const receivedCap = Math.floor(budget.remaining() / UNITS_MESSAGES_GET);
  const receivedIds = (
    await listMessageIds(
      token,
      budget,
      `${RECEIVED_EXCLUSIONS} after:${after}`,
      receivedCap,
      "received",
      deadline,
    )
  ).filter((id) => !seen.has(id));
  const received = await fetchHeaders(
    token,
    budget,
    receivedIds,
    "received",
    onBatch,
    deadline,
    report("received"),
  );

  console.info(
    `[gmail-ingest] fetched ${sent.length} sent + ${received.length} received message headers using ${budget.spentUnits()}/${MAX_UNITS_PER_RUN} quota units`,
  );
  return [...sent, ...received];
}

/** Lists recent Calendar events on the primary calendar with their attendees.
 * Already metadata-only — no event descriptions are fetched. */
export async function fetchRecentCalendarEvents(
  token: string,
  deadline?: Deadline,
): Promise<CalendarEventAttendees[]> {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", lookbackDate().toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("orderBy", "startTime");

  const events: CalendarEventAttendees[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    // Calendar has its own quota, far looser than Gmail's and measured in requests
    // rather than units; the window is shared here only so one mailbox's Calendar
    // paging cannot itself become a burst.
    const page = await googleFetch(token, url.toString(), 1, undefined, deadline);
    for (const event of page.items ?? []) {
      events.push({
        start: event.start?.dateTime ?? event.start?.date,
        summary: event.summary,
        attendees: (event.attendees ?? []).map((a: { email: string; displayName?: string }) => ({
          email: a.email,
          displayName: a.displayName,
        })),
      });
    }
    pageToken = page.nextPageToken;
    // Calendar paging is cheap but not free, and it runs concurrently with the mailbox
    // read that owns most of the budget. Stop rather than push the caller over.
  } while (pageToken && events.length < 500 && !expired(deadline));

  return events;
}

/**
 * One paced read of the mailbox: Gmail headers and Calendar events together.
 * Callers that need both should call this once and pass the result around — see
 * GmailActivity.
 *
 * The two run concurrently. Calendar is a different service with its own, far
 * looser quota (measured in requests, not Gmail units), so it is neither charged
 * against the Gmail run budget nor worth serialising behind a mailbox read that
 * takes orders of magnitude longer.
 */
export async function fetchGmailActivity(
  token: string,
  onBatch?: (batch: GmailHeaderSet[]) => void,
  deadline?: Deadline,
  onProgress?: ReadProgress,
): Promise<GmailActivity> {
  const [headers, events] = await Promise.all([
    fetchRecentGmailHeaders(token, onBatch, new RunBudget(), deadline, onProgress),
    fetchRecentCalendarEvents(token, deadline),
  ]);
  return { headers, events };
}
