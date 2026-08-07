"use client";

/**
 * Dawn's chat surface. Structure ported from nexus's ChatUI; every primitive rewritten.
 *
 * nexus's `ui/*` components wrap `@base-ui/react` (shadcn "base-nova"); dawn-v0 is
 * Radix-backed "new-york". So the shell, the pill toggle, and the composer are built
 * from dawn-v0's own primitives and the indigo/Sentient design language rather than
 * copied across.
 *
 * The suggestion chips are also NOT nexus's. One of its four was "summarize my
 * relationship with my most recent contact", which this graph cannot answer at all —
 * ingest is metadata-only, so no message content exists. Shipping a prompt suggestion
 * the product must refuse is worse than having one fewer.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUp, Loader2 } from "lucide-react";
import Markdown from "react-markdown";

import type { DawnScope } from "../../src/lib/network-tools";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DawnMark } from "../components/DawnMark";

const SUGGESTIONS = [
  "Who are my most active relationships?",
  "Who do I know at Anthropic?",
  "Who haven't I talked to in a while?",
  "Who could introduce me to someone at Stripe?",
];

/**
 * Human labels for the tool-status pill. Typed against the tool names so adding a tool
 * without a label is a compile error rather than a raw camelCase string leaking into
 * the UI.
 */
const TOOL_LABELS: Record<string, string> = {
  searchNetwork: "Searching the network",
  lookupByNameOrDomain: "Looking up names and domains",
  listTopConnections: "Reading your strongest relationships",
  getEntityProfile: "Pulling up their profile",
  findWarmPath: "Finding who can introduce you",
};

// Tailwind can't reach into react-markdown's output, so the prose styles are applied
// with arbitrary variants. Deliberately not @tailwindcss/typography: it brings a whole
// type scale that fights the Dawn tokens for the sake of five element selectors.
const MARKDOWN_CLASSES = cn(
  "text-sm leading-relaxed",
  "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_strong]:font-semibold [&_strong]:text-dawn-bone",
  "[&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]",
);

export function ChatSurface({
  firstName,
  networkSize,
}: {
  firstName: string | null;
  networkSize: number;
}) {
  const [scope, setScope] = useState<DawnScope>("mine");
  const [input, setInput] = useState("");

  // Memoised on `scope` so flipping the toggle takes effect on the NEXT message. The
  // conversation itself deliberately survives the flip — which is exactly why
  // getEntityProfile re-checks reachability server-side instead of trusting history.
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { scope } }),
    [scope],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  // The home page's starter questions link here as `/chat?q=…`. Fire that once on
  // mount and strip it from the URL, so a refresh doesn't resend and the address bar
  // doesn't keep a stale prompt around. Reading location directly (not
  // useSearchParams) keeps this out of a Suspense boundary.
  const firedInitial = useRef(false);
  useEffect(() => {
    if (firedInitial.current) return;
    const q = new URLSearchParams(window.location.search).get("q")?.trim();
    if (!q) return;
    firedInitial.current = true;
    void sendMessage({ text: q });
    window.history.replaceState(null, "", window.location.pathname);
  }, [sendMessage]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    void sendMessage({ text: trimmed });
  }

  return (
    <main className="flex h-screen flex-col pl-[72px]">
      <header className="border-dawn-btn flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5 text-dawn-bone">
          <DawnMark idSuffix="chat" className="h-6 shrink-0 select-none" />
          <span className="font-serif text-xl leading-none tracking-[0.3px]">Dawn</span>
        </Link>
        <ScopeToggle scope={scope} onChange={setScope} />
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden px-6">
        <div className="flex-1 overflow-y-auto py-8">
          {messages.length === 0 ? (
            networkSize === 0 ? (
              <EmptyNoNetwork />
            ) : (
              <EmptyWithSuggestions firstName={firstName} networkSize={networkSize} onPick={submit} />
            )
          ) : (
            <div className="space-y-5">
              {messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}
              {status === "submitted" && <StatusPill label="Thinking" />}
            </div>
          )}

          {error && (
            <p className="text-destructive mt-4 text-sm">
              {error.message || "Something went wrong."}
            </p>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="shrink-0 pb-8"
        >
          <div className="border-dawn-btn bg-dawn-input flex items-center gap-2 rounded-full border px-2 py-1.5 pl-5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your network…"
              aria-label="Ask about your network"
              className="text-foreground placeholder:text-muted-foreground h-9 flex-1 bg-transparent text-sm outline-none"
            />
            <Button
              type="submit"
              size="icon"
              variant="secondary"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="size-9 shrink-0 rounded-full"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" strokeWidth={2.5} />
              )}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}

