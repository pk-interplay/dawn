import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { ensureViewerEntity } from "../../../../src/lib/entity-identity";
import { ingestGmailNetwork } from "../../../../src/lib/network-ingest";
import type { GmailActivity } from "../../../../src/lib/gmail-ingest";
import {
  synthesizeProfile,
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
// Gmail ingest pages through six months of metadata, then synthesis is a Sonnet call.
// nexus used 60s for the same shape of work and occasionally grazed it.
export const maxDuration = 300;

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
  if (!session.accessToken) {
    // The refresh path in src/auth.ts clears accessToken when it cannot renew, which
    // is a real state, not a bug: the Google grant was revoked or expired past repair.
    return NextResponse.json(
      { error: "Your Google access expired. Sign in again to reconnect Gmail." },
      { status: 401 },
    );
  }
  const accessToken = session.accessToken;
  const name = session.user.name ?? null;

  const viewer = await ensureViewerEntity(supabase, session);

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

      try {
        try {
          const seen = new Set<string>();
          ingest = await ingestGmailNetwork(supabase, accessToken, viewer.email, {
            deadline,
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
        } catch (err) {
          const message = err instanceof Error ? err.message : "Gmail ingest failed";
          console.error("[onboarding] ingest failed:", message);
          send({ type: "error", error: message });
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
        // Anything unforeseen. Better a reported error than a stream that stops.
        console.error("[onboarding] unexpected ingest failure:", err);
        if (!terminal) {
          send({
            type: "error",
            error: err instanceof Error ? err.message : "Something went wrong during setup",
          });
        }
      } finally {
        clearInterval(heartbeat);
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
