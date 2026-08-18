import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GmailHeaderSet } from "./gmail-ingest";

/**
 * Behaviour lock for the backfill pass — specifically the cursor discipline,
 * because every failure mode here is silent in production: a cursor that
 * advances past unwritten work loses mail forever, a cursor that never moves
 * burns a quota-minute per hour re-reading the same slice, and a pass that
 * bumps last_synced_at quietly starves the hourly sync's fan-out ordering.
 *
 * The Google reads and the graph write are mocked; what is asserted is what the
 * pass tells gmail_sync_state at the end.
 */

const mocks = vi.hoisted(() => ({
  listMessageIds: vi.fn(),
  fetchHeaders: vi.fn(),
  claimSyncRow: vi.fn(),
  releaseSyncRow: vi.fn(),
  getGoogleAccessToken: vi.fn(),
  writeActivityToGraph: vi.fn(),
}));

vi.mock("./gmail-ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gmail-ingest")>()),
  listMessageIds: mocks.listMessageIds,
  fetchHeaders: mocks.fetchHeaders,
}));
vi.mock("./gmail-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gmail-sync")>()),
  claimSyncRow: mocks.claimSyncRow,
  releaseSyncRow: mocks.releaseSyncRow,
}));
vi.mock("./google-account", () => ({
  getGoogleAccessToken: mocks.getGoogleAccessToken,
}));
vi.mock("./network-ingest", () => ({
  writeActivityToGraph: mocks.writeActivityToGraph,
}));

const { backfillGmailForAccount, nextCursor } = await import("./gmail-backfill");

const SUB = "sub-123";
const BEFORE = "2026-07-19T00:00:00.000Z";
const UNTIL = "2026-02-18T00:00:00.000Z";

