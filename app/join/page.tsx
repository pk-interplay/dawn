"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Paperclip, Send, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadMember, saveMember, type GeneratedProfile } from "@/lib/member";
import { useAuth } from "../lib/useAuth";
import { AuthForm } from "../components/AuthForm";
import { WelcomeStep } from "../components/WelcomeStep";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const GREETING =
  "I'm Dawn. I'll get to know your career and what you're reaching for, then build your profile. Tell me what you're working on and where you want to go — or upload your LinkedIn PDF and I'll take it from there.";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Join() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedMember, setCheckedMember] = useState(false);
  // Profile Dawn built and saved — advances the flow to the "email Dawn" step.
  const [savedProfile, setSavedProfile] = useState<GeneratedProfile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Already onboarded on this device? Skip the chat and go to the dashboard.
  useEffect(() => {
    if (loadMember()) {
      router.replace("/me");
    } else {
      setCheckedMember(true);
    }
  }, [router]);

  // Persist the freshly built profile to the `people` table, remember who we
  // are, then advance to the intro-email step.
  async function persistAndGo(profile: GeneratedProfile) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: profile.name,
          headline: profile.headline,
          bio: profile.summary,
          offering: profile.offering,
          looking_for: profile.looking_for,
          goals: profile.goals,
          background: profile.background,
          tags: profile.tags,
          // Contact + scheduling: the member is already signed in, so use their
          // auth email/id, and capture the browser's timezone for coordinating times.
          email: user?.email ?? null,
          user_id: user?.id ?? null,
          timezone:
            typeof Intl !== "undefined"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : null,
          // Matches what the disclosure below the composer promises. Without this
          // every member silently landed on the 'weekly' column default. 'burst' is
          // the pilot tier — at most one introduction every six hours, i.e. up to
          // four a day (see CADENCE_DAYS in /api/cron/run-matches). Move members to
          // 'daily' after the pilot.
          intro_cadence: "burst",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't save your profile");
      saveMember({ id: body.person.id, profile });
      setSavedProfile(profile);
      setSaving(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your profile");
      setSaving(false);
    }
  }

  async function send(text: string, pdf?: { data: string; mediaType: string }) {
    const userMessage: ChatMessage = { role: "user", content: text };
    const next = [...messages, userMessage];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    // Anthropic requires the conversation to start with a user turn — drop the intro greeting.
    const firstUser = next.findIndex((m) => m.role === "user");
    const payload = next.slice(firstUser < 0 ? 0 : firstUser);

    try {
      const res = await fetch("/api/join/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload, pdf }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Something went wrong");

      if (body.type === "profile") {
        const profile = body.profile as GeneratedProfile;
        setLoading(false);
        // Sign-in happens before the chat, so we can save straight away.
        await persistAndGo(profile);
        return;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: body.text }]);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;
    send(input.trim());
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || loading) return;
    try {
      setLoading(true);
      const data = await fileToBase64(file);
      await send(`I've uploaded my LinkedIn export: ${file.name}`, {
        data,
        mediaType: file.type || "application/pdf",
      });
    } catch {
      setError("Couldn't read that file.");
      setLoading(false);
    }
  }

  // Avoid a flash of the chat while we check for an existing member / session,
  // and keep a spinner up while we save the profile.
  if (!checkedMember || authLoading || saving) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </main>
    );
  }

  // Sign in first — the chat and everything after it require a session.
  if (!user) {
    return <SignInGate />;
  }

  // Profile saved — tell them they're in and what to expect. (This replaced a
  // "draft an email to Dawn and send it from Gmail" handoff: Dawn already has the
  // profile, so the send was busywork at the moment joining should feel like an
  // arrival. IntroEmailStep is still in the tree for the manual-intro flow.)
  if (savedProfile) {
    return <WelcomeStep profile={savedProfile} onDone={() => router.push("/me")} />;
  }

  // Ephemeral view: only ever surface the most recent exchange — your last
  // message sitting above Dawn's latest reply — everything else fades away.
  const lastUser = [...messages].reverse().find((m) => m.role === "user") ?? null;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") ?? null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-8 px-4">
      <header className="flex items-center gap-2">
        <Sparkles className="size-5" />
        <span className="text-lg font-semibold tracking-tight">Dawn</span>
      </header>

      <div className="flex w-full flex-col items-center gap-6 text-center">
        {lastUser && (
          <p className="text-muted-foreground max-w-[85%] text-sm leading-relaxed whitespace-pre-wrap">
            {lastUser.content}
          </p>
        )}
        {loading ? (
          <p className="text-muted-foreground flex items-center justify-center gap-2 text-lg">
            <Loader2 className="size-4 animate-spin" />
            Dawn is thinking…
          </p>
        ) : (
          lastAssistant && (
            <p className="max-w-[85%] text-lg leading-relaxed whitespace-pre-wrap text-foreground">
              {lastAssistant.content}
            </p>
          )
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>

      {/*
        Say what Dawn will actually do before someone hands over their profile.
        Onboarding previously never mentioned that joining means Dawn starts
        emailing you unprompted, or that anyone can stop it — so the first intro
        arrived as a surprise and the only discoverable way out was to ignore it.
      */}
      <p className="text-muted-foreground max-w-md text-center text-xs leading-relaxed">
        Once your profile is built, Dawn will email you a few introductions a day for
        the next few days, and will always ask before sharing your details with
        anyone. Reply &ldquo;unsubscribe&rdquo; to any email to stop.
      </p>

      <form onSubmit={onSubmit} className="w-full space-y-2">
        <div className="border-input focus-within:border-ring focus-within:ring-ring/50 flex items-end gap-2 rounded-xl border p-2 focus-within:ring-[3px]">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={onFile}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Upload LinkedIn PDF"
            disabled={loading}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            rows={1}
            placeholder="Tell Dawn about your work and goals…"
            className="max-h-32 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none"
          />
          <Button type="submit" size="icon" disabled={loading || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </div>
        <p className="text-muted-foreground text-center text-xs">
          Share your goals, or upload your LinkedIn PDF to get in.
        </p>
      </form>
    </main>
  );
}

// Gate shown before the chat: authenticate (or create an account) to meet Dawn.
function SignInGate() {
  const [awaitingEmail, setAwaitingEmail] = useState(false);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-1 text-center">
        <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-sm">
          <Sparkles className="size-4" /> Dawn
        </p>
        {!awaitingEmail && (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">Sign in to meet Dawn</h1>
            <p className="text-muted-foreground">
              Create an account, then Dawn will get to know you and help you introduce yourself.
            </p>
          </>
        )}
      </div>

      <Card>
        {!awaitingEmail && (
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Welcome</CardTitle>
            <CardDescription>Sign in or create an account to get started.</CardDescription>
          </CardHeader>
        )}
        <CardContent>
          <AuthForm
            initialMode="signup"
            signupCta="Create account & continue"
            onPendingChange={setAwaitingEmail}
          />
        </CardContent>
      </Card>
    </main>
  );
}
