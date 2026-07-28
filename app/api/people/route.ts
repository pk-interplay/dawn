import { NextResponse } from "next/server";
import { db } from "../../lib/db";

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
    email,
    user_id,
    timezone,
    intro_cadence,
  } = body;

  // Onboarding never captured this, so every member landed on the 'weekly' column
  // default no matter what they were told to expect.
  const CADENCES = ["burst", "daily", "weekly", "biweekly", "monthly"];
  const cadence =
    typeof intro_cadence === "string" && CADENCES.includes(intro_cadence)
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
    email: email || null,
    user_id: user_id || null,
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
  const existing = await findExistingPerson(user_id, email);

  const { data, error } = existing
    ? await db.from("people").update(record).eq("id", existing).select().single()
    : await db.from("people").insert(record).select().single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ person: data, embedded, updated: Boolean(existing) });
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
