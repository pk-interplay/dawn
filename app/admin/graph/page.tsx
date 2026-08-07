"use client";

/**
 * /admin/graph — the constellation, the entity list, and the entity view.
 *
 * A separate route rather than a fifth tab on /admin/monitor. SPEC §6 says to reuse
 * monitor's shell, `requireAdmin`, and `adminFetch` — and this reuses the gate, the fetch
 * wrapper, and its shared display helpers. What it does not reuse is the tab strip:
 * monitor's four tabs all read the legacy `people`/`matches` schema and this reads the
 * claims model. Two live data models bridged only by `people_entity_map` should not sit
 * under one tab strip, because that asserts they are the same dataset. Monitor is also
 * `max-w-5xl` stacked cards, and a map plus a 300-row table wants the full width.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";

import { adminFetch } from "../../lib/admin-fetch";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { ErrorNote } from "../monitor/shared";
import { DawnMark } from "../../components/DawnMark";
import { Constellation } from "./Constellation";
import { EntitiesTable } from "./EntitiesTable";
import { EntityPanel } from "./EntityPanel";
import { UnplacedList } from "./UnplacedList";
import type { ConstellationResponse } from "./types";

type Gate = { status: "checking" } | { status: "ok"; email: string } | { status: "denied"; reason: string };

export default function GraphPage() {
  const [gate, setGate] = useState<Gate>({ status: "checking" });
  const [data, setData] = useState<ConstellationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<string>("");

  useEffect(() => {
    adminFetch<{ email: string }>("/api/admin/monitor/me")
      .then((body) => setGate({ status: "ok", email: body.email }))
      .catch((err) => setGate({ status: "denied", reason: err.message }));
  }, []);

  const load = useCallback(() => {
    setError(null);
    const query = source ? `?source=${encodeURIComponent(source)}` : "";
    adminFetch<ConstellationResponse>(`/api/admin/graph/constellation${query}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [source]);

  useEffect(() => {
    if (gate.status === "ok") load();
  }, [gate.status, load]);

  if (gate.status === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </main>
    );
  }

  if (gate.status === "denied") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 px-4 text-center">
        <h1 className="font-serif text-2xl text-dawn-bone">Dawn · network space</h1>
        <p className="text-muted-foreground text-sm">{gate.reason}</p>
        {/* signIn (POST + CSRF), not a link to /api/auth/signin — pages.signIn is
            "/", so a GET there just loops back to home. */}
        <Button onClick={() => void signIn("google", { callbackUrl: "/admin/graph" })}>
          Sign in
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-dawn-bone">
          <DawnMark idSuffix="graph" className="h-6 shrink-0 select-none" />
          <h1 className="font-serif text-[28px] leading-none tracking-[0.3px]">
            Network space
          </h1>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
          <span>{gate.email}</span>
          <Link href="/admin" className="underline underline-offset-4">
            admin
          </Link>
          <Link href="/admin/monitor" className="underline underline-offset-4">
            monitor
          </Link>
        </div>
      </header>

      {error && <ErrorNote message={error} />}

      {!data && !error && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Projecting {`{`}1536{`}`} dimensions down to two…
        </p>
      )}

      {data && (
        <div className="space-y-8">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-muted-foreground text-xs">
              Mailbox
              <SelectNative
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="ml-2 h-8 w-auto"
              >
                <option value="">All</option>
                {data.sources.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/^gmail:/, "")}
                  </option>
                ))}
              </SelectNative>
            </label>
            <Button size="sm" variant="outline" onClick={load}>
              Refresh
            </Button>
            {data.truncated && (
              <span className="text-muted-foreground text-xs">
                Showing a capped slice — more entities exist than were fetched.
              </span>
            )}
          </div>

          <Constellation data={data} selectedId={selectedId} onSelect={setSelectedId} />

          <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
            <EntitiesTable
              nodes={data.nodes}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <div>
              {selectedId ? (
                <EntityPanel entityId={selectedId} />
              ) : (
                <p className="text-muted-foreground border-dawn-btn rounded-[--radius] border border-dashed p-4 text-sm">
                  Pick a dot or a row to see every attribute, where it came from, and
                  whether it is contested or stale.
                </p>
              )}
            </div>
          </div>

          <UnplacedList nodes={data.nodes} onDone={load} />
        </div>
      )}
    </main>
  );
}
