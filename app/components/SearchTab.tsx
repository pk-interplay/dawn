"use client";

import { useState } from "react";
import type { PersonSummary } from "./types";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function SearchTab() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PersonSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch(query: string) {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/people/search?q=${encodeURIComponent(query)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Search failed");
      setResults(body.people);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Text search over the mock people/networking dataset.
      </p>

      <Input
        type="text"
        placeholder="Try: fintech, founder, biotech, growth marketing..."
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          runSearch(e.target.value);
        }}
      />

      {loading && <p className="text-muted-foreground text-sm">Searching…</p>}
      {error && <p className="text-destructive text-sm">Error: {error}</p>}
      {!loading && results && (
        <p className="text-muted-foreground text-sm">
          {results.length} result{results.length === 1 ? "" : "s"}
        </p>
      )}

      <div className="space-y-3">
        {results?.map((p) => (
          <Card key={p.id}>
            <CardContent className="space-y-2">
              <div>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="text-muted-foreground text-sm">{p.headline}</p>
              </div>
              <p className="text-sm">
                <span className="font-medium">Offering:</span> {p.offering}
              </p>
              <p className="text-sm">
                <span className="font-medium">Looking for:</span> {p.looking_for}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {p.tags?.map((t) => (
                  <Badge key={t} variant="secondary">
                    {t}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
