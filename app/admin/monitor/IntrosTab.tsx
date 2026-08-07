"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "../../lib/admin-fetch";
import type { IntroRow } from "./types";
import { EmptyNote, ErrorNote, Loading, ResponseBadge, StateBadge, timeAgo } from "./shared";
import { Card, CardContent } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";

const STATES = [
  "proposed",
  "a_invited",
  "b_invited",
  "a_opted_in",
  "b_opted_in",
  "both_opted_in",
  "scheduling",
  "scheduled",
  "completed",
  "declined",
  "expired",
];

const DIRECTION_LABEL: Record<string, string> = {
  a_offers_b_wants: "they want what A offers",
  b_offers_a_wants: "A wants what they offer",
  mutual: "mutual fit",
};

export default function IntrosTab() {
  const [rows, setRows] = useState<IntroRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState("");

  useEffect(() => {
    setRows(null);
    setError(null);
    const query = state ? `?state=${state}` : "";
    adminFetch<{ introductions: IntroRow[] }>(`/api/admin/monitor/intros${query}`)
      .then((body) => setRows(body.introductions))
      .catch((err) => setError(err.message));
  }, [state]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SelectNative
          className="w-auto"
          value={state}
          onChange={(e) => setState(e.target.value)}
          aria-label="Filter by state"
        >
          <option value="">All states</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </SelectNative>
        {rows && (
          <span className="text-muted-foreground text-sm">
            {rows.length} introduction{rows.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {error && <ErrorNote message={error} />}
      {!rows && !error && <Loading what="introductions" />}
      {rows && !rows.length && <EmptyNote>No introductions match this filter.</EmptyNote>}

      {rows?.map((intro) => (
        <Card key={intro.id}>
          <CardContent className="space-y-3 px-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-medium">
                  {intro.person_a.name} <span className="text-muted-foreground">↔</span>{" "}
                  {intro.person_b.name}
                </h3>
                <p className="text-muted-foreground truncate text-xs">
                  {intro.person_a.headline ?? "—"} · {intro.person_b.headline ?? "—"}
                </p>
              </div>
              <StateBadge state={intro.state} />
            </div>

            <div className="flex flex-wrap gap-1.5">
              <ResponseBadge label={intro.person_a.name.split(" ")[0]} response={intro.a_response} />
              <ResponseBadge label={intro.person_b.name.split(" ")[0]} response={intro.b_response} />
            </div>

            {intro.match && (
              <p className="text-sm">
                <span className="text-muted-foreground">Match:</span>{" "}
                {intro.match.score === null ? "unscored" : intro.match.score.toFixed(2)} ·{" "}
                {DIRECTION_LABEL[intro.match.direction] ?? intro.match.direction}
              </p>
            )}

            {intro.rationale && (
              <p className="text-sm">
                <span className="text-muted-foreground">Why:</span> {intro.rationale}
              </p>
            )}

            {/* Message counts and the per-conversation thread reader were removed
                with the email layer — this intro machinery is dark, so there are no
                threads to read. State, responses, and rationale still tell the story. */}
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>created {timeAgo(intro.created_at)}</span>
              <span>· updated {timeAgo(intro.updated_at)}</span>
              <span>· via {intro.channel}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
