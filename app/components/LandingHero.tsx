"use client";

/**
 * The landing hero. Dawn's whole pitch is that an introduction arrives with a
 * reason attached, so the hero is made of the thing itself: intro cards
 * drifting behind the wordmark, each one a person and Dawn's reason for them.
 *
 * Clicking a card asks the second question — *how* do we reach them — so the
 * card opens a note about the path and the agent draws the hops it would use.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, stagger, useAnimate, useReducedMotion } from "motion/react";
import { Sparkles } from "lucide-react";

import Floating, { FloatingElement } from "@/components/ui/parallax-floating";
import { Button } from "@/components/ui/button";

type Intro = {
  name: string;
  role: string;
  reason: string;
  /** How Dawn would get to them — shown when the card is opened. */
  path: string;
  photo: string;
};

/**
 * Portrait crop for the card's 4:5 frame. The frame is 224px wide, so 672px
 * covers a 3x display — anything less and the photos look soft on Retina.
 */
const PHOTO = "q=85&w=672&h=840&auto=format&fit=crop&crop=faces";

const TAGLINE =
  "Your networking agent. It works the room you never walk into, and brings back the person you needed to meet.";

/** Time between keystrokes, and the pause before the first one. */
const TYPE_MS = 20;
const TYPE_DELAY_MS = 1400;

const INTROS: Intro[] = [
  {
    name: "Maya Chen",
    role: "Partner, Halcyon Capital",
    reason: "She led two seed rounds in climate hardware this quarter.",
    path: "Two hops. Your former CTO sits on a board with her — Dawn has the ask drafted.",
    photo: `https://images.unsplash.com/photo-1494790108377-be9c29b29330?${PHOTO}`,
  },
  {
    name: "Daniel Okafor",
    role: "Founder, Ledgerline",
    reason: "He shipped the payments rails you spent last month scoping.",
    path: "One hop. You share an investor, and she has offered to forward anything you send.",
    photo: `https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?${PHOTO}`,
  },
  {
    name: "Priya Raman",
    role: "VP Engineering, Northwind",
    reason: "She hired the last three infra leads out of your network.",
    path: "One hop. Two of those hires are people you referred — Dawn would open with that.",
    photo: `https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?${PHOTO}`,
  },
  {
    name: "Tom Alvarez",
    role: "Head of Product, Cadence",
    reason: "He solved the onboarding drop-off you described on Tuesday.",
    path: "Two hops, through a designer you both worked with in 2023.",
    photo: `https://images.unsplash.com/photo-1500648767791-00dcc994a43e?${PHOTO}`,
  },
  {
    name: "Grace Ohlsson",
    role: "Operator in residence, Interplay",
    reason: "She is scoping the same GTM hire you posted an ask for.",
    path: "Direct. She replied to Dawn this morning and asked to be put in front of you.",
    photo: `https://images.unsplash.com/photo-1534528741775-53994a69daeb?${PHOTO}`,
  },
  {
    name: "Ben Whitaker",
    role: "CTO, Arclight Health",
    reason: "He wants exactly the design partner you are looking for.",
    path: "Two hops. His head of data used to report to someone on your cap table.",
    photo: `https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?${PHOTO}`,
  },
  {
    name: "Ines Duarte",
    role: "Design lead, Faultline",
    reason: "She rebuilt the onboarding you sketched out last week.",
    path: "One hop, through the founder who sent you her write-up in the first place.",
    photo: `https://images.unsplash.com/photo-1517841905240-472988babdf9?${PHOTO}`,
  },
  {
    name: "Marcus Bell",
    role: "General Partner, Tidewater",
    reason: "He backs pre-seed infra founders in exactly your category.",
    path: "Two hops. A founder he funded last spring already vouched for you unprompted.",
    photo: `https://images.unsplash.com/photo-1527980965255-d3b416303d12?${PHOTO}`,
  },
  {
    name: "Sana Iqbal",
    role: "Founder, Quantile Labs",
    reason: "She is hiring for the role your last teammate just left.",
    path: "One hop. You have four mutuals; Dawn picked the one who answers fastest.",
    photo: `https://images.unsplash.com/photo-1544005313-94ddf0286df2?${PHOTO}`,
  },
];

/**
 * The hops Dawn would route through, per card. Two links each: enough to read
 * as a path through the network rather than a single line to nowhere.
 */
function linksFor(index: number) {
  return [(index + 1) % INTROS.length, (index + 4) % INTROS.length];
}

/**
 * One introduction, as Dawn would send it. The person leads — a full-bleed
 * portrait — and Dawn's reason rides underneath as a small callout, so a
 * glance reads as a face first and an explanation second.
 */
