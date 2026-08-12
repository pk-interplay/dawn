import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { ensureViewerEntity } from "../../../../src/lib/entity-identity";
import { ingestGmailNetwork } from "../../../../src/lib/network-ingest";
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
 * Streams newline-delimited JSON so the onboarding screen can show contacts flowing
 * in live rather than a spinner. Event shapes on the wire:
 *   {"type":"contact","name":"…","email":"…"}   — one per unique correspondent, as found
 *   {"type":"error","error":"…"}                — ingest failed; nothing usable
 *   {"type":"result","ingest":…,"draft":…,…}    — terminal success (draft may be null)
 * The auth gate runs before the stream opens so a 401 is still a plain JSON status.
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      // Ingest first and separately. It is the part that must succeed — it is the graph
      // — and the part with no model call in it. Each unique correspondent is streamed
      // out as it is discovered; the client renders them as they arrive.
      let ingest;
      try {
        const seen = new Set<string>();
        ingest = await ingestGmailNetwork(supabase, accessToken, viewer.email, (contact) => {
          if (seen.has(contact.email)) return;
          seen.add(contact.email);
          send({ type: "contact", name: contact.name, email: contact.email });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Gmail ingest failed";
        console.error("[onboarding] ingest failed:", message);
        send({ type: "error", error: message });
        controller.close();
        return;
      }

      // Synthesis gets its own try/catch, and this is deliberate. nexus's equivalent
      // route did not have one, so a synthesis failure looked like total failure even
      // though the entire network had just been ingested. The graph is the valuable
      // part; a missing draft is recoverable by pressing Regenerate.
      let synthesis;
      try {
        synthesis = await synthesizeProfile({
          accessToken,
          email: viewer.email,
          name,
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
        controller.close();
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

      send({
        type: "result",
        entityId: viewer.entityId,
        ingest,
        draft: synthesis.draft,
        generated: synthesis.generated,
        reason: synthesis.reason,
        evidenceNote: describeEvidence(synthesis.evidence),
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  });
}
