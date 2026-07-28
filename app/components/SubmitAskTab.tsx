"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { Card, CardContent } from "@/components/ui/card";

const initialForm = {
  name: "",
  headline: "",
  bio: "",
  offering: "",
  looking_for: "",
  tags: "",
  industry: "",
  career_stage: "",
  location: "",
  meeting_format: "call",
  ask_must_haves: "",
  ask_nice_to_haves: "",
};

export default function SubmitAskTab({
  onCreated,
}: {
  onCreated: (personId: string, name: string) => void;
}) {
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ id: string; name: string; embedded: boolean } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  function update(field: keyof typeof initialForm) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function splitList(value: string) {
    return value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          tags: splitList(form.tags),
          ask_must_haves: splitList(form.ask_must_haves),
          ask_nice_to_haves: splitList(form.ask_nice_to_haves),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to submit");
      setResult({ id: body.person.id, name: body.person.name, embedded: body.embedded });
      setForm(initialForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Add yourself (or a mock person) to the network with what you offer and what you&apos;re
        looking for.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" required value={form.name} onChange={update("name")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="headline">Headline</Label>
          <Input
            id="headline"
            value={form.headline}
            onChange={update("headline")}
            placeholder="e.g. Seed-stage climate tech founder"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bio">Bio</Label>
          <Textarea id="bio" rows={3} value={form.bio} onChange={update("bio")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offering">Offering</Label>
          <Textarea
            id="offering"
            required
            rows={2}
            value={form.offering}
            onChange={update("offering")}
            placeholder="What can you give: expertise, intros, capital, time..."
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="looking_for">Looking for</Label>
          <Textarea
            id="looking_for"
            required
            rows={2}
            value={form.looking_for}
            onChange={update("looking_for")}
            placeholder="What's your current ask?"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ask_must_haves">Must-haves (comma-separated)</Label>
          <Input
            id="ask_must_haves"
            value={form.ask_must_haves}
            onChange={update("ask_must_haves")}
            placeholder="e.g. technical co-founder, banking-infra experience"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ask_nice_to_haves">Nice-to-haves (comma-separated)</Label>
          <Input
            id="ask_nice_to_haves"
            value={form.ask_nice_to_haves}
            onChange={update("ask_nice_to_haves")}
            placeholder="e.g. based in NYC"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tags">Tags (comma-separated)</Label>
          <Input
            id="tags"
            value={form.tags}
            onChange={update("tags")}
            placeholder="fintech, founder"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="industry">Industry</Label>
          <Input
            id="industry"
            value={form.industry}
            onChange={update("industry")}
            placeholder="fintech"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="career_stage">Career stage</Label>
          <Input
            id="career_stage"
            value={form.career_stage}
            onChange={update("career_stage")}
            placeholder="e.g. seed-stage founder"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="location">Location</Label>
          <Input
            id="location"
            value={form.location}
            onChange={update("location")}
            placeholder="e.g. Remote, NYC"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="meeting_format">Meeting format</Label>
          <SelectNative
            id="meeting_format"
            value={form.meeting_format}
            onChange={update("meeting_format")}
          >
            <option value="async">Async</option>
            <option value="call">Call</option>
            <option value="in_person">In person</option>
          </SelectNative>
        </div>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit ask"}
        </Button>
      </form>

      {error && <p className="text-destructive text-sm">Error: {error}</p>}

      {result && (
        <Card>
          <CardContent className="space-y-2">
            <h3 className="font-semibold">{result.name} added</h3>
            {!result.embedded && (
              <p className="bg-muted text-muted-foreground rounded-md p-3 text-sm">
                No OPENAI_API_KEY configured — this profile has no embeddings yet, so it won&apos;t
                show up in matching until one is added and the profile is re-embedded.
              </p>
            )}
            <Button variant="outline" size="sm" onClick={() => onCreated(result.id, result.name)}>
              View {result.name}&apos;s matches in Network →
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