function IntroCard({
  intro,
  open,
  dimmed,
  onToggle,
}: {
  intro: Intro;
  open: boolean;
  dimmed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="relative">
      <motion.button
        type="button"
        initial={{ opacity: 0 }}
        data-intro-card
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        className={`border-border/70 bg-card block w-44 cursor-pointer overflow-hidden rounded-xl border text-left shadow-lg transition-[transform,opacity,box-shadow] duration-200 hover:scale-[1.03] md:w-56 ${
          open ? "ring-primary/60 scale-[1.04] shadow-xl ring-2" : ""
        } ${dimmed ? "opacity-30" : ""}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={intro.photo}
          alt=""
          className="bg-muted aspect-[4/5] w-full object-cover"
        />
        <div className="px-3 py-2.5 md:px-3.5 md:py-3">
          <p className="truncate text-sm leading-tight font-medium">{intro.name}</p>
          <p className="text-muted-foreground truncate text-[11px] leading-tight">
            {intro.role}
          </p>
          <div className="border-border/60 mt-2 border-t pt-2">
            <p className="text-muted-foreground flex items-center gap-1 text-[9px] font-medium tracking-wide uppercase">
              <Sparkles className="size-2.5 shrink-0" aria-hidden />
              Why Dawn introduced you
            </p>
            <p className="mt-1 text-[11px] leading-snug text-balance">{intro.reason}</p>
          </div>
        </div>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            onClick={(event) => event.stopPropagation()}
            className="border-border bg-popover text-popover-foreground absolute top-full left-1/2 z-10 mt-2 w-52 -translate-x-1/2 rounded-lg border p-3 shadow-xl md:w-64"
          >
            <p className="text-muted-foreground text-[9px] font-medium tracking-wide uppercase">
              How Dawn gets you there
            </p>
            <p className="mt-1.5 text-[11px] leading-snug text-balance">{intro.path}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type Placement = {
  /** Offset in px from the exact centre of the viewport, at a 1600×1000 design size. */
  x: number;
  y: number;
  /** How far the card drifts with the pointer. Deeper cards move more. */
  depth: number;
  /** Smallest breakpoint this card appears at. */
  from?: "md" | "lg";
};

/**
 * Cards are anchored to the centre of the viewport and offset from there,
 * rather than positioned in from the edges — that way the field stays balanced
 * around the wordmark instead of drifting to one side as the window widens.
 * The lower half stays deliberately sparse: opened cards drop their note
 * downward, and a crowded floor leaves nowhere for it to land.
 */
const PLACEMENT: Placement[] = [
  { x: -560, y: -150, depth: 1.5 },
  { x: 380, y: -470, depth: 2 },
  { x: 330, y: 280, depth: 3 },
  { x: -320, y: 300, depth: 1 },
  { x: -380, y: -480, depth: 2.5, from: "md" },
  { x: 780, y: -120, depth: 0.5, from: "md" },
  { x: 580, y: 110, depth: 4, from: "md" },
  { x: -820, y: -430, depth: 3, from: "lg" },
  { x: 720, y: -440, depth: 1, from: "lg" },
];

/**
 * Clamp an offset so the field contracts on narrow or short viewports instead
 * of pushing cards off-screen: the px value is the ceiling on a large window,
 * the viewport-relative value takes over on a small one.
 */
function offsetFromCentre({ x, y }: Placement) {
  const vw = x / 16;
  const vh = y / 10;
  return {
    marginLeft: x < 0 ? `max(${x}px, ${vw}vw)` : `min(${x}px, ${vw}vw)`,
    marginTop: y < 0 ? `max(${y}px, ${vh}vh)` : `min(${y}px, ${vh}vh)`,
  };
}

const VISIBILITY = {
  md: "hidden md:block",
  lg: "hidden lg:block",
} as const;

/**
 * Types the tagline out one character at a time. The full string is rendered
 * underneath at zero opacity so the block reserves its final height and the
 * button below it never jumps as the text wraps.
 */
function Typewriter({ text, onDone }: { text: string; onDone: () => void }) {
  const reduced = useReducedMotion();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (reduced) {
      setCount(text.length);
      return;
    }

    let typing: ReturnType<typeof setInterval>;
    let n = 0;
    setCount(0);
    const start = setTimeout(() => {
      typing = setInterval(() => {
        n += 1;
        setCount(n);
        if (n >= text.length) clearInterval(typing);
      }, TYPE_MS);
    }, TYPE_DELAY_MS);

    return () => {
      clearTimeout(start);
      clearInterval(typing);
    };
  }, [text, reduced]);

  const done = count >= text.length;

  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);

  return (
    <p className="text-muted-foreground relative max-w-md text-lg text-balance">
      <span aria-hidden className="invisible">
        {text}
      </span>
      <span className="absolute inset-0">
        {text.slice(0, count)}
        {!done && (
          <span className="bg-muted-foreground/70 ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.15em] animate-pulse" />
        )}
      </span>
    </p>
  );
}

export function LandingHero() {
  const [scope, animate] = useAnimate();
  const [typed, setTyped] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lineRefs = useRef<(SVGLineElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);

  const onTyped = useCallback(() => setTyped(true), []);

  useEffect(() => {
    animate(
      "[data-intro-card]",
      { opacity: [0, 1] },
      { duration: 0.5, delay: stagger(0.08) },
    );
  }, [animate]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * The connector lines are pinned to elements that the parallax is still
   * moving, so they are re-measured every frame while a card is open and the
   * endpoints written straight to the DOM — rendering three lines through
   * React state at 60fps would re-render the whole field for nothing.
   */
  useEffect(() => {
    if (selected === null) return;

    const centre = (index: number) => {
      const rect = cardRefs.current[index]?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };

    let frame: number;
    const draw = () => {
      const from = centre(selected);
      linksFor(selected).forEach((target, i) => {
        const to = centre(target);
        const line = lineRefs.current[i];
        const dot = dotRefs.current[i];
        if (!line || !dot) return;
        // A hop that is hidden at this breakpoint has no box to point at.
        const visible = from !== null && to !== null;
        line.style.opacity = visible ? "1" : "0";
        dot.style.opacity = visible ? "1" : "0";
        if (!visible) return;
        line.setAttribute("x1", String(from.x));
        line.setAttribute("y1", String(from.y));
        line.setAttribute("x2", String(to.x));
        line.setAttribute("y2", String(to.y));
        dot.setAttribute("cx", String(to.x));
        dot.setAttribute("cy", String(to.y));
      });
      frame = requestAnimationFrame(draw);
    };
    draw();

    return () => cancelAnimationFrame(frame);
  }, [selected]);

  return (
    <main
      ref={scope}
      onClick={() => setSelected(null)}
      className="bg-background relative flex h-dvh w-full items-center justify-center overflow-hidden"
    >
      <motion.div
        className="z-50 flex flex-col items-center gap-5 px-6 text-center"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.88, delay: 0.9 }}
      >
        <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">Dawn</h1>
        <Typewriter text={TAGLINE} onDone={onTyped} />
        <motion.div
          className="flex flex-col items-center gap-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: typed ? 1 : 0 }}
          transition={{ duration: 0.6 }}
        >
          <Button asChild size="xl" className="mt-1 rounded-full">
            <Link href="/join">Join</Link>
          </Button>
          <p className="text-muted-foreground text-sm">
            Already a member?{" "}
            <Link href="/login" className="text-foreground underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </motion.div>
      </motion.div>

      {/* The hops Dawn would route through, drawn over the field while a card is open. */}
      <svg
        aria-hidden
        className={`pointer-events-none fixed inset-0 z-40 h-full w-full transition-opacity duration-300 ${
          selected === null ? "opacity-0" : "opacity-100"
        }`}
      >
        {[0, 1].map((i) => (
          <g key={i}>
            <line
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              className="stroke-primary/60"
              strokeWidth={1.5}
              strokeDasharray="5 6"
            />
            <circle
              ref={(el) => {
                dotRefs.current[i] = el;
              }}
              r={4}
              className="fill-primary/70"
            />
          </g>
        ))}
      </svg>

      {/* Negative sensitivity: the cards ease away from the cursor. */}
      <Floating sensitivity={-1} className="overflow-hidden">
        {INTROS.map((intro, i) => (
          <FloatingElement
            key={intro.name}
            depth={PLACEMENT[i].depth}
            className={`top-1/2 left-1/2 ${PLACEMENT[i].from ? VISIBILITY[PLACEMENT[i].from!] : ""}`}
          >
            {/* Margins offset from the centred anchor; the parallax owns `transform`. */}
            <div
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              style={offsetFromCentre(PLACEMENT[i])}
              className={selected === i ? "relative z-[60]" : undefined}
            >
              <IntroCard
                intro={intro}
                open={selected === i}
                dimmed={selected !== null && selected !== i && !linksFor(selected).includes(i)}
                onToggle={() => setSelected((current) => (current === i ? null : i))}
              />
            </div>
          </FloatingElement>
        ))}
      </Floating>
    </main>
  );
}
