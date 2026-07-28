"use client";

import { useState } from "react";
import SearchTab from "../components/SearchTab";
import NetworkTab from "../components/NetworkTab";
import SubmitAskTab from "../components/SubmitAskTab";
import ProfilesTab from "../components/ProfilesTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tab = "search" | "network" | "submit" | "profiles";

export default function Admin() {
  const [tab, setTab] = useState<Tab>("search");
  const [networkPersonId, setNetworkPersonId] = useState<string | null>(null);

  function goToNetwork(id: string) {
    setNetworkPersonId(id);
    setTab("network");
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">
        Dawn <span className="text-muted-foreground font-normal">· admin</span>
      </h1>

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
