import { NextResponse } from "next/server";
import { db } from "../../../lib/db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q) {
    return NextResponse.json({ error: "Missing query param ?q=" }, { status: 400 });
  }

  // Strip characters that would break PostgREST's or-filter syntax.
  const safe = q.replace(/[,()]/g, " ").trim();
  const fields = ["name", "headline", "bio", "offering", "looking_for"];
  const orFilter = fields.map((f) => `${f}.ilike.%${safe}%`).join(",");

  const { data, error } = await db
    .from("people")
    .select(
      "id, name, headline, bio, offering, looking_for, tags, industry, career_stage, location, meeting_format, ask_must_haves, ask_nice_to_haves",
    )
    .or(orFilter)
    .order("name")
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ query: q, count: data.length, people: data });
}
