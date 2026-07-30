"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { useAuth } from "../lib/useAuth";
import { adminFetch } from "../lib/admin-fetch";
import { Button } from "@/components/ui/button";
import { EmptyNote, ErrorNote, Loading } from "./monitor/shared";
import ExchangeList, { applyFilter, type Filter } from "./exchange/ExchangeList";
import Playback from "./exchange/Playback";
import type { ExchangeSummary } from "./exchange/types";

type Gate = { status: "checking" } | { status: "ok"; email: string } | { status: "denied"; reason: string };

// Richest first: the most emails, replies breaking a tie. Whatever is showing when
// the page opens is what someone demos, so it should be the fullest exchange in
// the data rather than the most recently touched one.
function bestFirst(rows: ExchangeSummary[]): ExchangeSummary[] {
  return [...rows].sort(
    (a, b) => b.messageCount - a.messageCount || b.inboundCount - a.inboundCount,
  );
}

export default function AdminExchange() {
  const { user, loading } = useAuth();
  const [gate, setGate] = useState<Gate>({ status: "checking" });
  const [rows, setRows] = useState<ExchangeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("replied");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setGate({ status: "denied", reason: "You need to sign in." });
      return;
    }
    adminFetch<{ email: string }>("/api/admin/monitor/me")
      .then((body) => setGate({ status: "ok", email: body.email }))
      .catch((err) => setGate({ status: "denied", reason: err.message }));
  }, [loading, user]);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    adminFetch<{ exchanges: ExchangeSummary[] }>("/api/admin/exchange")
      .then((body) => {
        if (cancelled) return;
        setRows(body.exchanges);
        // Loosen the default filter rather than opening on an empty pane: a pilot
        // that hasn't had a reply yet still has opt-in emails worth showing.
        const ranked = bestFirst(body.exchanges);
        const opening =
          (["replied", "sent", "all"] as Filter[]).find((f) => applyFilter(ranked, f).length) ??
          "all";
        setFilter(opening);
        setSelectedId(applyFilter(ranked, opening)[0]?.id ?? null);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [gate.status]);

  const visible = useMemo(() => applyFilter(bestFirst(rows ?? []), filter), [rows, filter]);

  if (loading || gate.status === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </main>
    );
  }

  if (gate.status === "denied") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 px-4 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Dawn · exchange</h1>
        <p className="text-muted-foreground text-sm">{gate.reason}</p>
        {!user && (
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Dawn <span className="text-muted-foreground font-normal">· exchange</span>
          </h1>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">
            A real introduction, replayed one email at a time — and what Dawn understood
            from each reply.
          </p>
        </div>
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span>{gate.email}</span>
          <Link href="/admin/monitor" className="underline underline-offset-4">
            monitor
          </Link>
          <Link href="/admin/console" className="underline underline-offset-4">
            console
          </Link>
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      {!rows && !error && <Loading what="introductions" />}

      {rows && !rows.length && (
        <EmptyNote>
          No introductions exist yet, so there is nothing to replay. Generate counterparts with{" "}
          <code className="text-xs">npm run personas</code>, then propose the first batch with{" "}
          <code className="text-xs">/api/cron/run-matches</code> — see the runbook.
        </EmptyNote>
      )}

      {rows && rows.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-8 lg:self-start">
            <ExchangeList
              rows={visible}
              selectedId={selectedId}
              onSelect={setSelectedId}
              filter={filter}
              onFilterChange={(next) => {
                setFilter(next);
                const first = applyFilter(bestFirst(rows), next)[0]?.id ?? null;
                // Keep the current selection if the new filter still contains it.
                setSelectedId((current) =>
                  current && applyFilter(bestFirst(rows), next).some((r) => r.id === current)
                    ? current
                    : first,
                );
              }}
              totalCount={rows.length}
            />
          </aside>

          <section>
            {selectedId ? (
              <Playback key={selectedId} introductionId={selectedId} />
            ) : (
              <EmptyNote>No introduction matches this filter.</EmptyNote>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
