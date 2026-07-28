"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Send, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  DAWN_EMAIL,
  gmailComposeUrl,
  introEmailFallback,
  type EmailDraft,
} from "@/lib/email";
import type { GeneratedProfile } from "@/lib/member";

export function IntroEmailStep({
  profile,
  onDone,
}: {
  profile: GeneratedProfile;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [copied, setCopied] = useState(false);

  // Ask Dawn to draft the intro; fall back to a local template on any failure
  // so the send step is never blocked.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/join/intro-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "draft failed");
        if (!cancelled) setDraft({ subject: body.subject, body: body.body });
      } catch {
        if (!cancelled) setDraft(introEmailFallback(profile));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile]);

  async function copyBody() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard can be unavailable; the Gmail link still carries the body */
    }
  }

  async function openInGmail() {
    if (!draft) return;
    // Copy first so a long body can be pasted even if Gmail truncates the URL.
    await copyBody();
    window.open(
      gmailComposeUrl({ to: DAWN_EMAIL, subject: draft.subject, body: draft.body }),
      "_blank",
      "noopener,noreferrer",
    );
  }

  if (!draft) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-3 px-4">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <p className="text-muted-foreground text-sm">Dawn is drafting your intro…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <div className="space-y-1 text-center">
        <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-sm">
          <Sparkles className="size-4" /> Dawn drafted your intro
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Send it to Dawn</h1>
        <p className="text-muted-foreground text-sm">
          Review and edit below, then open it in Gmail and hit send.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs tracking-wide uppercase">To</Label>
            <div className="border-input bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-sm">
              {DAWN_EMAIL}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="intro-subject">Subject</Label>
            <Input
              id="intro-subject"
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="intro-body">Message</Label>
            <Textarea
              id="intro-body"
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="min-h-64 whitespace-pre-wrap"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="lg" className="flex-1" onClick={openInGmail}>
              <ExternalLink className="size-4" /> Open in Gmail
            </Button>
            <Button size="lg" variant="outline" className="flex-1" onClick={copyBody}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied!" : "Copy email"}
            </Button>
          </div>
          <p className="text-muted-foreground text-center text-xs">
            Gmail opens with your draft prefilled. The message is also copied to your clipboard in
            case you need to paste it.
          </p>
        </CardContent>
      </Card>

      <div className="text-center">
        <Button variant="ghost" onClick={onDone}>
          <Send className="size-4" /> I&apos;ve sent it — go to my dashboard
        </Button>
      </div>
    </main>
  );
}
