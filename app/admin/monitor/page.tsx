"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { adminFetch } from "../../lib/admin-fetch";
import OverviewTab from "./OverviewTab";
import IntrosTab from "./IntrosTab";
import MembersTab from "./MembersTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

type Gate = { status: "checking" } | { status: "ok"; email: string } | { status: "denied"; reason: string };

export default function Monitor() {
  const [gate, setGate] = useState<Gate>({ status: "checking" });
  const [tab, setTab] = useState("overview");

  // One round trip decides everything. This used to check a client-side Supabase
  // session first and only then call the server — with a cookie session there is
  // nothing to pre-check, and /api/admin/monitor/me already distinguishes "not
  // signed in" (401) from "not an admin" (403) from "allowlist unset" (503). Reading
  // the answer off the server is also the only one that can't disagree with it.
  useEffect(() => {
    adminFetch<{ email: string }>("/api/admin/monitor/me")
      .then((body) => setGate({ status: "ok", email: body.email }))
      .catch((err) => setGate({ status: "denied", reason: err.message }));
  }, []);

  if (gate.status === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </main>
    );
  }

  if (gate.status === "denied") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 px-4 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Dawn · monitor</h1>
        <p className="text-muted-foreground text-sm">{gate.reason}</p>
        {/* Offered unconditionally: the server distinguishes not-signed-in from
            not-an-admin, but signing in as someone else is the only useful action
            either way, and there is no client session to branch on. */}
        <Button asChild>
          <Link href="/api/auth/signin?callbackUrl=%2Fadmin%2Fmonitor">Sign in</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Dawn <span className="text-muted-foreground font-normal">· monitor</span>
        </h1>
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span>{gate.email}</span>
          <Link href="/admin/graph" className="underline underline-offset-4">
            graph
          </Link>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="intros">Intros</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>

        {/* Each tab fetches on mount; unmounting on switch keeps the data fresh. */}
        <TabsContent value="overview">{tab === "overview" && <OverviewTab />}</TabsContent>
        <TabsContent value="intros">{tab === "intros" && <IntrosTab />}</TabsContent>
        <TabsContent value="members">{tab === "members" && <MembersTab />}</TabsContent>
      </Tabs>
    </main>
  );
}
