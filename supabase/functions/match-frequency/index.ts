// Supabase Edge Function: match-frequency
//
// "How often has this person received matches?" — the governance check the
// product asked for. Thin wrapper over the SQL function person_intro_stats()
// (migration 0011); the run-matches cron consults the same SQL directly, and
// this endpoint exposes it standalone for dashboards/ops.
//
// Deploy:  supabase functions deploy match-frequency
// Invoke:  POST { "person_id": "<uuid>", "window": "7 days" }
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CAP_PER_WINDOW = Number(Deno.env.get("INTRO_CAP_PER_WINDOW") ?? "1");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  try {
    const { person_id, window } = await req.json().catch(() => ({}) as Record<string, string>);
    if (!person_id) return json({ error: "person_id required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const lookback = window ?? "7 days";
    const { data, error } = await supabase.rpc("person_intro_stats", {
      p_id: person_id,
      lookback,
    });
    if (error) return json({ error: error.message }, 500);

    const row = Array.isArray(data) ? data[0] : data;
    const introsCount = Number(row?.intros_count ?? 0);

    return json({
      person_id,
      window: lookback,
      intros_count: introsCount,
      introductions_count: Number(row?.introductions_count ?? 0),
      matches_count: Number(row?.matches_count ?? 0),
      cap: CAP_PER_WINDOW,
      under_cap: introsCount < CAP_PER_WINDOW,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
