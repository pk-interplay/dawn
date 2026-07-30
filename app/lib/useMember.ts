"use client";

import { useCallback, useEffect, useState } from "react";

import { clearMember, loadMember, saveMember, type StoredMember } from "@/lib/member";
import { supabaseBrowser } from "./supabase-browser";
import { useAuth } from "./useAuth";

interface MemberState {
  /** The signed-in account's member row, or null once we know there isn't one. */
  member: StoredMember | null;
  /** True until both the session and the member lookup have settled. */
  loading: boolean;
  /** Session present. Pages gate on this before showing a dashboard. */
  signedIn: boolean;
  /** Cache a member the client just created (see /join) without a refetch. */
  setMember: (member: StoredMember) => void;
}

/**
 * Resolve the current member from the signed-in account.
 *
 * Reads the localStorage cache first so return visits render immediately, then
 * confirms against GET /api/me. A cache belonging to a different account — or one
 * the server says no longer exists — is discarded rather than trusted, which is
 * what stopped a second device from re-running onboarding.
 */
export function useMember(): MemberState {
  const { user, loading: authLoading } = useAuth();
  const [member, setMember] = useState<StoredMember | null>(null);
  const [resolving, setResolving] = useState(true);

  const remember = useCallback((next: StoredMember) => {
    saveMember(next);
    setMember(next);
  }, []);

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      // Signing out must not leave the previous member behind for the next person
      // to use this browser.
      clearMember();
      setMember(null);
      setResolving(false);
      return;
    }

    let live = true;
    const cached = loadMember();
    // An unstamped cache predates /api/me; show it, and let the fetch below
    // confirm it belongs to this account.
    if (cached && (!cached.userId || cached.userId === user.id)) setMember(cached);
    else if (cached) clearMember();

    (async () => {
      try {
        const { data } = await supabaseBrowser().auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;

        const res = await fetch("/api/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) return; // Keep whatever the cache had; this is a refresh, not a gate.
        const body = (await res.json()) as { member: Omit<StoredMember, "userId"> | null };
        if (!live) return;

        if (body.member) {
          remember({ ...body.member, userId: user.id });
        } else {
          clearMember();
          setMember(null);
        }
      } finally {
        if (live) setResolving(false);
      }
    })();

    return () => {
      live = false;
    };
  }, [authLoading, user, remember]);

  return {
    member,
    loading: authLoading || resolving,
    signedIn: Boolean(user),
    setMember: remember,
  };
}
