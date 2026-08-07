"use client";

import { useEffect, useRef, useState } from "react";
import type { MatchesResponse, PersonSummary } from "./types";
import { SelectNative } from "@/components/ui/select-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const DIRECTION_LABEL: Record<string, string> = {
  a_offers_b_wants: "they want what this person offers",
  b_offers_a_wants: "this person wants what they offer",
  mutual: "mutual fit",
};

export default function NetworkTab({ initialPersonId }: { initialPersonId?: string | null }) {
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [data, setData] = useState<MatchesResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const autoRanFor = useRef<string | null>(null);

  useEffect(() => {
    fetch("/api/people")
      .then((r) => r.json())
      .then((body) => setPeople(body.people ?? []));
  }, []);

  useEffect(() => {
    if (initialPersonId && initialPersonId !== autoRanFor.current) {
      setSelectedId(initialPersonId);
      autoRanFor.current = initialPersonId;
      run(initialPersonId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPersonId]);

  async function run(id: string) {
    if (!id) return;
    setRunning(true);
    setError(null);
    setSaveMessage(null);
    setData(null);
    try {
      const res = await fetch(`/api/people/${id}/matches`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to run matchmaking");
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  }

  // The "Send intro email" buttons, the /api/admin/intro trigger, and the
  // introductions list they fed were removed with the email layer. Matching itself
  // is untouched: this tab still runs candidates → rerank → save, and Pass still
  // records a rejection, which is the signal the calibration loop reads.

  async function respond(matchId: string, status: "accepted" | "rejected") {
    setRespondingId(matchId);
    try {
      const res = await fetch(`/api/match-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: matchId, status }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to update match");
      setData((prev) =>
        prev
          ? { ...prev, saved: prev.saved.map((m) => (m.id === matchId ? { ...m, status } : m)) }
          : prev,
      );
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRespondingId(null);
    }
  }

  async function generateAndSave() {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`/api/people/${selectedId}/matches`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to save matches");
      const extra =
        body.corrected || body.dropped
          ? ` (${body.corrected ?? 0} corrected, ${body.dropped ?? 0} dropped — see trace)`
          : "";
      setSaveMessage(`Saved ${body.inserted} match${body.inserted === 1 ? "" : "es"}${extra}.`);
      const refreshed = await fetch(`/api/people/${selectedId}/matches`);
      setData(await refreshed.json());
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Pick a person and step through what the matching engine actually does: vector search →
        merge → (optionally) Claude rerank with rationale.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <SelectNative value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          <option value="">Select a person…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.headline}
            </option>
          ))}
        </SelectNative>
        <Button disabled={!selectedId || running} onClick={() => run(selectedId)}>
          {running ? "Running…" : "Run matchmaking"}
        </Button>
      </div>

      {error && <p className="text-destructive text-sm">Error: {error}</p>}

      {data?.trace && (
        <div className="bg-muted/50 space-y-1.5 rounded-lg border p-3">
          {data.trace.map((line, i) => (
            <div className="flex items-start gap-2 text-sm" key={i}>
              <span className="bg-primary text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-xs">
                {i + 1}
              </span>
              <span>{line}</span>
            </div>
          ))}
        </div>
      )}

      {data?.note && (
        <p className="bg-muted text-muted-foreground rounded-md p-3 text-sm">{data.note}</p>
      )}

      <div className="space-y-3">
        {data?.mode === "similarity_only" &&
          data.candidates?.map((c) => (
            <Card key={c.id}>
              <CardContent className="space-y-2">
                <div>
                  <h3 className="font-semibold">{c.name}</h3>
                  <p className="text-muted-foreground text-sm">{c.headline}</p>
                </div>
                <p className="text-sm">
                  <span className="font-medium">Offering:</span> {c.offering}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Looking for:</span> {c.looking_for}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Similarity:</span> {c.similarity.toFixed(3)} ·{" "}
                  {DIRECTION_LABEL[c.surfaced_via]}
                </p>
              </CardContent>
            </Card>
          ))}
      </div>

      {data?.mode === "ranked" && (
        <div className="space-y-3">
          <Button disabled={saving || !data.matches?.length} onClick={generateAndSave}>
            {saving ? "Saving…" : "Generate & save these matches"}
          </Button>
          {saveMessage && <p className="text-muted-foreground text-sm">{saveMessage}</p>}
          {data.matches?.map((m) => (
            <Card key={m.candidate_id}>
              <CardContent className="space-y-2">
                <div>
                  <h3 className="font-semibold">{m.candidate?.name ?? m.candidate_id}</h3>
                  <p className="text-muted-foreground text-sm">{m.candidate?.headline}</p>
                </div>
                <p className="text-sm">
                  <span className="font-medium">Score:</span> {m.score.toFixed(2)} ·{" "}
                  {DIRECTION_LABEL[m.direction]}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Why:</span> {m.rationale}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!!data?.saved.length && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Saved matches</h2>
          {data.saved.map((m) => (
            <Card key={m.id}>
              <CardContent className="space-y-2">
                <div>
                  <h3 className="font-semibold">{m.other?.name ?? "Unknown"}</h3>
                  <p className="text-muted-foreground text-sm">{m.other?.headline}</p>
                </div>
                <p className="text-sm">
                  <span className="font-medium">Score:</span> {m.score ?? "—"} ·{" "}
                  {DIRECTION_LABEL[m.direction]} · {m.status}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Why:</span> {m.rationale}
                </p>
                {m.other?.id && m.status === "suggested" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={respondingId === m.id}
                    onClick={() => respond(m.id, "rejected")}
                  >
                    Pass
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
