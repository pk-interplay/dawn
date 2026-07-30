"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";

import { adminFetch } from "../../lib/admin-fetch";
import { EmptyNote, ErrorNote, Loading, ResponseBadge, StateBadge, timeAgo } from "../monitor/shared";
import { Button } from "@/components/ui/button";
import EmailCard from "./EmailCard";
import StageRail from "./StageRail";
import { STAGES, deriveStages, skippedStages, stepCaption } from "./stages";
import type { ExchangeDetail } from "./types";

const AUTOPLAY_MS = 3500;

const MATCH_DIRECTION: Record<string, string> = {
  a_offers_b_wants: "they want what A offers",
  b_offers_a_wants: "A wants what they offer",
  mutual: "mutual fit",
};

export default function Playback({ introductionId }: { introductionId: string }) {
  const [data, setData] = useState<ExchangeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setIndex(0);
    setPlaying(false);
    adminFetch<ExchangeDetail>(`/api/admin/exchange/${introductionId}`)
      .then((body) => !cancelled && setData(body))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [introductionId]);

  const steps = data?.steps ?? [];
  const total = steps.length;
  const stagesByStep = useMemo(() => deriveStages(steps), [steps]);
  const skipped = useMemo(() => skippedStages(stagesByStep), [stagesByStep]);

  const atEnd = index >= total - 1;
  const next = useCallback(() => setIndex((i) => Math.min(i + 1, Math.max(total - 1, 0))), [total]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // Autoplay stops itself at the last email rather than looping — a demo that
  // silently restarts leaves an audience unsure whether they missed a step.
  useEffect(() => {
    if (!playing) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(next, AUTOPLAY_MS);
    return () => clearTimeout(timer);
  }, [playing, atEnd, index, next]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === "ArrowRight" || event.key === " ") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back]);

  // Keep the playhead in view as emails accumulate below the fold.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [index]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading what="the exchange" />;

  const { introduction: intro } = data;
  const stage = stagesByStep[index] ?? 0;
  const reached = stagesByStep.slice(0, index + 1).reduce((max, s) => Math.max(max, s), 0);

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">
              {intro.person_a.name} <span className="text-muted-foreground font-normal">↔</span>{" "}
              {intro.person_b.name}
            </h2>
            <p className="text-muted-foreground truncate text-xs">
              {intro.person_a.headline ?? "—"} · {intro.person_b.headline ?? "—"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground text-xs">now</span>
            <StateBadge state={intro.state} />
            <ResponseBadge label={intro.person_a.name.split(" ")[0]} response={intro.a_response} />
            <ResponseBadge label={intro.person_b.name.split(" ")[0]} response={intro.b_response} />
          </div>
        </div>

        {intro.rationale && (
          <p className="text-sm">
            <span className="text-muted-foreground">Why Dawn proposed this:</span> {intro.rationale}
          </p>
        )}
        {intro.match && (
          <p className="text-muted-foreground text-xs">
            match {intro.match.score === null ? "unscored" : intro.match.score.toFixed(2)} ·{" "}
            {MATCH_DIRECTION[intro.match.direction] ?? intro.match.direction} · opened{" "}
            {timeAgo(intro.created_at)}
          </p>
        )}
      </header>

      {!total ? (
        <EmptyNote>
          This introduction has no email trail yet — it was proposed but nothing has been sent.
          Pick another from the list, or run{" "}
          <code className="text-xs">/api/cron/run-matches</code> to send the opt-in.
        </EmptyNote>
      ) : (
        <>
          <StageRail current={stage} reached={reached} skipped={skipped} />

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={back} disabled={index === 0}>
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <Button size="sm" onClick={next} disabled={atEnd}>
              Next
              <ChevronRight className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPlaying((p) => !p)}
              disabled={atEnd && !playing}
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              {playing ? "Pause" : "Play"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPlaying(false);
                setIndex(0);
              }}
              disabled={index === 0}
            >
              <RotateCcw className="size-4" />
              Restart
            </Button>
            {!atEnd && (
              <Button size="sm" variant="outline" onClick={() => setIndex(total - 1)}>
                Show all
              </Button>
            )}
            <span className="text-muted-foreground ml-auto text-xs">
              email {index + 1} of {total} · {STAGES[stage]?.label}
              <span className="ml-2 hidden sm:inline">← → to step</span>
            </span>
          </div>

          <div className="space-y-3">
            {steps.slice(0, index + 1).map((step, i) => (
              <div key={step.id} ref={i === index ? activeRef : undefined}>
                <EmailCard
                  step={step}
                  active={i === index}
                  caption={stepCaption(step, stagesByStep[i] ?? 0)}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
