"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Handshake, Loader2, LogOut, Sparkles, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { clearMember, loadMember, type GeneratedProfile } from "@/lib/member";
import { signOut, useAuth } from "../lib/useAuth";

interface Stats {
  intros: number;
  connections: number;
}

interface Connection {
  id: string;
  other: { id: string; name: string; headline: string | null } | null;
  status: string;
  strength: number;
  source: string;
  first_connected_at: string;
  last_interaction_at: string;
}

export default function Me() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [profile, setProfile] = useState<GeneratedProfile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [ready, setReady] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(true);

  // Require a signed-in session to view the dashboard.
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    const member = loadMember();
    if (!member) {
      router.replace("/join");
      return;
    }
    setProfile(member.profile);
    setReady(true);

    fetch(`/api/me/${member.id}/stats`)
      .then((res) => res.json())
      .then((body) => {
        if (body && typeof body.intros === "number") {
          setStats({ intros: body.intros, connections: body.connections });
        }
      })
      .catch(() => {
        /* stats are best-effort; the profile still renders */
      });

    fetch(`/api/me/${member.id}/connections`)
      .then((res) => res.json())
      .then((body) => {
        if (body && Array.isArray(body.connections)) setConnections(body.connections);
      })
      .catch(() => {
        /* connections are best-effort */
      });
  }, [router]);

  if (authLoading || !user || !ready || !profile) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </main>
    );
  }

  async function handleSignOut() {
    await signOut();
    router.replace("/login");
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-10">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground truncate text-sm">
          Signed in as <span className="text-foreground font-medium">{user.email}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={handleSignOut}>
          <LogOut className="size-4" />
          Sign out
        </Button>
      </div>

      <div className="space-y-1 text-center">
        <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-sm">
          <Sparkles className="size-4" /> Your Dawn profile
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{profile.name}</h1>
        <p className="text-muted-foreground">{profile.headline}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <StatCard
          icon={<Handshake className="size-5" />}
          label="Intros Dawn has made"
          value={stats?.intros}
        />
        <StatCard
          icon={<Users className="size-5" />}
          label="Approved connections"
          value={stats?.connections}
        />
      </div>

      <ConnectionsCard connections={connections} />

      <Card>
        <CardContent className="space-y-5">
          <p className="leading-relaxed">{profile.summary}</p>

          <ProfileSection title="Goals" items={profile.goals} />
          <ProfileSection title="Background" items={profile.background} />

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                Offering
              </h3>
              <p className="text-sm">{profile.offering}</p>
            </div>
            <div>
              <h3 className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                Looking for
              </h3>
              <p className="text-sm">{profile.looking_for}</p>
            </div>
          </div>

          {profile.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profile.tags.map((t) => (
                <Badge key={t} variant="secondary">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {showUpgrade && <UpgradeCard onDismiss={() => setShowUpgrade(false)} />}

      <div className="text-center">
        <button
          onClick={() => {
            clearMember();
            router.replace("/join");
          }}
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
        >
          Start over
        </button>
      </div>
    </main>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-5">
        <div className="text-primary">{icon}</div>
        <div>
          <div className="text-2xl font-semibold tabular-nums">
            {value === undefined ? <Loader2 className="size-5 animate-spin" /> : value}
          </div>
          <div className="text-muted-foreground text-xs">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const STATUS_LABEL: Record<string, string> = {
  introduced: "Introduced",
  connected: "Connected",
  met: "Met",
  dormant: "Dormant",
};

function ConnectionsCard({ connections }: { connections: Connection[] | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Your connections</CardTitle>
        <CardDescription>
          People Dawn has connected you with, ordered by how close you are now — proximity fades
          without contact and grows when you engage.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {connections === null ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : connections.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No connections yet — Dawn is working on your first introductions.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {connections.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {c.other?.name ?? "Someone"}
                    </span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {STATUS_LABEL[c.status] ?? c.status}
                    </Badge>
                  </div>
                  {c.other?.headline && (
                    <p className="text-muted-foreground truncate text-xs">{c.other.headline}</p>
                  )}
                </div>
                <div className="flex w-28 shrink-0 flex-col items-end gap-1">
                  <div className="bg-secondary h-1.5 w-full overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${Math.round(Math.min(1, Math.max(0, c.strength)) * 100)}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground text-[10px]">
                    {relativeTime(c.last_interaction_at)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileSection({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <h3 className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
        {title}
      </h3>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <Check className="text-primary mt-0.5 size-4 shrink-0" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PRO_FEATURES = [
  "Warm introductions matched to your goals",
  "Dawn works your network while you sleep",
  "Priority access to new members",
  "Weekly momentum report on your goals",
];

function UpgradeCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Card className="border-primary/40 relative overflow-hidden">
      <CardHeader>
        <Badge className="mb-1 w-fit gap-1">
          <Sparkles className="size-3" /> Dawn Pro
        </Badge>
        <CardTitle className="text-2xl">
          $20 <span className="text-muted-foreground text-base font-normal">/ month</span>
        </CardTitle>
        <CardDescription>
          Your profile is live. Upgrade to let Dawn actively open doors toward your goals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {PRO_FEATURES.map((f) => (
            <li key={f} className="flex gap-2 text-sm">
              <Check className="text-primary mt-0.5 size-4 shrink-0" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button size="lg" className="flex-1">
            Upgrade to Pro
          </Button>
          <Button size="lg" variant="outline" className="flex-1" onClick={onDismiss}>
            Maybe later
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
