"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { useAuth } from "../../lib/useAuth";
import { adminFetch } from "../../lib/admin-fetch";
import OverviewTab from "./OverviewTab";
import IntrosTab from "./IntrosTab";
import InboxTab from "./InboxTab";
import MembersTab from "./MembersTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

type Gate = { status: "checking" } | { status: "ok"; email: string } | { status: "denied"; reason: string };

export default function Monitor() {
  const { user, loading } = useAuth();
  const [gate, setGate] = useState<Gate>({ status: "checking" });
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setGate({ status: "denied", reason: "You need to sign in." });
      return;
    }
    adminFetch<{ email: string }>("/api/admin/monitor/me")
      .then((body) => setGate({ status: "ok", email: body.email }))
      .catch((err) => setGate({ status: "denied", reason: err.message }));
  }, [loading, user]);

  if (loading || gate.status === "checking") {
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
        {!user && (
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        )}
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
          <Link href="/admin" className="underline underline-offset-4">
            console
          </Link>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="intros">Intros</TabsTrigger>
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>

        {/* Each tab fetches on mount; unmounting on switch keeps the data fresh. */}
        <TabsContent value="overview">{tab === "overview" && <OverviewTab />}</TabsContent>
        <TabsContent value="intros">{tab === "intros" && <IntrosTab />}</TabsContent>
        <TabsContent value="inbox">{tab === "inbox" && <InboxTab />}</TabsContent>
        <TabsContent value="members">{tab === "members" && <MembersTab />}</TabsContent>
      </Tabs>
    </main>
  );
}
