export interface NetworkSettings {
  enabled: boolean;
  intensity: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface NetworkSettingsResponse {
  settings: NetworkSettings;
  bounds: { min: number; max: number };
}

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
}

/** One row of the send ledger — a message Dawn sent, or would have. */
export interface OutboxRow {
  id: number;
  consentBasis: string;
  kind: string;
  attempt: number;
  identity: string;
  toEmails: string[];
  subject: string | null;
  /** The exact string transmitted or held, unsubscribe footer included. */
  body: string;
  status: string;
  failureReason: string | null;
  providerMessageId: string | null;
  createdAt: string;
  introduction: {
    id: string;
    state: string;
    personA: string | null;
    personB: string | null;
  } | null;
}

export interface OutboxResponse {
  /** Whether anything can actually leave the building right now. */
  deliveryEnabled: boolean;
  status: string;
  byStatus: Record<string, number>;
  outbox: OutboxRow[];
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
