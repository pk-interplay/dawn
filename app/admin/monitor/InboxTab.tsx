"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "../../lib/admin-fetch";
import type { InboxRow } from "./types";
import { DecisionBadge, EmptyNote, ErrorNote, Loading, ThreadPanel, timeAgo } from "./shared";
import { Card, CardContent } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { Button } from "@/components/ui/button";

const DECISIONS = [
  "reply_to_intro",
  "preference_update",
  "pause",
  "out_of_scope",
  "non_member",
  "rate_limited",
  "duplicate",
  "self_send",
];

export default function InboxTab() {
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState("");
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [openClassification, setOpenClassification] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    setError(null);
    const query = decision ? `?decision=${decision}` : "";
    adminFetch<{ events: InboxRow[] }>(`/api/admin/monitor/inbox${query}`)
      .then((body) => setRows(body.events))
      .catch((err) => setError(err.message));
  }, [decision]);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Every email that reached the AgentMail webhook, what the classifier decided to do with it,
        and whether Dawn replied.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <SelectNative
          className="w-auto"
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          aria-label="Filter by decision"
        >
          <option value="">All decisions</option>
          {DECISIONS.map((d) => (
            <option key={d} value={d}>
              {d.replace(/_/g, " ")}
            </option>
          ))}
        </SelectNative>
        {rows && (
          <span className="text-muted-foreground text-sm">
            {rows.length} event{rows.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {error && <ErrorNote message={error} />}
      {!rows && !error && <Loading what="inbound events" />}
      {rows && !rows.length && <EmptyNote>No inbound events match this filter.</EmptyNote>}

      {rows?.map((event) => (
        <Card key={event.id}>
          <CardContent className="space-y-2.5 px-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate font-medium">{event.subject || "(no subject)"}</h3>
                <p className="text-muted-foreground truncate text-xs">
                  {event.from_email}
                  {event.person ? ` · ${event.person.name}` : " · not a member"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <DecisionBadge decision={event.decision} />
                <span className="text-muted-foreground text-xs">
                  {event.replied ? "replied" : "no reply"}
                </span>
              </div>
            </div>

            {event.preview && (
              <p className="text-muted-foreground bg-muted/40 rounded-md p-2.5 text-sm whitespace-pre-wrap">
                {event.preview.trim()}
                {event.truncated && "…"}
              </p>
            )}

            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>{timeAgo(event.created_at)}</span>
              {event.conversation && (
                <span>
                  · {event.conversation.purpose.replace(/_/g, " ")} thread ({event.conversation.state})
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {Object.keys(event.classification ?? {}).length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setOpenClassification(openClassification === event.id ? null : event.id)
                  }
                >
                  {openClassification === event.id ? "Hide" : "Show"} classifier output
                </Button>
              )}
              {event.conversation && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setOpenThread(openThread === event.conversation!.id ? null : event.conversation!.id)
                  }
                >
                  {openThread === event.conversation.id ? "Hide" : "View"} thread
                </Button>
              )}
            </div>

            {openClassification === event.id && (
              <pre className="bg-muted/40 overflow-x-auto rounded-md p-3 text-xs">
                {JSON.stringify(event.classification, null, 2)}
              </pre>
            )}
            {event.conversation && openThread === event.conversation.id && (
              <ThreadPanel conversationId={event.conversation.id} />
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
