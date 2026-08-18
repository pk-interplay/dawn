import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { getGoogleAccessToken } from "../../../../src/lib/google-account";
import { ensureViewerEntity } from "../../../../src/lib/entity-identity";
import { ingestGmailNetwork } from "../../../../src/lib/network-ingest";
import {
  defaultLookbackDate,
  fetchGmailHistoryId,
  publicGoogleErrorMessage,
  type GmailActivity,
} from "../../../../src/lib/gmail-ingest";
import {
  claimSyncRow,
  releaseSyncRow,
  NoAccountRowError,
} from "../../../../src/lib/gmail-sync";
import {
  synthesizeProfile,
  distillEvidence,
  describeEvidence,
  SYNTHESIS_MODEL,
} from "../../../../src/lib/synthesize-profile";

/**
 * Onboarding step 1: build the graph, then draft a profile.
 *
 * Service-role client, following the precedent set by /api/ingest/gmail: this route
 * runs as whichever user is signed in and writes on their behalf, and the NextAuth
 * session is what gates who can reach it — not something RLS should be constraining
 * as an anonymous caller.
 *
 * The draft is written to `profile_drafts`, NOT to claims. Until the user presses
 * Confirm, nothing about them is visible to anyone else in the network. Staging it
 * server-side rather than holding it in the client means a refresh, a closed tab, or a
 * slow connection does not lose several seconds of model work.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Gmail ingest pages through the shallow window's metadata, then synthesis is a
// Sonnet call. The ceiling stays generous: an outlier-busy 30 days plus a slow
// model call must still end with a reported result, not a platform kill.
export const maxDuration = 300;

/**
 * How much mailbox the interactive ingest reads. 30 days is enough to saturate
 * profile synthesis (MAX_SUBJECTS caps at 120 outbound subjects) and keeps the
 * wait ~10–15s; everything older, back to defaultLookbackDate(), is drained by
 * the backfill cron (dawn-backfill-gmail) after the user is already in.
 */
const SHALLOW_WINDOW_DAYS = 30;

/**
 * How long this route gives itself, against the maxDuration above.
 *
 * The 30s of headroom is the whole point. When the platform kills a function it does not
 * get to say goodbye: the stream simply stops mid-flight, and a client waiting for a
 * terminal event waits forever. Reaching our own deadline first means we always close the
 * stream ourselves, having said what happened. A large mailbox that cannot be finished
 * becomes a reported partial result rather than a silent hang.
 */
const RUN_BUDGET_MS = 270_000;

/** Heartbeat interval. Well inside the client's stall watchdog. */
const HEARTBEAT_MS = 2_000;

