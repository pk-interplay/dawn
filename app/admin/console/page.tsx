"use client";

import { useState } from "react";
import Link from "next/link";
import SearchTab from "../../components/SearchTab";
import NetworkTab from "../../components/NetworkTab";
import SubmitAskTab from "../../components/SubmitAskTab";
import ProfilesTab from "../../components/ProfilesTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tab = "search" | "network" | "submit" | "profiles";

// The operator console that used to live at /admin, moved here when /admin became
// the exchange demo. Same tabs, same components — search, profiles, network and
// the manual ask that triggers a real introduction.
export default function Console() {
  const [tab, setTab] = useState<Tab>("search");
  const [networkPersonId, setNetworkPersonId] = useState<string | null>(null);

  function goToNetwork(id: string) {
    setNetworkPersonId(id);
    setTab("network");
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Dawn <span className="text-muted-foreground font-normal">· console</span>
        </h1>
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <Link href="/admin/graph" className="underline underline-offset-4">
            graph
          </Link>
          <Link href="/admin/monitor" className="underline underline-offset-4">
            monitor
          </Link>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
          <TabsTrigger value="submit">Submit ask</TabsTrigger>
        </TabsList>

        <TabsContent value="search">
          <SearchTab />
        </TabsContent>
        <TabsContent value="profiles">
          <ProfilesTab onViewMatches={goToNetwork} />
        </TabsContent>
        <TabsContent value="network">
          <NetworkTab initialPersonId={networkPersonId} />
        </TabsContent>
        <TabsContent value="submit">
          <SubmitAskTab onCreated={goToNetwork} />
        </TabsContent>
      </Tabs>
    </main>
  );
}
