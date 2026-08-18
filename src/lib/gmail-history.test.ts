import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunBudget,
  fetchRecentCalendarEvents,
  isNetworkSignal,
  listHistoryMessageIds,
} from "./gmail-ingest";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("listHistoryMessageIds", () => {
  it("pages and dedupes messagesAdded, returning the newest historyId", async () => {
    const pages = [
      {
        history: [
          { messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] },
        ],
        historyId: "200",
        nextPageToken: "p2",
      },
      {
        // m2 repeats — one message can appear in several history records.
        history: [{ messagesAdded: [{ message: { id: "m2" } }, { message: { id: "m3" } }] }],
        historyId: "201",
      },
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(pages[call++])));

    const result = await listHistoryMessageIds("tok", new RunBudget(), "100", undefined, "user@x.com");
    expect(result.stale).toBe(false);
    expect(result.ids.sort()).toEqual(["m1", "m2", "m3"]);
    expect(result.historyId).toBe("201");
  });

  it("reports stale on a 404 (expired historyId) instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const result = await listHistoryMessageIds("tok", new RunBudget(), "100", undefined, "user2@x.com");
    expect(result).toEqual({ ids: [], historyId: "100", stale: true });
  });
});

describe("isNetworkSignal", () => {
  it("drops the categories the initial ingest's query excluded", () => {
    expect(isNetworkSignal({ labelIds: ["INBOX", "IMPORTANT"] })).toBe(true);
    expect(isNetworkSignal({})).toBe(true); // no labels = keep
    for (const label of ["DRAFT", "CHAT", "SPAM", "TRASH", "CATEGORY_PROMOTIONS"]) {
      expect(isNetworkSignal({ labelIds: ["INBOX", label] })).toBe(false);
    }
  });
});

describe("fetchRecentCalendarEvents windowing", () => {
  it("queries newest month first, so the cap drops the OLDEST events", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(String(url));
        return jsonResponse({
          items: [
            { start: { dateTime: "2026-08-01T10:00:00Z" }, summary: "recent", attendees: [] },
            { start: { dateTime: "2026-08-02T10:00:00Z" }, summary: "recent2", attendees: [] },
          ],
        });
      }),
    );

    const events = await fetchRecentCalendarEvents("tok", undefined, "user3@x.com", {
      timeMin: new Date(Date.now() - 180 * 86_400_000),
      timeMax: new Date(),
      cap: 2,
    });

    // Cap reached after the first (newest) window — older months never fetched.
    expect(events).toHaveLength(2);
    expect(requested).toHaveLength(1);
    const first = new URL(requested[0]);
    const timeMax = Date.parse(first.searchParams.get("timeMax")!);
    const timeMin = Date.parse(first.searchParams.get("timeMin")!);
    expect(Date.now() - timeMax).toBeLessThan(60_000); // newest window ends ~now
    expect(timeMax - timeMin).toBeLessThanOrEqual(32 * 86_400_000); // ~one month
  });
});
