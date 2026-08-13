"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "../../lib/admin-fetch";
import type { OutboxResponse, OutboxRow } from "./types";
import { EmptyNote, ErrorNote, Loading, timeAgo } from "./shared";
import { Card, CardContent } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";

const STATUSES = ["draft", "sent", "suppressed", "bounced", "replied", "all"];

const KIND_LABEL: Record<string, string> = {
  opt_in_a: "opt-in → A",
  opt_in_b: "opt-in → B",
  introduction: "the introduction",
  nudge: "nudge",
  waitlist_reply: "waitlist reply",
  out_of_scope_reply: "out-of-scope reply",
};

export default function OutboxTab() {
  const [data, setData] = useState<OutboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("draft");
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    adminFetch<OutboxResponse>(`/api/admin/monitor/outbox?status=${status}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [status]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading what="outbox" />;

  return (
    <div className="space-y-4">
      {/* Said outright rather than left to be inferred from an empty sent list.
          "Is this thing live?" is the first question anyone opening this tab has. */}
      <div
        className={`rounded-md border px-3 py-2 text-sm ${
          data.deliveryEnabled
            ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
            : "border-border bg-muted/40 text-muted-foreground"
        }`}
      >
        {data.deliveryEnabled ? (
          <>
            <strong>Delivery is ON.</strong> Messages below with status <code>sent</code> reached
            real inboxes.
          </>
        ) : (
          <>
            <strong>Delivery is off.</strong> Nothing here has been transmitted. Every message is
            composed, stored, and held as a draft; set <code>DAWN_DELIVERY_ENABLED=true</code> to
            let them out.
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SelectNative
          className="w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </SelectNative>
        <span className="text-muted-foreground text-xs">
          {Object.entries(data.byStatus)
            .map(([k, v]) => `${v} ${k}`)
            .join(" · ") || "nothing sent yet"}
        </span>
      </div>

      {data.outbox.length === 0 ? (
        <EmptyNote>Nothing with status “{status}”.</EmptyNote>
      ) : (
        <div className="space-y-2">
          {data.outbox.map((row) => (
            <OutboxCard
              key={row.id}
              row={row}
              open={open === row.id}
              onToggle={() => setOpen(open === row.id ? null : row.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OutboxCard({
  row,
  open,
  onToggle,
}: {
  row: OutboxRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="space-y-0.5">
            <div className="text-sm font-medium">{row.subject ?? "(no subject)"}</div>
            <div className="text-muted-foreground text-xs">
              {KIND_LABEL[row.kind] ?? row.kind}
              {row.attempt > 0 ? ` #${row.attempt + 1}` : ""} · to {row.toEmails.join(", ") || "—"}
              {row.introduction
                ? ` · ${row.introduction.personA ?? "?"} ↔ ${row.introduction.personB ?? "?"}`
                : " · no introduction (reply to an inbound message)"}
            </div>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>{row.status}</span>
            <span>{timeAgo(row.createdAt)}</span>
          </div>
        </div>

        {row.failureReason && (
          <div className="text-destructive text-xs">{row.failureReason}</div>
        )}

        <button
          type="button"
          onClick={onToggle}
          className="text-muted-foreground text-xs underline underline-offset-4"
        >
          {open ? "hide" : "read the message"}
        </button>

        {open && (
          // Rendered as pre-wrapped text, not markdown or HTML. This is the exact
          // string that was or would be transmitted, unsubscribe footer included, and
          // the whole value of this view is that it is not prettified into something
          // slightly different from what the recipient gets.
          <pre className="bg-muted/50 max-h-96 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
            {row.body}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
