import { NextResponse } from "next/server";
import { db } from "../../lib/db";
import { requireUser } from "../../lib/session-user";
import { CADENCES, PREFERENCE_KINDS, type PreferenceKind } from "../../../lib/onboarding";

const SELECT_FIELDS =
  "id, name, headline, bio, offering, looking_for, goals, background, tags, industry, career_stage, location, meeting_format, ask_must_haves, ask_nice_to_haves, email, timezone, intro_cadence, paused";

export async function GET() {
  const { data, error } = await db.from("people").select(SELECT_FIELDS).order("name");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ people: data });
}

export async function POST(request: Request) {
  const body = await request.json();

  // Onboarding is signed-in only, and the identity comes from the verified session
  // rather than the body: a client-supplied user_id could claim someone else's row,
  // and a missing one produced an orphan the account could never find again. Seeding
  // scripts write through the service-role client, not this route.
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id: authUserId, email: authEmail } = auth.user;

  const {
    name,
    headline,
    bio,
    offering,
    looking_for,
    goals,
    background,
    tags,
    industry,
    career_stage,
    location,
    meeting_format,
    ask_must_haves,
    ask_nice_to_haves,
    timezone,
    intro_cadence,
    preferences,
  } = body;

  // Onboarding never captured this, so every member landed on the 'weekly' column
  // default no matter what they were told to expect.
  const cadence =
    // Widened because CADENCES is a readonly tuple of literals; the incoming value
    // is unvalidated JSON, so the narrow signature would reject the check itself.
    typeof intro_cadence === "string" && (CADENCES as readonly string[]).includes(intro_cadence)
      ? intro_cadence
      : "weekly";

  if (!name || !offering || !looking_for) {
    return NextResponse.json(
      { error: "name, offering, and looking_for are required" },
      { status: 400 },
    );
  }

  const record: Record<string, unknown> = {
    name,
    headline: headline || null,
    bio: bio || null,
    offering,
    looking_for,
    goals: Array.isArray(goals) ? goals : [],
    background: Array.isArray(background) ? background : [],
    tags: Array.isArray(tags) ? tags : [],
    industry: industry || null,
    career_stage: career_stage || null,
    location: location || null,
    meeting_format: meeting_format || null,
    ask_must_haves: Array.isArray(ask_must_haves) ? ask_must_haves : [],
    ask_nice_to_haves: Array.isArray(ask_nice_to_haves) ? ask_nice_to_haves : [],
    email: authEmail,
    user_id: authUserId,
    timezone: timezone || null,
    intro_cadence: cadence,
  };

  let embedded = false;
  if (process.env.OPENAI_API_KEY) {
    const { embed } = await import("../../../src/lib/openai");
    const backgroundText = Array.isArray(background) ? background.join(". ") : "";
    const goalsText = Array.isArray(goals) ? goals.join(". ") : "";
    const [embeddingOffering, embeddingLookingFor, embeddingTags] = await Promise.all([
      embed(
        `${headline ?? ""}. Offers: ${offering}. Relevant background: ${bio ?? ""} ${backgroundText}`,
      ),
      embed(`Looking for: ${looking_for}. Goals: ${goalsText}. Context: ${bio ?? ""}`),
      embed(
        `${industry ?? ""}. ${career_stage ?? ""}. Tags: ${(tags ?? []).join(", ")}. Location: ${location ?? ""}.`,
      ),
    ]);
    record.embedding_offering = embeddingOffering;
    record.embedding_looking_for = embeddingLookingFor;
    record.embedding_tags = embeddingTags;
    embedded = true;
  }

  // Re-onboarding must UPDATE, never insert a second row. /join only guards against
  // this with localStorage, so a second device or a cleared browser lands here again
  // with the same identity — and a duplicate row makes the member invisible to
  // inbound triage (its .maybeSingle() lookup errors on two matches) and gets them
  // treated as a non-member. Resolve by auth user first, then by email.
  const existing = await findExistingPerson(authUserId, authEmail);

  const { data, error } = existing
    ? await db.from("people").update(record).eq("id", existing).select().single()
    : await db.from("people").insert(record).select().single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const savedPreferences = await savePreferences(data.id as string, preferences);

  return NextResponse.json({
    person: data,
    embedded,
    updated: Boolean(existing),
    preferences: savedPreferences,
  });
}

/**
 * Write the onboarding form's multi-select answers as one `person_preferences`
 * row per selected value.
 *
 * Deliberately not fatal. The person row is already committed by this point, and a
 * member who exists with no preferences still gets matched on their profile
 * embeddings — whereas a 500 here would strand them on the form with an account
 * that already exists, and re-submitting would just update the same row again.
 * Preferences are also re-derivable later from email replies.
 */
async function savePreferences(personId: string, raw: unknown): Promise<number> {
  if (!Array.isArray(raw) || raw.length === 0) return 0;

  const seen = new Set<string>();
  const rows: {
    person_id: string;
    kind: PreferenceKind;
    value: string;
    source: string;
    confidence: number;
    active: boolean;
  }[] = [];

  for (const entry of raw as Record<string, unknown>[]) {
    const kind = entry?.kind;
    const value = typeof entry?.value === "string" ? entry.value.trim() : "";
    if (!value) continue;
    if (typeof kind !== "string") continue;
    if (!(PREFERENCE_KINDS as readonly string[]).includes(kind)) continue;

    // The unique index is (person_id, kind, value); duplicates in one payload would
    // make the upsert fail on "affect row a second time".
    const dedupeKey = `${kind}::${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    rows.push({
      person_id: personId,
      kind: kind as PreferenceKind,
      value,
      source: "onboarding_form",
      // Stated outright by the member on a form, not inferred from prose.
      confidence: 1,
      active: true,
    });
  }

  if (rows.length === 0) return 0;

  // Retract the previous form answers before writing the new set. Re-onboarding
  // otherwise only ever adds: an option the member has since unticked would stay
  // active forever and keep steering their matches. `active` rather than delete,
  // so what we once believed stays auditable — and the upsert below flips the
  // still-selected ones back on.
  await db
    .from("person_preferences")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("person_id", personId)
    .eq("source", "onboarding_form");

  const { error } = await db
    .from("person_preferences")
    .upsert(rows, { onConflict: "person_id,kind,value" });

  if (error) {
    console.error("[people] preference write failed", error.message);
    return 0;
  }
  return rows.length;
}

/** Existing people.id for this auth user or email address, if any. */
async function findExistingPerson(
  userId: unknown,
  email: unknown,
): Promise<string | null> {
  if (typeof userId === "string" && userId) {
    const { data } = await db.from("people").select("id").eq("user_id", userId).maybeSingle();
    if (data?.id) return data.id as string;
  }
  if (typeof email === "string" && email) {
    const { data } = await db.from("people").select("id").ilike("email", email).maybeSingle();
    if (data?.id) return data.id as string;
  }
  return null;
}
