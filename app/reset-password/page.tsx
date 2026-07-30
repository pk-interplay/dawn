"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";

import { supabaseBrowser } from "../lib/supabase-browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** checking: still resolving the recovery link; invalid: no usable session; ready: can set a password. */
type Stage = "checking" | "invalid" | "ready" | "done";

export default function ResetPassword() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Message from the link itself (expired / already used), which arrives in the URL fragment. */
  const [linkError, setLinkError] = useState<string | null>(null);

  // The recovery link lands here with the session in the URL fragment; the browser
  // client consumes it on construction, so by the time getSession() resolves there
  // is either a session to update or nothing usable.
  useEffect(() => {
    const supabase = supabaseBrowser();

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const described = hash.get("error_description") ?? hash.get("error");
    if (described) {
      setLinkError(described.replace(/\+/g, " "));
      setStage("invalid");
      return;
    }

    let live = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setStage(data.session ? "ready" : "invalid");
    });

    // A PASSWORD_RECOVERY event can land after the first getSession() settles.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (live && session) setStage((prev) => (prev === "done" ? prev : "ready"));
    });

    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading || password !== confirmPassword) return;
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabaseBrowser().auth.updateUser({ password });
      if (error) throw error;
      setStage("done");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the password");
    } finally {
      setLoading(false);
    }
  }

  // Hold the warning until the second field has been started, matching AuthForm.
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <Link href="/" className="flex items-center justify-center gap-2">
        <Sparkles className="size-5" />
        <span className="text-lg font-semibold tracking-tight">Dawn</span>
      </Link>

      <Card>
        {stage === "ready" && (
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Choose a new password</CardTitle>
            <CardDescription>You&apos;ll stay signed in on this device.</CardDescription>
          </CardHeader>
        )}
        <CardContent>
          {stage === "checking" && (
            <div className="flex justify-center py-6">
              <Loader2 className="text-muted-foreground size-6 animate-spin" />
            </div>
          )}

          {stage === "invalid" && (
            <div className="space-y-4 text-center">
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight">This link isn&apos;t valid</h2>
                <p className="text-muted-foreground text-sm">
                  {linkError ??
                    "Reset links work once and expire after an hour. Request a fresh one and open it from the same browser."}
                </p>
              </div>
              <Button asChild size="lg" className="w-full">
                <Link href="/forgot-password">Send a new link</Link>
              </Button>
            </div>
          )}

          {stage === "done" && (
            <div className="space-y-4 text-center">
              <div className="bg-muted mx-auto flex size-11 items-center justify-center rounded-full">
                <CheckCircle2 className="size-5" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight">Password updated</h2>
                <p className="text-muted-foreground text-sm">
                  Use it the next time you sign in.
                </p>
              </div>
              <Button
                type="button"
                size="lg"
                className="w-full"
                onClick={() => router.replace("/me")}
              >
                Continue to Dawn
              </Button>
            </div>
          )}

          {stage === "ready" && (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  aria-invalid={mismatch}
                  aria-describedby={mismatch ? "confirm-password-error" : undefined}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                />
                {mismatch && (
                  <p id="confirm-password-error" className="text-destructive text-sm">
                    These don&apos;t match
                  </p>
                )}
              </div>

              {error && <p className="text-destructive text-sm">{error}</p>}

              <Button type="submit" size="lg" className="w-full" disabled={loading}>
                {loading && <Loader2 className="size-4 animate-spin" />}
                Save password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
