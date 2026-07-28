export interface Person {
  id: string;
  name: string;
  headline: string | null;
  bio: string | null;
  offering: string | null;
  looking_for: string | null;
  goals: string[];
  background: string[];
  tags: string[];
  industry: string | null;
  career_stage: string | null;
  location: string | null;
  meeting_format: string | null;
  ask_must_haves: string[];
  ask_nice_to_haves: string[];
  // Contact + scheduling (added in migration 0007).
  email: string | null;
  user_id: string | null;
  timezone: string | null;
  paused: boolean;
  intro_cadence: string; // daily | weekly | biweekly | monthly
  // Seeded test fixture vs real member (migration 0016). Matching never crosses
  // this boundary, so real members never get introduced to a persona.
  is_synthetic: boolean;
  // Fictional person the operator plays over email during the pilot (migration
  // 0018). Lives in the REAL cohort so teammates can be matched with them, but is
  // never a subject of matching — see /api/cron/run-matches.
  is_demo_persona: boolean;
  embedding_offering: number[] | string | null;
  embedding_looking_for: number[] | string | null;
  embedding_tags: number[] | string | null;
}

export interface GeneratedProfile {
  name: string;
  headline: string;
  bio: string;
  offering: string;
  looking_for: string;
  tags: string[];
  industry: string;
  career_stage: string;
  location: string;
  meeting_format: string;
  ask_must_haves: string[];
  ask_nice_to_haves: string[];
}

export type MatchDirection = "a_offers_b_wants" | "b_offers_a_wants" | "mutual";

export interface Candidate extends Person {
  similarity: number;
  surfaced_via: MatchDirection;
}

export interface MatchResult {
  candidate_id: string;
  score: number;
  direction: MatchDirection;
  rationale: string;
}
