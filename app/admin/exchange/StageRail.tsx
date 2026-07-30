"use client";

import { STAGES } from "./stages";

/**
 * The double opt-in, drawn once across the top so an audience can see where in
 * the protocol the current email sits.
 *
 * State rides on text and shape as well as fill: the current beat is labelled
 * "now", a skipped one is struck through with its own note, so the rail is still
 * readable without color.
 */
export default function StageRail({
  current,
  reached,
  skipped,
}: {
  current: number;
  reached: number;
  skipped: Set<number>;
}) {
  return (
    <ol className="flex flex-wrap items-stretch gap-1.5" aria-label="Introduction protocol">
      {STAGES.map((stage, i) => {
        const isCurrent = i === current;
        const isSkipped = skipped.has(i);
        const isDone = i <= reached && !isSkipped && !isCurrent;

        return (
          <li
            key={stage.key}
            aria-current={isCurrent ? "step" : undefined}
            title={stage.detail}
            className={[
              "flex min-w-0 flex-1 basis-32 flex-col gap-0.5 rounded-md border px-2.5 py-1.5 transition-colors",
              isCurrent
                ? "border-foreground/40 bg-secondary/70"
                : isDone
                  ? "border-border/60 bg-secondary/25"
                  : "border-dashed border-border/50 bg-transparent",
            ].join(" ")}
          >
            <span className="text-muted-foreground flex items-center gap-1.5 text-[10px] tracking-wide uppercase">
              <span>{String(i + 1).padStart(2, "0")}</span>
              {isCurrent && <span className="text-foreground font-medium">now</span>}
              {isSkipped && <span>skipped</span>}
            </span>
            <span
              className={[
                "truncate text-xs",
                isSkipped ? "text-muted-foreground line-through" : "",
                isCurrent ? "text-foreground font-medium" : isDone ? "text-foreground" : "text-muted-foreground",
              ].join(" ")}
            >
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
