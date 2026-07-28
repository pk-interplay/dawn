"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { useAuth } from "../lib/useAuth";
import { AuthForm } from "../components/AuthForm";
import { loadMember } from "@/lib/member";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Login() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [awaitingEmail, setAwaitingEmail] = useState(false);

  // Once signed in, go to the dashboard if this device is already onboarded,
  // otherwise into onboarding to build a profile.
  useEffect(() => {
    if (!loading && user) {
      router.replace(loadMember() ? "/me" : "/join");
    }
  }, [loading, user, router]);

  if (loading || user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <Link href="/" className="flex items-center justify-center gap-2">
        <Sparkles className="size-5" />
        <span className="text-lg font-semibold tracking-tight">Dawn</span>
      </Link>

      <Card>
        {!awaitingEmail && (
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Sign in</CardTitle>
            <CardDescription>Welcome back. Log in to your Dawn account.</CardDescription>
          </CardHeader>
        )}
        <CardContent>
          <AuthForm initialMode="signin" onPendingChange={setAwaitingEmail} />
        </CardContent>
      </Card>
    </main>
  );
}
