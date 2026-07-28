// Client-side "who am I" for the v0 prototype. There is no auth yet, so a
// member's identity (their people.id) plus the profile Dawn generated is kept
// in localStorage. This is what lets us skip re-onboarding on return visits.

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