/**
 * Streams newline-delimited JSON so the onboarding screen can show contacts flowing
 * in live rather than a spinner. Event shapes on the wire:
 *   {"type":"contact","name":"…","email":"…"}   — one per unique correspondent, as found
 *   {"type":"progress","phase":…,"done":…,"total":…} — heartbeat; also proves liveness
 *   {"type":"step","step":"calendar"}           — the calendar leg finished (it runs
 *                                                 concurrently with the Gmail read)
 *   {"type":"evidence","evidence":…}            — what synthesis is reading
 *   {"type":"draft_partial","draft":…}          — the draft as it is written
 *   {"type":"error","error":"…"}                — ingest failed; nothing usable
 *   {"type":"result","ingest":…,"draft":…,…}    — terminal success (draft may be null)
 * The auth gate runs before the stream opens so a 401 is still a plain JSON status.
 *
 * Exactly one terminal event (`result` or `error`) is sent on every path, including the
 * deadline and unexpected throws — see the try/finally in `start` below. The client
 * treats a stream that closes without one as a failure, so this is a contract, not a
 * nicety.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Server-side token first (google_accounts): it refreshes mid-run-capable
  // tokens on demand and persists rotation, where the cookie token was
  // snapshotted once and could die partway through a 270s run. The cookie is
  // the fallback for sessions that predate the store.
  const tokenResult = await getGoogleAccessToken(supabase, session.user.id);
  const accessToken = tokenResult.ok ? tokenResult.accessToken : session.accessToken;
  if (!accessToken) {
    return NextResponse.json(
      {
        error:
          !tokenResult.ok && tokenResult.reason === "revoked"
            ? "Google access was revoked. Sign in again to reconnect Gmail."
            : "Your Google access expired. Sign in again to reconnect Gmail.",
      },
      { status: 401 },
    );
  }
  const name = session.user.name ?? null;

  const viewer = await ensureViewerEntity(supabase, session);

  // Mailbox mutex (gmail_sync_state claim): a double-click, an impatient
  // refresh, or the hourly sync must not read this mailbox concurrently — two
  // paced reads burn double the per-minute quota and 429 each other. Sessions
  // that predate the credential store have no row to claim; they proceed
  // unguarded, as before.
  let guarded = false;
  try {
    if (!(await claimSyncRow(supabase, session.user.id))) {
      return NextResponse.json(
        { error: "An import is already running for this account. Give it a minute." },
        { status: 409 },
      );
    }
    guarded = true;
  } catch (err) {
    if (!(err instanceof NoAccountRowError)) {
      console.error("[onboarding] sync claim failed; proceeding unguarded:", err);
    }
  }
  const googleSub = session.user.id;

  const startedAt = Date.now();
  const deadline = startedAt + RUN_BUDGET_MS;
  const elapsed = () => Date.now() - startedAt;
  const log = (message: string, extra: Record<string, unknown> = {}) => {
    const detail = Object.entries(extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(
      `[onboarding] entity=${viewer.entityId} elapsed=${elapsed()}ms ${message}${detail ? " " + detail : ""}`,
    );
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Whether a terminal event has gone out. Every exit path funnels through the
      // `finally` below, which sends one if nothing else did.
      let terminal = false;
      const send = (event: Record<string, unknown>) => {
        if (event.type === "result" || event.type === "error") terminal = true;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      // Phase state, read by the heartbeat. The graph write is the phase that used to go
      // completely silent for minutes at a time, and the mailbox read is the one that
      // stalls for up to a minute whenever the Gmail quota window makes it wait its turn.
      let phase = "reading";
      let done = 0;
      let total = 0;
      // When the counters last moved. The read is paced deliberately, so a stalled count
      // is normal — but the screen should say "waiting on Gmail" rather than sit on a
      // number that has not changed in forty seconds looking broken.
      let lastAdvance = Date.now();
      const advance = (nextDone: number, nextTotal: number) => {
        if (nextDone !== done || nextTotal !== total) lastAdvance = Date.now();
        done = nextDone;
        total = nextTotal;
      };
      const heartbeat = setInterval(() => {
        try {
          send({
            type: "progress",
            phase,
            done,
            total,
            // Long enough that ordinary batch latency never trips it, short enough to
            // explain a quota pause while it is still happening.
            stalledMs: Date.now() - lastAdvance,
          });
        } catch {
          // Client gone. The deadline check in the work below is what stops the run.
        }
      }, HEARTBEAT_MS);

      // Ingest first and separately. It is the part that must succeed — it is the graph
      // — and the part with no model call in it. Each unique correspondent is streamed
      // out as it is discovered; the client renders them as they arrive.
      let ingest;
      // The mailbox read the ingest performs, handed straight to synthesis below.
      // Gmail's quota is 15,000 units per minute per *user* and one six-month read is
      // most of that, so reading it twice in one request 403s on the second pass.
      let activity: GmailActivity | undefined;

      // Baseline for the incremental sync, captured BEFORE the read so anything
      // arriving mid-ingest gets replayed by the first sync pass (the graph
      // writes are idempotent upserts, so the overlap is free). Best-effort —
      // a missing baseline costs one stale-history fallback later, not the run.
      let historyId: string | null = null;
      try {
        historyId = await fetchGmailHistoryId(accessToken, viewer.email);
      } catch (err) {
        console.warn("[onboarding] could not capture history baseline:", err);
      }

      try {
        try {
          const seen = new Set<string>();
          ingest = await ingestGmailNetwork(supabase, accessToken, viewer.email, {
            deadline,
            // Shallow window: the last SHALLOW_WINDOW_DAYS only. No `before` —
            // it runs right up to now, and the backfill takes everything older.
            window: { after: new Date(startedAt - SHALLOW_WINDOW_DAYS * 86_400_000) },
            onCalendarDone: () => send({ type: "step", step: "calendar" }),
            onContact: (contact) => {
              if (seen.has(contact.email)) return;
              seen.add(contact.email);
              send({ type: "contact", name: contact.name, email: contact.email });
            },
            onReadProgress: ({ phase: direction, fetched, total: count }) => {
              phase = direction === "sent" ? "reading_sent" : "reading_received";
              advance(fetched, count);
            },
            onActivity: (fetched) => {
              activity = fetched;
              phase = "writing";
              advance(0, 0);
              log("gmail read complete", { contacts: seen.size });
            },
            onWriteProgress: (written, count) => advance(written, count),
          });
          log("graph written", {
            entities: ingest.entitiesTouched,
            edges: ingest.edgesWritten,
            failures: ingest.failures.length,
            truncated: ingest.truncated,
          });

          // Stash the distilled evidence so Regenerate never re-reads the
          // mailbox (see synthesize-profile.ts DistilledEvidence). Written even
          // when synthesis below fails — that failure is exactly when the user
          // will press Regenerate.
          if (activity) {
            const { error: evErr } = await supabase.from("profile_drafts").upsert(
              {
                entity_id: viewer.entityId,
                evidence: distillEvidence(activity, viewer.email),
                model: SYNTHESIS_MODEL,
              },
              { onConflict: "entity_id" },
            );
            if (evErr) console.error("[onboarding] failed to stash evidence:", evErr.message);
          }
        } catch (err) {
          // Full detail (URL, Google's response body) belongs in the log; the client
          // gets a sanitized line — googleFetch errors would otherwise put raw Google
          // error payloads on the onboarding screen.
          console.error("[onboarding] ingest failed:", err);
          send({ type: "error", error: publicGoogleErrorMessage(err) });
          return;
        }

        // No time left to synthesise. The graph is written and that is the valuable half,
        // so this reports a thin result the user can act on with Regenerate — not an
        // error, and above all not silence.
        if (Date.now() >= deadline) {
          log("deadline reached before synthesis");
          send({
            type: "result",
            entityId: viewer.entityId,
            ingest,
            draft: null,
            generated: false,
            reason: "timeout",
          });
          return;
        }

        // Synthesis gets its own try/catch, and this is deliberate. nexus's equivalent
        // route did not have one, so a synthesis failure looked like total failure even
        // though the entire network had just been ingested. The graph is the valuable
        // part; a missing draft is recoverable by pressing Regenerate.
        let synthesis;
        try {
          phase = "synthesizing";
          advance(0, 0);
          synthesis = await synthesizeProfile({
            accessToken,
            email: viewer.email,
            name,
            activity,
            deadline,
            // Both of these exist to fill the synthesis wait with the real thing. The
            // evidence counts land the moment they're known; the draft streams in field
            // by field as Sonnet writes it, so the review screen assembles in front of
            // the user rather than appearing all at once after a silent pause.
            onEvidence: (evidence) => send({ type: "evidence", evidence }),
            onPartial: (draft) => send({ type: "draft_partial", draft }),
          });
        } catch (err) {
          console.error("[onboarding] synthesis failed:", err);
          send({
            type: "result",
            entityId: viewer.entityId,
            ingest,
            draft: null,
            generated: false,
            reason: "error",
          });
          return;
        }

        if (synthesis.draft) {
          const { error } = await supabase.from("profile_drafts").upsert(
            {
              entity_id: viewer.entityId,
              draft: synthesis.draft,
              model: SYNTHESIS_MODEL,
              created_at: new Date().toISOString(),
            },
            { onConflict: "entity_id" },
          );
          if (error) {
            // The draft exists but could not be staged. Send it anyway rather than
            // throwing away a model call — Confirm re-synthesises if it finds no row.
            console.error("[onboarding] failed to stage draft:", error.message);
          }
        }

        log("complete", { generated: synthesis.generated, reason: synthesis.reason ?? "ok" });
        send({
          type: "result",
          entityId: viewer.entityId,
          ingest,
          draft: synthesis.draft,
          generated: synthesis.generated,
          reason: synthesis.reason,
          evidenceNote: describeEvidence(synthesis.evidence),
        });
      } catch (err) {
        // Anything unforeseen. Better a reported error than a stream that stops —
        // but sanitized: raw messages here can carry request URLs and response bodies.
        console.error("[onboarding] unexpected ingest failure:", err);
        if (!terminal) {
          send({ type: "error", error: "Something went wrong during setup. Please try again." });
        }
      } finally {
        clearInterval(heartbeat);
        // Hand the mailbox back, and — on success — record the sync baseline so
        // the hourly dawn-sync-gmail job takes over from exactly this point,
        // plus the backfill window so dawn-backfill-gmail drains everything
        // older than the shallow read. Seeded even when the ingest truncated:
        // the backfill covers strictly older mail either way, and
        // last_full_ingest_at is now the backfill's to set, when it drains.
        if (guarded) {
          try {
            await releaseSyncRow(
              supabase,
              googleSub,
              ingest
                ? {
                    ok: true,
                    historyId: historyId ?? undefined,
                    backfillBefore: new Date(
                      startedAt - SHALLOW_WINDOW_DAYS * 86_400_000,
                    ).toISOString(),
                    backfillUntil: defaultLookbackDate(new Date(startedAt)).toISOString(),
                  }
                : { ok: false, error: "onboarding ingest did not complete" },
            );
          } catch (err) {
            console.error("[onboarding] failed to release sync claim:", err);
          }
        }
        // The contract: never close without saying how it went. If we get here with no
        // terminal event something returned by a path that forgot to send one, and a
        // reported error is strictly better than the silent close that leaves the
        // onboarding screen spinning indefinitely.
        if (!terminal) {
          console.error("[onboarding] stream ended with no terminal event");
          send({ type: "error", error: "Setup ended unexpectedly. Please try again." });
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Without this a buffering proxy holds the whole stream until it completes, which
      // turns the live ticker back into the bare spinner it replaced.
      "X-Accel-Buffering": "no",
    },
  });
}
