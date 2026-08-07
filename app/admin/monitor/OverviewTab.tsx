"use client";

import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { adminFetch } from "../../lib/admin-fetch";
import type { Overview } from "./types";
import { chartConfig, EmptyNote, ErrorNote, Loading, StatTile, pct, timeAgo } from "./shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

// Turn a { key: count } tally into chart rows, biggest first.
function toRows(tally: Record<string, number>) {
  return Object.entries(tally)
    .map(([label, count]) => ({ label: label.replace(/_/g, " "), count }))
    .sort((a, b) => b.count - a.count);
}

export default function OverviewTab() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<Overview>("/api/admin/monitor/overview")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading what="overview" />;

  const activity = data.activity.map((d) => ({ ...d, count: d.total }));
  const hasActivity = activity.some((d) => d.count > 0);

  return (
    <div className="space-y-6">
      {/* Hero: the one number the view leads with. */}
      <Card>
        <CardContent className="px-6">
          <p className="text-muted-foreground text-sm">Introductions run</p>
          <p className="text-5xl font-semibold tracking-tight">{data.introductions.total}</p>
          <p className="text-muted-foreground mt-2 text-sm">
            {pct(data.introductions.optInRate)} opt-in rate across {data.introductions.answered}{" "}
            answered invitation{data.introductions.answered === 1 ? "" : "s"} ·{" "}
            {data.introductions.declined} declined · {data.introductions.expired} expired
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Members"
          value={data.people.total}
          hint={`${data.people.active} active · ${data.people.paused} paused`}
        />
        <StatTile
          label="With an email"
          value={data.people.withEmail}
          hint={`${data.people.total - data.people.withEmail} unreachable`}
        />
        <StatTile
          label="Matches"
          value={data.matches.total}
          hint={
            data.matches.avgScore === null
              ? "no scores"
              : `avg score ${data.matches.avgScore.toFixed(2)}`
          }
        />
        <StatTile
          label="Relationships"
          value={data.relationships.total}
          hint={
            data.relationships.avgStrength === null
              ? "no strength"
              : `avg strength ${data.relationships.avgStrength.toFixed(2)}`
          }
        />
        <StatTile
          label="Accepted matches"
          value={data.matches.byStatus.accepted ?? 0}
          hint={`${data.matches.byStatus.suggested ?? 0} still suggested`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Double opt-in funnel</CardTitle>
          <CardDescription>
            Introductions that reached at least each stage. Declined and expired intros leave the
            funnel without recording how far they got, so they are counted above instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.introductions.total === 0 ? (
            <EmptyNote>No introductions yet.</EmptyNote>
          ) : (
            <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
              <BarChart
                accessibilityLayer
                data={data.introductions.funnel}
                layout="vertical"
                margin={{ left: 4, right: 32 }}
                barCategoryGap={2}
              >
                <CartesianGrid horizontal={false} />
                <XAxis type="number" dataKey="count" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  width={104}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} maxBarSize={24}>
                  <LabelList
                    dataKey="count"
                    position="right"
                    offset={8}
                    className="fill-muted-foreground"
                    fontSize={12}
                  />
                </Bar>
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Network activity</CardTitle>
          <CardDescription>
            Interactions per day over the last {data.windowDays} days — intros sent, opt-ins,
            meetings, messages.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!hasActivity ? (
            <EmptyNote>
              No interactions recorded in the last {data.windowDays} days. pg_cron is deliberately
              unscheduled, so this stays flat until matching runs.
            </EmptyNote>
          ) : (
            <ChartContainer config={chartConfig} className="aspect-auto h-[200px] w-full">
              <BarChart accessibilityLayer data={activity} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Snapshot taken {timeAgo(data.generatedAt)}.
      </p>
    </div>
  );
}
