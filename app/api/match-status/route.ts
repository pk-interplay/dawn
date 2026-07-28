import { NextResponse } from "next/server";
import { db } from "../../lib/db";

const VALID_STATUSES = ["accepted", "rejected"] as const;

export async function PATCH(request: Request) {
  const body = await request.json();
  const id = body?.id;
  const status = body?.status;

  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }

  const { data, error } = await db.from("matches").update({ status }).eq("id", id).select().single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ match: data });
}
