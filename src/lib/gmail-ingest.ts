/**
 * Nexus v0.2 build step 2 (SPEC.md §3.4, §7). Ported from nexus's
 * src/lib/google.ts, with one deliberate change: nexus's fetchRecentGmailHeaders
 * actually calls Gmail with `format=full` and decodes/truncates the body
 * (confirmed in the source it was ported from) — this port switches to
 * `format=metadata` and drops body extraction entirely. Metadata-only is the
 * default path for this step (SPEC: "ListThreads/SearchThreads return
 * metadata-only rows by default, so this is the default path, not a
 * workaround"); body content and extract_claims are step 4, not this one.
 */

/** How far back to look for emails/meetings. Keeps latency and API usage bounded. */
const LOOKBACK_MONTHS = 6;
/**
 * How many message-metadata fetches to run concurrently. Gmail enforces a
 * per-user *concurrency* limit (distinct from the per-second quota) and rejects
 * excess simultaneous requests with 429 "Too many concurrent requests for user"
 * (reason: rateLimitExceeded). 20 tripped it reliably; a handful in flight at
 * once stays comfortably under. Transient bursts are absorbed by the backoff in
 * googleFetch rather than by cranking this back up.
 */
const BATCH_SIZE = 5;
/** Max attempts per request before giving up (1 initial + retries). */
const MAX_ATTEMPTS = 5;

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

function lookbackDate(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - LOOKBACK_MONTHS);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function googleFetch(token: string, url: string) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return res.json();

    // 429 (rate/concurrency) and 5xx are transient — back off and retry. Everything
    // else (401 expired token, 403 scope, 404) is terminal and re-raised immediately.
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= MAX_ATTEMPTS) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API request failed (${res.status}): ${url}\n${body}`);
    }

    // Honor Retry-After when Google sends it; otherwise exponential backoff with
    // jitter (0.5s, 1s, 2s, 4s …) so a batch's retries don't resynchronize into
    // another concurrency spike.
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await sleep(backoff);
  }
}

/** Lists recent Gmail messages and returns just the headers we need (From/To/Cc/Date/Subject).
 * Metadata-only: no message body is fetched or stored.
 *
 * `onBatch` (optional) is called with each batch of headers as it comes back from
 * Gmail, so a caller can surface ingest progress live (e.g. the onboarding ticker)
 * instead of waiting for the whole lookback window to page in. */
export async function fetchRecentGmailHeaders(
  token: string,
  onBatch?: (batch: GmailHeaderSet[]) => void,
): Promise<GmailHeaderSet[]> {
  const after = Math.floor(lookbackDate().getTime() / 1000);

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", `after:${after}`);
  listUrl.searchParams.set("maxResults", "500"); // Gmail API's own per-page max

  // Page through every message in the lookback window rather than stopping at
  // a fixed count — an inbox full of inbound/automated mail can otherwise crowd
  // out the user's own sent messages almost entirely within a small fixed cap.
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
    const list = await googleFetch(token, listUrl.toString());
    ids.push(...(list.messages ?? []).map((m: { id: string }) => m.id));
    pageToken = list.nextPageToken;
  } while (pageToken);

  const headers: GmailHeaderSet[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (id) => {
        const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
        msgUrl.searchParams.set("format", "metadata");
        msgUrl.searchParams.append("metadataHeaders", "From");
        msgUrl.searchParams.append("metadataHeaders", "To");
        msgUrl.searchParams.append("metadataHeaders", "Cc");
        msgUrl.searchParams.append("metadataHeaders", "Date");
        msgUrl.searchParams.append("metadataHeaders", "Subject");
        const msg = await googleFetch(token, msgUrl.toString());
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
  }
  return headers;
}

/** Lists recent Calendar events on the primary calendar with their attendees.
 * Already metadata-only — no event descriptions are fetched. */
export async function fetchRecentCalendarEvents(token: string): Promise<CalendarEventAttendees[]> {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", lookbackDate().toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("orderBy", "startTime");

  const events: CalendarEventAttendees[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleFetch(token, url.toString());
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
  } while (pageToken && events.length < 500);

  return events;
}
