import { NextResponse } from "next/server";

import { db } from "../../lib/db";
import { requireUser } from "../../lib/session-user";

/**
 * GET /api/me — the member row belonging to the caller's session.
 *
 * Onboarding state used to live only in localStorage, so signing in on a second
 * device (or after clearing site data) looked identical to never having joined:
 * the member was pushed back through /join and, before the POST /api/people
 * de-duplication, could end up with two rows. The account is the source of truth
 * now; localStorage is just a cache.
 *
 * Returns `{ member: null }` — not a 404 — when the account exists but has not
 * onboarded yet. That is a normal state, and the client routes on it.
 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const person = await findPerson(auth.user.id, auth.user.email);
  if (!person) return NextResponse.json({ member: null });

  return NextResponse.json({
    member: {
      id: person.id,
      profile: {
        name: person.name ?? "",
        headline: person.headline ?? "",
        summary: person.bio ?? "",
        goals: person.goals ?? [],
        background: person.background ?? [],
        offering: person.offering ?? "",
        looking_for: person.looking_for ?? "",
        tags: person.tags ?? [],
      },
    },
  });
}

const FIELDS = "id, name, headline, bio, offering, looking_for, goals, background, tags, user_id";

type PersonRow = {
  id: string;
  name: string | null;
  headline: string | null;
  bio: string | null;
  offering: string | null;
  looking_for: string | null;
  goals: string[] | null;
  background: string[] | null;
  tags: string[] | null;
};

/**
 * By auth user first, then by email. The email fallback covers members created
 * before their account existed (seeded personas, and anyone onboarded when
 * /api/people still took user_id from the request body) — and claims the row for
 * the account so the next lookup takes the fast path.
 */
async function findPerson(userId: string, email: string | null): Promise<PersonRow | null> {
  const byUser = await db.from("people").select(FIELDS).eq("user_id", userId).maybeSingle();
  if (byUser.data) return byUser.data as PersonRow;

  if (!email) return null;
  const byEmail = await db.from("people").select(FIELDS).ilike("email", email).maybeSingle();
  if (!byEmail.data) return null;

  const row = byEmail.data as PersonRow & { user_id: string | null };
  if (!row.user_id) {
    await db.from("people").update({ user_id: userId }).eq("id", row.id);
  }
  return row;
}
