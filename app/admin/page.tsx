/**
 * The /admin index.
 *
 * This route used to BE a tool — the "Dawn · exchange" email-thread viewer. That was
 * a mistake worth not repeating: when the index is one specific tool, the next tool
 * has to displace it or hide somewhere.
 *
 * So this is deliberately a signpost and nothing else. It holds no data, which is
 * also why it needs no gate: every destination below gates itself, and a list of
 * links leaks nothing. Adding a surface means adding a card here.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { DawnMark } from "../components/DawnMark";

export const metadata: Metadata = {
  title: "Dawn · admin",
};

const SURFACES = [
  {
    href: "/admin/graph",
    title: "Network space",
    detail:
      "Every entity plotted in its own embedding space, with relationship strength drawn between them. Click through to an entity's attributes and where each one came from.",
  },
  {
    href: "/admin/monitor",
    title: "Monitor",
    detail:
      "Read-only rollup of the legacy people/matches schema — members, matches, and the intro funnel.",
  },
];

export default function AdminIndex() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <div className="mb-12 flex items-center gap-3 text-dawn-bone">
        <DawnMark idSuffix="admin" className="h-7 shrink-0 select-none" />
        <h1 className="font-serif text-[32px] leading-none tracking-[0.3px]">
          Dawn <span className="text-muted-foreground">· admin</span>
        </h1>
      </div>

      <p className="text-dawn-head mb-4 text-[11px] font-medium tracking-[2.4px] uppercase">
        Surfaces
      </p>

      <div className="space-y-3">
        {SURFACES.map((surface, i) => (
          <Link
            key={surface.href}
            href={surface.href}
            style={{ "--dawn-delay": `${120 + i * 80}ms` } as React.CSSProperties}
            className="dawn-enter border-dawn-btn bg-card hover:border-muted-foreground/40 block rounded-[--radius] border p-5 transition-colors"
          >
            <p className="font-serif text-xl tracking-[0.2px] text-dawn-bone">{surface.title}</p>
            <p className="text-muted-foreground mt-1.5 text-sm">{surface.detail}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
