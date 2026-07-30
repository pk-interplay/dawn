// Client-side cache of "who am I": a member's identity (their people.id) plus the
// profile Dawn generated. The authoritative answer comes from GET /api/me, which
// resolves the row from the signed-in account — this only saves that round trip on
// return visits. `userId` is stored alongside so a cache written by one account is
// never shown to another on a shared browser.

export interface GeneratedProfile {
  name: string;
  headline: string;
  summary: string;
  goals: string[];
  background: string[];
  offering: string;
  looking_for: string;
  tags: string[];
}

export interface StoredMember {
  id: string;
  profile: GeneratedProfile;
  /** auth.users id this cache belongs to; absent in caches written before /api/me. */
  userId?: string;
}

export const MEMBER_STORAGE_KEY = "dawn_member";

export function loadMember(): StoredMember | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(MEMBER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredMember;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function saveMember(member: StoredMember) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MEMBER_STORAGE_KEY, JSON.stringify(member));
}

export function clearMember() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(MEMBER_STORAGE_KEY);
}
