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
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { ArrowUp, Check, ChevronDown, Loader2, MessagesSquare, Plus, Trash2 } from "lucide-react";
import Markdown from "react-markdown";

import type { ChatThreadSummary } from "../../src/lib/chat-threads";
import type { DawnScope } from "../../src/lib/network-tools";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DawnMark } from "../components/DawnMark";

const SUGGESTIONS = [
  "Who should I be talking to this week?",
  "Who do I know at Anthropic?",
  "Who have I gone quiet on?",
  "Who could introduce me to someone at Stripe?",
];

/**
 * Human labels for the tool-status pill. Typed against the tool names so adding a tool
 * without a label is a compile error rather than a raw camelCase string leaking into
 * the UI.
 */
const TOOL_LABELS: Record<string, string> = {
  searchNetwork: "Scanning your network",
  lookupByNameOrDomain: "Checking names and companies",
  listTopConnections: "Going through who you know",
  getEntityProfile: "Pulling up their profile",
  findWarmPath: "Working out your way in",
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
  threads,
  threadId,
  initialMessages,
}: {
  firstName: string | null;
  networkSize: number;
  threads: ChatThreadSummary[];
  /** Always set, and always what `?t=` says — the page mints one before rendering. */
  threadId: string;
  initialMessages: UIMessage[];
}) {
  const router = useRouter();
  const [scope, setScope] = useState<DawnScope>("mine");
  const [input, setInput] = useState("");

  // Memoised on `scope` so flipping the toggle takes effect on the NEXT message. The
  // conversation itself deliberately survives the flip — which is exactly why
  // getEntityProfile re-checks reachability server-side instead of trusting history.
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { scope, threadId } }),
    [scope, threadId],
  );

  const { messages, sendMessage, status, error } = useChat({
    id: threadId,
    messages: initialMessages,
    transport,
  });
  const busy = status === "submitted" || status === "streaming";

  // A brand-new thread only exists in the database once its first turn lands. Refresh
  // the server component after that turn so the menu picks up its title, once.
  const announced = useRef(initialMessages.length > 0);
  useEffect(() => {
    if (announced.current || status !== "ready" || messages.length === 0) return;
    announced.current = true;
    router.refresh();
  }, [status, messages.length, router]);

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
    // Strip `q` but keep `t`, so the address still points at this conversation.
    window.history.replaceState(null, "", `${window.location.pathname}?t=${threadId}`);
  }, [sendMessage, threadId]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    void sendMessage({ text: trimmed });
  }

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-dawn-btn flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5 text-dawn-bone">
          <DawnMark idSuffix="chat" className="h-6 shrink-0 select-none" />
          <span className="font-serif text-xl leading-none tracking-[0.3px]">Dawn</span>
        </Link>
        <div className="flex items-center gap-3">
          <ThreadMenu threads={threads} activeId={threadId} />
          <ScopeToggle scope={scope} onChange={setScope} />
        </div>
      </header>

      {/*
        The scroll container is full-bleed, NOT the centred track: scrolling the track
        parks the scrollbar a few pixels off the messages in the middle of the screen,
        which reads as a stray line rather than window chrome. Centring happens on the
        inner div instead.

        The message track is deliberately wider than the composer — reading wants the
        room, typing a one-line question does not.
      */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-5xl px-6 py-8">
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
              {status === "submitted" && (
                <div className="pl-1">
                  <StatusLine label="Thinking" />
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="text-destructive mt-4 text-sm">
              {error.message || "Something went wrong."}
            </p>
          )}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="shrink-0"
      >
        <div className="mx-auto w-full max-w-3xl px-6 pb-8">
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
        </div>
      </form>
    </main>
  );
}

/**
 * Past sessions, as a dropdown beside the scope toggle.
 *
 * Hand-built rather than shadcn's `dropdown-menu`, which is not installed here — the
 * same call ScopeToggle already makes. Everything is a real navigation:
 * picking a thread goes to `/chat?t=…` and lets the server hydrate the history, which
 * beats a client fetch that would have to reconstruct message state by hand.
 */