function ScopeToggle({
  scope,
  onChange,
}: {
  scope: DawnScope;
  onChange: (scope: DawnScope) => void;
}) {
  const options: Array<{ value: DawnScope; label: string; hint: string }> = [
    { value: "mine", label: "My network", hint: "Only contacts you synced from your own mailbox" },
    { value: "all", label: "Everyone's", hint: "Every teammate's contacts too, for warm intros" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Search scope"
      className="border-dawn-btn bg-card flex shrink-0 items-center gap-1 rounded-full border p-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={scope === option.value}
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-xs transition-colors",
            scope === option.value
              ? "bg-dawn-btn text-dawn-bone"
              : "text-muted-foreground hover:text-dawn-bone",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** `parts` is the AI SDK v7 message shape: interleaved text and tool invocations. */
interface UIMessageLike {
  id: string;
  role: string;
  parts?: Array<{ type: string; text?: string }>;
}

function Message({ message }: { message: UIMessageLike }) {
  const isUser = message.role === "user";
  const parts = message.parts ?? [];

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-3xl px-4 py-2.5",
          isUser ? "bg-dawn-btn text-dawn-bone" : "bg-card text-foreground",
        )}
      >
        {parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <div key={i} className={MARKDOWN_CLASSES}>
                <Markdown>{part.text ?? ""}</Markdown>
              </div>
            );
          }
          // Tool parts arrive as `tool-<name>`; show what Dawn is doing, not the payload.
          if (part.type.startsWith("tool-")) {
            const name = part.type.slice("tool-".length);
            return <StatusPill key={i} label={TOOL_LABELS[name] ?? "Looking things up"} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

function StatusPill({ label }: { label: string }) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
      <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full" />
      {label}…
    </p>
  );
}

function EmptyWithSuggestions({
  firstName,
  networkSize,
  onPick,
}: {
  firstName: string | null;
  networkSize: number;
  onPick: (text: string) => void;
}) {
  return (
    <div className="dawn-enter">
      <h1 className="font-serif text-[32px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
        {firstName ? `What are you looking for, ${firstName}?` : "What are you looking for?"}
      </h1>
      <p className="text-muted-foreground mt-3 text-sm">
        {networkSize.toLocaleString()} relationships in your network. Dawn knows who you
        email and meet, and how recently — never what was said.
      </p>

      <p className="text-dawn-head mt-10 text-[11px] font-medium tracking-[2.4px] uppercase">
        Try asking
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="border-dawn-btn bg-card text-muted-foreground hover:text-dawn-bone hover:border-muted-foreground/40 rounded-full border px-3.5 py-2 text-xs transition-colors"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyNoNetwork() {
  return (
    <div className="dawn-enter">
      <h1 className="font-serif text-[32px] leading-[1.15] tracking-[0.2px] text-dawn-bone">
        Dawn hasn&rsquo;t synced your network yet.
      </h1>
      <p className="text-muted-foreground mt-3 text-sm">
        There are no relationships to search, so every question would come back empty.
        Connecting Gmail takes a minute and only happens once.
      </p>
      <Button variant="pill" size="pill" asChild className="dawn-shimmer mt-8">
        <Link href="/onboarding">Sync my network</Link>
      </Button>
    </div>
  );
}
