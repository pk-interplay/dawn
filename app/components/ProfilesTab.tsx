"use client";

import { useEffect, useState } from "react";
import type { PersonSummary } from "./types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function ProfilesTab({ onViewMatches }: { onViewMatches: (id: string) => void }) {
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/people")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? "Failed to load profiles");
        setPeople(body.people);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Something went wrong"));
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Browse every profile in the network and what each person is asking for.
      </p>

      {error && <p className="text-destructive text-sm">Error: {error}</p>}
      {people && <p className="text-muted-foreground text-sm">{people.length} profiles</p>}

      <div className="space-y-3">
        {people?.map((p) => (
          <Card key={p.id}>
            <CardContent className="space-y-2">
              <div>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="text-muted-foreground text-sm">{p.headline}</p>
              </div>
              {p.bio && (
                <p className="text-sm">
                  <span className="font-medium">Bio:</span> {p.bio}
                </p>
              )}
              <p className="text-sm">
                <span className="font-medium">Offering:</span> {p.offering}
              </p>
              <p className="text-sm">
                <span className="font-medium">Looking for:</span> {p.looking_for}
              </p>
              {(p.ask_must_haves?.length > 0 || p.ask_nice_to_haves?.length > 0) && (
                <p className="text-sm">
                  {p.ask_must_haves?.length > 0 && (
                    <>
                      <span className="font-medium">Must-haves:</span> {p.ask_must_haves.join("; ")}
                      <br />
                    </>
                  )}
                  {p.ask_nice_to_haves?.length > 0 && (
                    <>
                      <span className="font-medium">Nice-to-haves:</span>{" "}
                      {p.ask_nice_to_haves.join("; ")}
                    </>
                  )}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {[p.industry, p.career_stage, p.location, p.meeting_format]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {p.tags?.map((t) => (
                  <Badge key={t} variant="secondary">
                    {t}
                  </Badge>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => onViewMatches(p.id)}>
                View matches →
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
