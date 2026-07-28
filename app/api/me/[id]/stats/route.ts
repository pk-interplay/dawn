import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";

// Dashboard stats for a member: how many introductions Dawn has actually made
// on their behalf, and how many of their suggested matches have been accepted.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    // Confirm the member exists (and surface a friendly 404 if not).
    const { data: person, error: personError } = await db
      .from("people")
      .select("id, name, headline")
      .eq("id", id)
      .maybeSingle();
    if (personError) throw new Error(personError.message);
    if (!person) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Intros Dawn has made are keyed by the free-form `requester_ref`; for
    // members we use their people.id as that reference.
    const { count: introsCount, error: introsError } = await db
      .from("intros")
      .select("*", { count: "exact", head: true })
      .eq("requester_ref", id);
    if (introsError) throw new Error(introsError.message);

    // Approved connections = accepted matches this member is part of.
    const { count: connectionsCount, error: connectionsError } = await db
      .from("matches")
      .select("*", { count: "exact", head: true })
      .eq("status", "accepted")
      .or(`person_a_id.eq.${id},person_b_id.eq.${id}`);
    if (connectionsError) throw new Error(connectionsError.message);

    return NextResponse.json({
      person,
      intros: introsCount ?? 0,
      connections: connectionsCount ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load stats" },
      { status: 500 },
    );
  }
}
