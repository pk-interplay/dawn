"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type GeneratedProfile } from "@/lib/member";
import type { Cadence, OnboardingQuestion, SelectedPreference } from "@/lib/onboarding";
import { supabaseBrowser } from "../lib/supabase-browser";
import { useMember } from "../lib/useMember";
import { AuthForm } from "../components/AuthForm";
import { UploadStep } from "../components/UploadStep";
import { OnboardingForm } from "../components/OnboardingForm";
import { WelcomeStep } from "../components/WelcomeStep";

/**
 * Joining Dawn, in three screens: sign in, upload, one form.
 *
 * This replaced a chat. Dawn used to interview the member one question at a time,
 * which read as thoughtful for two turns and as an intake form after that — and
 * because the limit lived in a prompt, there was nothing actually stopping it. The
 * work is the same (understand them, then learn their preferences); the difference
 * is that the member can now see how much is left.
 */

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
  // Read straight off the URL rather than useSearchParams(), which forces this
  // page out of static prerendering and needs a Suspense boundary.
  const [redo] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("redo"),
  );
  const { member, loading: authLoading, signedIn, setMember } = useMember();

  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Set once the upload has been read — advances to the questions. */
  const [draft, setDraft] = useState<{
    profile: GeneratedProfile;
    questions: OnboardingQuestion[];
  } | null>(null);
  /** Set once the profile is saved — advances to "you're in". */
  const [savedProfile, setSavedProfile] = useState<GeneratedProfile | null>(null);

  // Already onboarded on this account? Skip straight to the dashboard — unless
  // they came here from "Start over" to rebuild the profile deliberately.
  useEffect(() => {
    if (!authLoading && member && !redo) router.replace("/me");
  }, [authLoading, member, redo, router]);

  /** Step one: turn a LinkedIn export (or a description) into a profile + questions. */
  async function build({ text, file }: { text?: string; file?: File }) {
    setBuilding(true);
    setError(null);
    try {
      const pdf = file
        ? { data: await fileToBase64(file), mediaType: file.type || "application/pdf" }
        : undefined;

      const res = await fetch("/api/join/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, pdf }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't build your profile");

      setDraft({ profile: body.profile, questions: body.questions });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build your profile");
    } finally {
      setBuilding(false);
    }
  }

  /** Step two: persist the profile and the answers, then advance. */
  async function save({
    preferences,
    cadence,
  }: {
    preferences: SelectedPreference[];
    cadence: Cadence;
  }) {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      // The session token identifies the member; the server reads their id and
      // email off it rather than trusting the body, so the row is bound to the
      // account and a return visit can find it again.
      const { data: sessionData } = await supabaseBrowser().auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session expired — sign in again");

      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: draft.profile.name,
          headline: draft.profile.headline,
          bio: draft.profile.summary,
          offering: draft.profile.offering,
          looking_for: draft.profile.looking_for,
          goals: draft.profile.goals,
          background: draft.profile.background,
          tags: draft.profile.tags,
          // Identity comes from the bearer token above. This is just the browser
          // timezone, for coordinating meeting times.
          timezone:
            typeof Intl !== "undefined"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : null,
          // Both now come from the form rather than a column default.
          intro_cadence: cadence,
          preferences,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't save your profile");

      setMember({ id: body.person.id, profile: draft.profile, userId: body.person.user_id });
      setSavedProfile(draft.profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your profile");
    } finally {
      setSaving(false);
    }
  }

  // Avoid a flash of onboarding while we check for an existing member / session.
  if (authLoading || (member && !redo)) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </main>
    );
  }

  if (!signedIn) return <SignInGate />;

  if (savedProfile) {
    return <WelcomeStep profile={savedProfile} onDone={() => router.push("/me")} />;
  }

  if (draft) {
    return (
      <OnboardingForm
        profile={draft.profile}
        questions={draft.questions}
        saving={saving}
        error={error}
        onSubmit={save}
      />
    );
  }

  return <UploadStep loading={building} error={error} onSubmit={build} />;
}

// Gate shown before onboarding: authenticate (or create an account) to meet Dawn.
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
              Create an account, then Dawn will build your profile and get you your first
              introductions.
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
