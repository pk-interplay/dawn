"use client";

import { useEffect, useRef, useState } from "react";
import type { IntroSummary, IntroTriggerResult, MatchesResponse, PersonSummary } from "./types";
import { adminFetch } from "../lib/admin-fetch";
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
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [introResults, setIntroResults] = useState<Record<string, string>>({});
  const [introductions, setIntroductions] = useState<IntroSummary[] | null>(null);
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
    setIntroResults({});
    try {
      const res = await fetch(`/api/people/${id}/matches`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to run matchmaking");
      setData(body);
      loadIntroductions(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  }

  async function loadIntroductions(id: string) {
    try {
      const body = await adminFetch<{ introductions?: IntroSummary[] }>(
        `/api/admin/intro?person_id=${id}`,
      );
      if (Array.isArray(body.introductions)) setIntroductions(body.introductions);
    } catch {
      /* best-effort */
    }
  }

  // Fire the real intro flow (opt-in email + state machine) for a specific pair.
  async function sendIntro(
    candidateId: string,
    rationale: string,
    direction: string,
    score: number | null,
  ) {
    if (!selectedId) return;
    setSendingId(candidateId);
    try {
      const body = await adminFetch<IntroTriggerResult>(`/api/admin/intro`, {
        person_id: selectedId,
        candidate_id: candidateId,
        rationale,
        direction,
        score,
      });

      const msg = body.alreadyActive
        ? (body.note ?? "An introduction is already in progress.")
        : body.simulated
          ? `Simulated (set AGENTMAIL_API_KEY to send for real) — introduction is now ${body.state}.`
          : `Opt-in email sent to ${body.emailedTo ?? "recipient"} — introduction is now ${body.state}.`;
      setIntroResults((prev) => ({ ...prev, [candidateId]: msg }));
      loadIntroductions(selectedId);
    } catch (err) {
      setIntroResults((prev) => ({
        ...prev,
        [candidateId]: err instanceof Error ? err.message : "Something went wrong",
      }));
    } finally {
      setSendingId(null);
    }
  }

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
                <div className="space-y-1">
                  <Button
                    size="sm"
                    disabled={sendingId === m.candidate_id}
                    onClick={() => sendIntro(m.candidate_id, m.rationale, m.direction, m.score)}
                  >
                    {sendingId === m.candidate_id ? "Sending…" : "Send intro email"}
                  </Button>
                  {introResults[m.candidate_id] && (
                    <p className="text-muted-foreground text-xs">{introResults[m.candidate_id]}</p>
                  )}
                </div>
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
                {m.other?.id && (
                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={sendingId === m.other.id}
                        onClick={() =>
                          sendIntro(m.other!.id, m.rationale, m.direction, m.score)
                        }
                      >
                        {sendingId === m.other.id ? "Sending…" : "Send intro email"}
                      </Button>
                      {m.status === "suggested" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={respondingId === m.id}
                          onClick={() => respond(m.id, "rejected")}
                        >
                          Pass
                        </Button>
                      )}
                    </div>
                    {introResults[m.other.id] && (
                      <p className="text-muted-foreground text-xs">{introResults[m.other.id]}</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {introductions && introductions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Introductions</h2>
          <p className="text-muted-foreground text-sm">
            Intros Dawn has started for this person and where each one stands.
          </p>
          {introductions.map((it) => (
            <Card key={it.id}>
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium">{it.other?.name ?? "Someone"}</h3>
                  {it.other?.headline && (
                    <p className="text-muted-foreground truncate text-xs">{it.other.headline}</p>
                  )}
                </div>
                <span className="bg-secondary text-secondary-foreground shrink-0 rounded-full px-2 py-0.5 text-xs">
                  {it.state}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
