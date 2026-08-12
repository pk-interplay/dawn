"use client";

/**
 * The home screen's way in: a real composer, not four fixed links.
 *
 * The four starter questions were the only way to open the chat, so anything they
 * didn't cover — and "here's what I'm working on now" was the big one — needed a page
 * of its own. This asks the open question instead, and keeps starters underneath as
 * examples of what to type rather than as the whole menu.
 *
 * Typing here does NOT start a conversation here. It navigates to /chat?q=…, and that
 * page mints the thread id and fires the first message on mount (see ChatSurface). One
 * chat surface, one place that owns `useChat` state, one URL that a conversation lives
 * at — a second composer that streamed in place would need its own copy of all of it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Half find-someone, half tell-Dawn-something. The profile ones are here because the
 * only way anyone learns Dawn will maintain their profile in conversation is by seeing
 * it offered — nothing else on this screen says so.
 */
const STARTERS = [
  "Who should I be talking to this week?",
  "Here's what I'm working on now…",
  "Who could introduce me to someone at Stripe?",
  "Update what I'm looking for",
];

export function HomeComposer() {
  const router = useRouter();
  const [input, setInput] = useState("");

  function go(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    router.push(`/chat?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <div
      style={{ "--dawn-delay": "380ms" } as React.CSSProperties}
      className="dawn-enter w-full max-w-[560px] px-6"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(input);
        }}
      >
        <div className="border-dawn-btn bg-dawn-input flex items-center gap-2 rounded-full border px-2 py-1.5 pl-5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your network, or tell Dawn what you're working on…"
            aria-label="Ask about your network, or tell Dawn what you're working on"
            className="text-foreground placeholder:text-muted-foreground h-9 flex-1 bg-transparent text-sm outline-none"
          />
          <Button
            type="submit"
            size="icon"
            variant="secondary"
            disabled={!input.trim()}
            aria-label="Send"
            className="size-9 shrink-0 rounded-full"
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </Button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {STARTERS.map((starter, i) => (
          <button
            key={starter}
            type="button"
            // The open-ended ones are sent as written: "Here's what I'm working on now…"
            // arrives as a message, and Dawn asks what it is. That is the intended shape
            // of the exchange, not a prompt that lost its ending.
            onClick={() => go(starter)}
            style={{ "--dawn-delay": `${420 + i * 60}ms` } as React.CSSProperties}
            className={cn(
              "dawn-enter border-dawn-btn bg-card text-muted-foreground rounded-full border",
              "hover:text-dawn-bone hover:border-muted-foreground/40 px-3.5 py-2 text-xs transition-colors",
            )}
          >
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}