function ThreadMenu({
  threads,
  activeId,
}: {
  threads: ChatThreadSummary[];
  activeId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const active = threads.find((thread) => thread.id === activeId);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function remove(id: string) {
    await fetch(`/api/chat/threads?id=${id}`, { method: "DELETE" });
    // Leaving the user staring at a conversation that no longer exists would be worse
    // than the extra navigation, so deleting the open thread also starts a fresh one.
    if (id === activeId) router.push(`/chat?t=${crypto.randomUUID()}`);
    else router.refresh();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="border-dawn-btn bg-card text-muted-foreground hover:text-dawn-bone flex max-w-[240px] items-center gap-2 rounded-full border px-3.5 py-2 text-xs transition-colors"
      >
        <MessagesSquare className="size-3.5 shrink-0" />
        <span className="truncate">{active?.title ?? "New chat"}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Past chats"
          className="border-dawn-btn bg-card absolute right-0 z-30 mt-2 max-h-80 w-72 overflow-y-auto rounded-2xl border p-1.5 shadow-lg"
        >
          {/* A button rather than a Link: the destination is a freshly minted id, so it
              differs on every click and there is nothing stable to put in an href. That
              is also what makes this work from an unsaved chat, where a link back to
              /chat would just be the URL you are already on and navigate nowhere. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              router.push(`/chat?t=${crypto.randomUUID()}`);
            }}
            className="text-muted-foreground hover:text-dawn-bone flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors"
          >
            <Plus className="size-3.5 shrink-0" />
            New chat
          </button>

          {threads.length > 0 && <div className="bg-dawn-btn my-1.5 h-px" />}

          {threads.map((thread) => (
            <div
              key={thread.id}
              className={cn(
                "group flex items-center gap-1 rounded-xl",
                thread.id === activeId ? "bg-dawn-btn" : "hover:bg-dawn-btn/40",
              )}
            >
              <Link
                href={`/chat?t=${thread.id}`}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={cn(
                  "min-w-0 flex-1 px-3 py-2 text-xs",
                  thread.id === activeId ? "text-dawn-bone" : "text-muted-foreground",
                )}
              >
                <span className="block truncate">{thread.title ?? "Untitled chat"}</span>
                <span className="text-dawn-head mt-0.5 block text-[10px]">
                  {relativeTime(thread.updatedAt)}
                </span>
              </Link>
              <button
                type="button"
                aria-label={`Delete ${thread.title ?? "untitled chat"}`}
                onClick={() => void remove(thread.id)}
                className="text-muted-foreground hover:text-destructive mr-2 shrink-0 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}

          {threads.length === 0 && (
            <p className="text-muted-foreground px-3 py-2 text-xs">
              No past chats yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Coarse on purpose: the menu wants "when, roughly", not a timestamp to read. */
function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
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

  // Tool parts arrive as `tool-<name>`. They're process, not answer, so they render as a
  // bare trail above the reply rather than inside a bubble — a bubble containing only
  // "Reading your strongest relationships…" reads as if that were Dawn's response.
  const steps = parts
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => TOOL_LABELS[part.type.slice("tool-".length)] ?? "Looking things up");
  const textParts = parts.filter((part) => part.type === "text" && part.text?.trim());

  return (
    <div className={cn("flex flex-col gap-2", isUser ? "items-end" : "items-start")}>
      {steps.length > 0 && (
        <div className="flex flex-col gap-1 pl-1">
          {steps.map((label, i) => (
            <StatusLine
              key={i}
              label={label}
              // Only the last step is still in flight once text starts arriving.
              done={i < steps.length - 1 || textParts.length > 0}
            />
          ))}
        </div>
      )}

      {textParts.length > 0 && (
        <div
          className={cn(
            "max-w-[72%] rounded-3xl px-4 py-2.5",
            isUser ? "bg-dawn-btn text-dawn-bone" : "bg-card text-foreground",
          )}
        >
          {textParts.map((part, i) => (
            <div key={i} className={MARKDOWN_CLASSES}>
              <Markdown>{part.text ?? ""}</Markdown>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One line of "here's what Dawn is doing". In flight it shimmers; finished, it settles
 * into a dim check so the trail reads as a record of the work rather than stale spinners.
 */
function StatusLine({ label, done = false }: { label: string; done?: boolean }) {
  return (
    <p className="dawn-enter text-muted-foreground flex items-center gap-2 text-xs">
      {done ? (
        <Check className="size-3 shrink-0 opacity-60" strokeWidth={2.5} />
      ) : (
        <Loader2 className="size-3 shrink-0 animate-spin opacity-70" strokeWidth={2.5} />
      )}
      <span className={cn(!done && "dawn-working")}>
        {label}
        {done ? "" : "…"}
      </span>
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
        {networkSize.toLocaleString()} people in your network. Dawn knows who you email
        and meet, and how recently — never what was said.
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
        There&rsquo;s no one to search yet, so every question would come back empty.
        Connecting Gmail takes a minute and only happens once.
      </p>
      <Button variant="pill" size="pill" asChild className="dawn-shimmer mt-8">
        <Link href="/onboarding">Sync my network</Link>
      </Button>
    </div>
  );
}
