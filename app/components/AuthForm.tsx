"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, MailCheck } from "lucide-react";

import { supabaseBrowser } from "../lib/supabase-browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "signup" | "signin";

interface AuthFormProps {
  /** Which flow to start in. Users can toggle between them. */
  initialMode?: Mode;
  /** Optional label for the primary button on sign up (e.g. "Create account & save profile"). */
  signupCta?: string;
  /** Called once a session is established. */
  onAuthed?: () => void;
  /** Fires when the form swaps to (or leaves) the "check your inbox" panel, so pages can drop their own heading. */
  onPendingChange?: (pending: boolean) => void;
}

export function AuthForm({
  initialMode = "signin",
  signupCta,
  onAuthed,
  onPendingChange,
}: AuthFormProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set once a confirmation email is on its way — swaps the form for the "check your inbox" panel. */
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  function showInbox(addr: string | null) {
    setPendingEmail(addr);
    onPendingChange?.(addr !== null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    // The inline message under the confirm field is already showing at this point.
    if (mode === "signup" && password !== confirmPassword) return;
    setLoading(true);
    setError(null);
    setNotice(null);

    const supabase = supabaseBrowser();
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        // With email confirmation enabled, there's no session yet.
        if (!data.session) {
          showInbox(email);
          setPassword("");
          setConfirmPassword("");
          setMode("signin");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      onAuthed?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      // Signing in before clicking the confirmation link lands here — say so plainly.
      if (/not confirmed/i.test(message)) {
        showInbox(email);
        setPassword("");
        setConfirmPassword("");
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    if (!pendingEmail || loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const { error } = await supabaseBrowser().auth.resend({
        type: "signup",
        email: pendingEmail,
      });
      if (error) throw error;
      setNotice("Sent again — it can take a minute to arrive.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend the email");
    } finally {
      setLoading(false);
    }
  }

  const primaryLabel =
    mode === "signup" ? signupCta ?? "Create account" : "Sign in";

  // Hold off on the warning until they've started the second field, so it doesn't
  // flash the moment the first character of the password is typed.
  const mismatch =
    mode === "signup" && confirmPassword.length > 0 && password !== confirmPassword;

  // Confirmation pending: hide the inputs entirely so the next step is the only thing on screen.
  if (pendingEmail) {
    return (
      <div className="space-y-4 text-center">
        <div className="bg-muted mx-auto flex size-11 items-center justify-center rounded-full">
          <MailCheck className="size-5" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">Open the email in your inbox</h2>
          <p className="text-muted-foreground text-sm">
            We sent a confirmation link to <span className="text-foreground font-medium">{pendingEmail}</span>.
            Click it to activate your account, then come back here and sign in.
          </p>
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}
        {notice && <p className="text-muted-foreground text-sm">{notice}</p>}

        <div className="space-y-2">
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={loading}
            onClick={() => {
              showInbox(null);
              setError(null);
              setNotice(null);
            }}
          >
            I&apos;ve confirmed — sign in
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={loading}
            onClick={onResend}
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            Resend email
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
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
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          {mode === "signin" && (
            <Link
              href="/forgot-password"
              className="text-muted-foreground text-sm underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          )}
        </div>
        <Input
          id="password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>

      {mode === "signup" && (
        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm password</Label>
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
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="size-4 animate-spin" />}
        {primaryLabel}
      </Button>

      <p className="text-muted-foreground text-center text-sm">
        {mode === "signup" ? "Already have an account?" : "New to Dawn?"}{" "}
        <button
          type="button"
          className="text-primary underline-offset-4 hover:underline"
          onClick={() => {
            setMode(mode === "signup" ? "signin" : "signup");
            setConfirmPassword("");
            setError(null);
            setNotice(null);
          }}
        >
          {mode === "signup" ? "Sign in" : "Create an account"}
        </button>
      </p>
    </form>
  );
}