/** Just enough PostgREST for the two reads the pass makes. */
function fakeClient(state: { backfill_before: string | null; backfill_until: string | null }) {
  return {
    from(table: string) {
      const row =
        table === "google_accounts"
          ? { email: "you@example.com" }
          : table === "gmail_sync_state"
            ? state
            : null;
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
        }),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function header(internalDateMs: number): GmailHeaderSet {
  return { from: "Ava <ava@example.com>", internalDateMs };
}

describe("backfillGmailForAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimSyncRow.mockResolvedValue(true);
    mocks.getGoogleAccessToken.mockResolvedValue({ ok: true, accessToken: "tok" });
    mocks.writeActivityToGraph.mockResolvedValue({
      entitiesTouched: 1,
      edgesWritten: 1,
      claimsWritten: 1,
      failures: [],
      truncated: false,
    });
  });

  it("advances the cursor to the oldest fetched message and skips last_synced_at", async () => {
    const oldestMs = Date.parse("2026-06-01T12:00:00.000Z");
    mocks.listMessageIds.mockResolvedValue({ ids: ["a", "b"], truncated: "cap" });
    mocks.fetchHeaders.mockResolvedValue([header(Date.parse("2026-07-01T00:00:00Z")), header(oldestMs)]);

    const outcome = await backfillGmailForAccount(
      fakeClient({ backfill_before: BEFORE, backfill_until: UNTIL }),
      SUB,
      { deadline: Date.now() + 60_000 },
    );

    expect(outcome.status).toBe("ok");
    expect(outcome.before).toBe(new Date(oldestMs + 1_000).toISOString());
    expect(mocks.releaseSyncRow).toHaveBeenCalledWith(expect.anything(), SUB, {
      ok: true,
      backfillBefore: new Date(oldestMs + 1_000).toISOString(),
      skipLastSynced: true,
    });
    // The write is incremental with no calendar read — disjoint older mail folds
    // into existing edges; snapshot would overwrite recent signal.
    expect(mocks.writeActivityToGraph).toHaveBeenCalledWith(
      expect.anything(),
      "you@example.com",
      expect.objectContaining({ events: [] }),
      expect.objectContaining({ mode: "incremental" }),
    );
    // The query is windowed [until, before) — the shallow window is never re-read.
    const q = mocks.listMessageIds.mock.calls[0][2] as string;
    expect(q).toContain(`after:${Math.floor(Date.parse(UNTIL) / 1000)}`);
    expect(q).toContain(`before:${Math.floor(Date.parse(BEFORE) / 1000)}`);
    expect(q).not.toContain("-in:sent");
  });

  it("clears the cursor and sets last_full_ingest_at when the window drains", async () => {
    mocks.listMessageIds.mockResolvedValue({ ids: ["a"], truncated: null });
    mocks.fetchHeaders.mockResolvedValue([header(Date.parse("2026-03-01T00:00:00Z"))]);

    const outcome = await backfillGmailForAccount(
      fakeClient({ backfill_before: BEFORE, backfill_until: UNTIL }),
      SUB,
      { deadline: Date.now() + 60_000 },
    );

    expect(outcome.status).toBe("drained");
    expect(mocks.releaseSyncRow).toHaveBeenCalledWith(expect.anything(), SUB, {
      ok: true,
      fullIngest: true,
      backfillBefore: null,
      skipLastSynced: true,
    });
  });

  it("treats an empty listing as drained without fetching anything", async () => {
    mocks.listMessageIds.mockResolvedValue({ ids: [], truncated: null });

    const outcome = await backfillGmailForAccount(
      fakeClient({ backfill_before: BEFORE, backfill_until: UNTIL }),
      SUB,
      { deadline: Date.now() + 60_000 },
    );

    expect(outcome.status).toBe("drained");
    expect(mocks.fetchHeaders).not.toHaveBeenCalled();
    expect(mocks.writeActivityToGraph).not.toHaveBeenCalled();
  });

  it("leaves the cursor untouched when the graph write is truncated", async () => {
    mocks.listMessageIds.mockResolvedValue({ ids: ["a"], truncated: "cap" });
    mocks.fetchHeaders.mockResolvedValue([header(Date.parse("2026-06-01T00:00:00Z"))]);
    mocks.writeActivityToGraph.mockResolvedValue({
      entitiesTouched: 0,
      edgesWritten: 0,
      claimsWritten: 0,
      failures: ["stopped early"],
      truncated: true,
    });

    const outcome = await backfillGmailForAccount(
      fakeClient({ backfill_before: BEFORE, backfill_until: UNTIL }),
      SUB,
      { deadline: Date.now() + 60_000 },
    );

    expect(outcome.status).toBe("error");
    // ok: false never carries cursor fields — the next pass replays this slice.
    expect(mocks.releaseSyncRow).toHaveBeenCalledWith(expect.anything(), SUB, {
      ok: false,
      error: "write truncated by deadline",
    });
  });

  it("skips without any Google call when another run holds the claim", async () => {
    mocks.claimSyncRow.mockResolvedValue(false);

    const outcome = await backfillGmailForAccount(
      fakeClient({ backfill_before: BEFORE, backfill_until: UNTIL }),
      SUB,
      { deadline: Date.now() + 60_000 },
    );

    expect(outcome.status).toBe("skipped_running");
    expect(mocks.getGoogleAccessToken).not.toHaveBeenCalled();
    expect(mocks.releaseSyncRow).not.toHaveBeenCalled();
  });

  it("releases and reports nothing_to_do when the cursor is already cleared", async () => {
    const outcome = await backfillGmailForAccount(
      fakeClient({ backfill_before: null, backfill_until: null }),
      SUB,
      { deadline: Date.now() + 60_000 },
    );

    expect(outcome.status).toBe("nothing_to_do");
    expect(mocks.releaseSyncRow).toHaveBeenCalledWith(expect.anything(), SUB, {
      ok: true,
      skipLastSynced: true,
    });
    expect(mocks.getGoogleAccessToken).not.toHaveBeenCalled();
  });
});

describe("nextCursor", () => {
  const beforeMs = Date.parse(BEFORE);

  it("moves to one second past the oldest usable timestamp", () => {
    const oldest = Date.parse("2026-05-01T00:00:00Z");
    const next = nextCursor([header(Date.parse("2026-06-01T00:00:00Z")), header(oldest)], beforeMs);
    expect(next).toBe(new Date(oldest + 1_000).toISOString());
  });

  it("falls back to the Date header when internalDate is missing", () => {
    const next = nextCursor([{ date: "Fri, 01 May 2026 00:00:00 GMT" }], beforeMs);
    expect(next).toBe(new Date(Date.parse("2026-05-01T00:00:00Z") + 1_000).toISOString());
  });

  it("forces a fixed step back when no timestamp is usable", () => {
    const next = nextCursor([{ date: "not a date" }, {}], beforeMs);
    expect(next).toBe(new Date(beforeMs - 7 * 86_400_000).toISOString());
  });

  it("forces a fixed step back when timestamps lie newer than the window", () => {
    // A sender-forged Date newer than before: would move the cursor forward and
    // loop forever. The guard steps it back instead.
    const next = nextCursor([{ date: new Date(beforeMs + 86_400_000).toUTCString() }], beforeMs);
    expect(next).toBe(new Date(beforeMs - 7 * 86_400_000).toISOString());
  });
});
