"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, MailCheck, Sparkles } from "lucide-react";

import { supabaseBrowser } from "../lib/supabase-browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the email has been requested — swaps the form for the "check your inbox" panel. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function send(addr: string) {
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabaseBrowser().auth.resetPasswordForEmail(addr, {
        // Must also be listed under Supabase → Authentication → URL Configuration,
        // or the link bounces back to the site root with no tokens.
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setSentTo(addr);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset email");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <Link href="/" className="flex items-center justify-center gap-2">
        <Sparkles className="size-5" />
        <span className="text-lg font-semibold tracking-tight">Dawn</span>
      </Link>

      <Card>
        {!sentTo && (
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Reset your password</CardTitle>
            <CardDescription>
              Enter the email you signed up with and we&apos;ll send a link to set a new password.
            </CardDescription>
          </CardHeader>
        )}
        <CardContent>
          {sentTo ? (
            <div className="space-y-4 text-center">
              <div className="bg-muted mx-auto flex size-11 items-center justify-center rounded-full">
                <MailCheck className="size-5" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight">Check your inbox</h2>
                <p className="text-muted-foreground text-sm">
                  If an account exists for{" "}
                  <span className="text-foreground font-medium">{sentTo}</span>, a reset link is on
                  its way. The link works once and expires after an hour.
                </p>
              </div>

              {error && <p className="text-destructive text-sm">{error}</p>}

              <div className="space-y-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  disabled={loading}
                  onClick={() => send(sentTo)}
                >
                  {loading && <Loader2 className="size-4 animate-spin" />}
                  Resend email
                </Button>
                <Button asChild variant="ghost" className="w-full">
                  <Link href="/login">Back to sign in</Link>
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!loading) void send(email);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>

              {error && <p className="text-destructive text-sm">{error}</p>}

              <Button type="submit" size="lg" className="w-full" disabled={loading}>
                {loading && <Loader2 className="size-4 animate-spin" />}
                Send reset link
              </Button>

              <p className="text-muted-foreground text-center text-sm">
                Remembered it?{" "}
                <Link href="/login" className="text-primary underline-offset-4 hover:underline">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
