export interface PersonSummary {
  id: string;
  name: string;
  headline: string | null;
  bio: string | null;
  offering: string | null;
  looking_for: string | null;
  tags: string[];
  industry: string | null;
  career_stage: string | null;
  location: string | null;
  meeting_format: string | null;
  ask_must_haves: string[];
  ask_nice_to_haves: string[];
}

export type Direction = "a_offers_b_wants" | "b_offers_a_wants" | "mutual";

export interface CandidateSummary {
  id: string;
  name: string;
  headline: string | null;
  offering: string | null;
  looking_for: string | null;
  tags: string[];
  similarity: number;
  surfaced_via: Direction;
}

export interface RankedMatch {
  candidate_id: string;
  score: number;
  direction: Direction;
  rationale: string;
  candidate: CandidateSummary | null;
}

export interface SavedMatch {
  id: string;
  other: { id: string; name: string; headline: string | null } | null;
  score: number | null;
  rationale: string;
  direction: Direction;
  status: string;
  created_at: string;
}

export interface MatchesResponse {
  mode: "no_embeddings" | "similarity_only" | "ranked";
  note?: string;
  candidates?: CandidateSummary[];
  matches?: RankedMatch[];
  saved: SavedMatch[];
  trace: string[];
  error?: string;
}

// Result of triggering an intro from the admin Network tab.
export interface IntroTriggerResult {
  ok?: boolean;
  introductionId?: string;
  state?: string;
  emailedTo?: string | null;
  simulated?: boolean;
  threadId?: string | null;
  alreadyActive?: boolean;
  note?: string;
  error?: string;
}

// A person's existing introduction, for the Introductions list.
export interface IntroSummary {
  id: string;
  other: { id: string; name: string; headline: string | null } | null;
  state: string;
  created_at: string;
}
