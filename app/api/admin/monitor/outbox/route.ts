import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;

// GET ?status=<status>&limit=<n> — the send ledger.
//
// While DAWN_DELIVERY_ENABLED is off this is the review surface for everything Dawn
// WOULD have sent: the exact body, the recipients, and which introduction authorised
// it. Reading these before flipping the switch is the point of building the pipeline
// this way round, so the default view is drafts.
//
// It stays useful afterwards for the opposite reason — once mail is really going out,
// this is the only place that records what was actually transmitted, verbatim.
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const params = new URL(req.url).searchParams;
  const status = params.get("status") ?? "draft";
  const limit = Math.min(Number(params.get("limit")) || DEFAULT_LIMIT, 500);

  try {
    let query = db
      .from("sends")
      .select(
        "id, consent_basis, introduction_id, kind, attempt, identity, to_emails, subject, body_sent, status, failure_reason, provider_message_id, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    // `all` is an explicit escape hatch rather than the default: a mixed list of
    // drafts and sent mail hides the thing you came here to check.
    if (status !== "all") query = query.eq("status", status);

    const { data: sends, error } = await query;
    if (error) throw new Error(error.message);
    const rows = sends ?? [];

    // Resolve who each send is about. Two hops — sends → introductions → people —
    // because `sends` deliberately stores addresses rather than person ids: the
    // recipient of a message is a fact about that message, and it must not change
    // when someone later edits their profile.
    const introIds = [...new Set(rows.map((r) => r.introduction_id).filter(Boolean))] as string[];
    const { data: intros } = introIds.length
      ? await db.from("introductions").select("id, person_a_id, person_b_id, state").in("id", introIds)
      : { data: [] as Array<{ id: string; person_a_id: string; person_b_id: string; state: string }> };

    const personIds = [
      ...new Set((intros ?? []).flatMap((i) => [i.person_a_id, i.person_b_id])),
    ];
    const { data: people } = personIds.length
      ? await db.from("people").select("id, name, email").in("id", personIds)
      : { data: [] as Array<{ id: string; name: string; email: string | null }> };

    const personById = new Map((people ?? []).map((p) => [p.id, p]));
    const introById = new Map((intros ?? []).map((i) => [i.id, i]));

    const outbox = rows.map((r) => {
      const intro = r.introduction_id ? introById.get(r.introduction_id) : null;
      return {
        id: r.id,
        consentBasis: r.consent_basis,
        kind: r.kind,
        attempt: r.attempt,
        identity: r.identity,
        toEmails: r.to_emails ?? [],
        subject: r.subject,
        body: r.body_sent,
        status: r.status,
        failureReason: r.failure_reason,
        providerMessageId: r.provider_message_id,
        createdAt: r.created_at,
        introduction: intro
          ? {
              id: intro.id,
              state: intro.state,
              personA: personById.get(intro.person_a_id)?.name ?? null,
              personB: personById.get(intro.person_b_id)?.name ?? null,
            }
          : null,
      };
    });

    // Counts across every status, not just the filtered page — "3 drafts" is only
    // meaningful next to how much has actually gone out.
    const { data: allStatuses } = await db.from("sends").select("status").limit(5000);
    const byStatus: Record<string, number> = {};
    for (const s of allStatuses ?? []) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

    return NextResponse.json({
      // Echoed so the UI can state plainly whether anything can leave the building,
      // rather than leaving someone to infer it from an empty sent list.
      deliveryEnabled: process.env.DAWN_DELIVERY_ENABLED === "true",
      status,
      byStatus,
      outbox,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "outbox query failed" },
      { status: 500 },
    );
  }
}
