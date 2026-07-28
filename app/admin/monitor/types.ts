export interface Overview {
  generatedAt: string;
  windowDays: number;
  people: {
    total: number;
    paused: number;
    active: number;
    withEmail: number;
    byCadence: Record<string, number>;
    byIndustry: Record<string, number>;
  };
  introductions: {
    total: number;
    byState: Record<string, number>;
    funnel: Array<{ label: string; count: number }>;
    declined: number;
    expired: number;
    answered: number;
    yeses: number;
    optInRate: number | null;
  };
  matches: {
    total: number;
    avgScore: number | null;
    byDirection: Record<string, number>;
    byStatus: Record<string, number>;
  };
  inbound: { total: number; byDecision: Record<string, number>; replied: number };
  messages: { total: number; inbound: number; outbound: number };
  conversations: { total: number; byPurpose: Record<string, number>; byState: Record<string, number> };
  relationships: { total: number; byStatus: Record<string, number>; avgStrength: number | null };
  activity: Array<{ date: string; counts: Record<string, number>; total: number }>;
}

export interface PersonRef {
  id: string;
  name: string;
  headline?: string | null;
  email?: string | null;
  paused?: boolean;
}

export interface ConversationRef {
  id: string;
  purpose: string;
  state: string;
  subject: string | null;
  thread_id: string | null;
  messageCount: number;
}

export interface IntroRow {
  id: string;
  state: string;
  a_response: string;
  b_response: string;
  rationale: string | null;
  channel: string;
  created_at: string;
  updated_at: string;
  person_a: PersonRef;
  person_b: PersonRef;
  match: { id: string; score: number | null; direction: string; status: string } | null;
  conversations: ConversationRef[];
  messageCount: number;
}

export interface InboxRow {
  id: string;
  from_email: string;
  subject: string | null;
  preview: string;
  truncated: boolean;
  decision: string;
  classification: Record<string, unknown>;
  replied: boolean;
  created_at: string;
  thread_id: string | null;
  person: PersonRef | null;
  conversation: { id: string; subject: string | null; purpose: string; state: string } | null;
}

export interface MemberRow extends PersonRef {
  industry: string | null;
  career_stage: string | null;
  location: string | null;
  intro_cadence: string;
  created_at: string;
  intros: number;
  introsPending: number;
  introsCompleted: number;
  answered: number;
  yeses: number;
  optInRate: number | null;
  relationships: number;
  avgStrength: number | null;
  interactions: number;
  lastTouch: string | null;
  preferences: Array<{ kind: string; value: string; source: string; confidence: number }>;
}

export interface ThreadResponse {
  conversation: {
    id: string;
    subject: string | null;
    purpose: string;
    state: string;
    thread_id: string | null;
    inbox_id: string | null;
    participants: unknown;
    created_at: string;
    updated_at: string;
  };
  introduction: {
    id: string;
    state: string;
    rationale: string | null;
    person_a: PersonRef | null;
    person_b: PersonRef | null;
  } | null;
  messages: Array<{
    id: string;
    direction: "inbound" | "outbound";
    from_email: string | null;
    to_emails: string[];
    subject: string | null;
    body: string | null;
    parsed: Record<string, unknown>;
    created_at: string;
  }>;
}
