"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "../../lib/admin-fetch";
import type { MemberRow } from "./types";
import { EmptyNote, ErrorNote, Loading, pct, timeAgo } from "./shared";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";

type SortKey = "name" | "intros" | "optInRate" | "lastTouch";

export default function MembersTab() {
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("intros");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<{ members: MemberRow[] }>("/api/admin/monitor/members")
      .then((body) => setRows(body.members))
      .catch((err) => setError(err.message));
  }, []);

  const visible = useMemo(() => {
    if (!rows) return null;
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? rows.filter((m) =>
          [m.name, m.headline, m.email, m.industry, m.location]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(needle)),
        )
      : rows;

    return [...matched].sort((a, b) => {
      switch (sort) {
        case "intros":
          return b.intros - a.intros || a.name.localeCompare(b.name);
        case "optInRate":
          // Members with no answered invitations sort last rather than as zero.
          return (b.optInRate ?? -1) - (a.optInRate ?? -1) || a.name.localeCompare(b.name);
        case "lastTouch":
          return (b.lastTouch ?? "").localeCompare(a.lastTouch ?? "");
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [rows, filter, sort]);

  if (error) return <ErrorNote message={error} />;
  if (!visible) return <Loading what="members" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-auto min-w-56 flex-1"
          placeholder="Filter by name, headline, email…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <SelectNative
          className="w-auto"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort members"
        >
          <option value="intros">Most intros</option>
          <option value="optInRate">Highest opt-in rate</option>
          <option value="lastTouch">Most recently touched</option>
          <option value="name">Name</option>
        </SelectNative>
      </div>

      {!visible.length && <EmptyNote>No members match this filter.</EmptyNote>}

      <div className="space-y-2">
        {visible.map((m) => (
          <Card key={m.id} className="gap-0 py-4">
            <CardContent className="px-4">
              <button
                type="button"
                className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
                onClick={() => setExpanded(expanded === m.id ? null : m.id)}
              >
                <div className="min-w-0">
                  <h3 className="truncate font-medium">
                    {m.name}
                    {m.paused && (
                      <span className="text-muted-foreground font-normal"> · paused</span>
                    )}
                  </h3>
                  <p className="text-muted-foreground truncate text-xs">
                    {m.headline ?? "—"}
                    {m.email ? ` · ${m.email}` : " · no email"}
                  </p>
                </div>
                <div className="text-muted-foreground flex shrink-0 gap-4 text-xs tabular-nums">
                  <span>
                    <span className="text-foreground font-medium">{m.intros}</span> intros
                  </span>
                  <span>
                    <span className="text-foreground font-medium">{pct(m.optInRate)}</span> yes
                  </span>
                  <span>{timeAgo(m.lastTouch)}</span>
                </div>
              </button>

              {expanded === m.id && (
                <div className="mt-3 space-y-2 border-t pt-3 text-sm">
                  <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                    <span>Cadence: {m.intro_cadence}</span>
                    <span>Industry: {m.industry ?? "—"}</span>
                    <span>Stage: {m.career_stage ?? "—"}</span>
                    <span>Location: {m.location ?? "—"}</span>
                    <span>
                      Intros: {m.introsPending} pending · {m.introsCompleted} landed
                    </span>
                    <span>
                      Graph: {m.relationships} links
                      {m.avgStrength === null ? "" : ` · avg ${m.avgStrength.toFixed(2)}`}
                    </span>
                    <span>Interactions: {m.interactions}</span>
                    <span>Joined: {new Date(m.created_at).toISOString().slice(0, 10)}</span>
                  </div>

                  <div>
                    <p className="text-muted-foreground mb-1 text-xs">
                      Learned preferences ({m.preferences.length})
                    </p>
                    {!m.preferences.length ? (
                      <p className="text-muted-foreground text-xs">
                        Nothing learned from replies yet.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {m.preferences.map((p, i) => (
                          <li key={i} className="text-xs">
                            <span className="text-muted-foreground">{p.kind}:</span> {p.value}{" "}
                            <span className="text-muted-foreground">
                              ({p.source.replace(/_/g, " ")}, {p.confidence.toFixed(2)})
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
