// The shape of the post-upload onboarding form.
//
// Onboarding is two steps: upload a LinkedIn export (or describe your work), then
// answer one form. The questions are generated per member from their own profile,
// so this file is the contract the generator (/api/join/profile) and the form
// (OnboardingForm) both hold — a drifting `kind` or cadence string here becomes a
// row that fails the person_preferences check constraint at submit time.

/**
 * `person_preferences.kind`, as constrained in 0014. Every answer on the form is
 * stored as one row per selected value under one of these.
 */
export const PREFERENCE_KINDS = [
  "wants",
  "avoids",
  "format",
  "intro_style",
  "timing",
] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

/**
 * How a first conversation can happen. Fixed in code rather than generated, for the
 * same reason as the cadence values: these are read back at scheduling time to
 * decide what Dawn proposes, so they have to be matchable between two people. A
 * model-authored phrase ("coffee if we're both in NYC") reads well on a chip and
 * can't be compared against anyone else's answer.
 */
export const MEETING_FORMATS = [
  "in_person_coffee",
  "video_call",
  "phone_call",
  "async_email",
] as const;
export type MeetingFormat = (typeof MEETING_FORMATS)[number];

export const MEETING_FORMAT_LABELS: Record<MeetingFormat, string> = {
  in_person_coffee: "Coffee, if we're in the same city",
  video_call: "A short video call",
  phone_call: "A phone call — I'll take it on a walk",
  async_email: "Email first, meet later if it clicks",
};

/**
 * The format question. Multi-select on purpose: Dawn needs the *overlap* between
 * two people to propose anything, and someone who'd take a call or a coffee should
 * be able to say both.
 */
export function formatQuestion(helper: string): OnboardingQuestion {
  return {
    id: "format",
    kind: "format",
    title: "How would you want a first conversation to happen?",
    helper,
    select: "multi",
    options: MEETING_FORMATS.map((value) => ({
      value,
      label: MEETING_FORMAT_LABELS[value],
    })),
  };
}

/**
 * `people.intro_cadence`. Ordered most- to least-frequent.
 *
 * `hourly` is a testing tier, not one to offer a real member: paired with an hourly
 * runner it delivers up to 24 opt-in asks a day. It exists so a single operator
 * driving both sides of the network from their own inboxes can exercise the full
 * lifecycle in an afternoon instead of over three days. `burst` (every 6h) remains
 * the fastest cadence intended for someone who did not build this.
 */
export const CADENCES = ["hourly", "burst", "daily", "weekly", "biweekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * The subset onboarding actually offers. `hourly` is deliberately absent: it is a
 * valid stored value (so an operator can set it by hand on their own row) but must
 * never appear as a choice a member can tick, because nobody who wasn't running the
 * test would want 24 introductions a day.
 */
export const SELECTABLE_CADENCES = CADENCES.filter((c) => c !== "hourly");

export interface OnboardingOption {
  /** Stored verbatim as `person_preferences.value` — it lands in the matching prompt. */
  value: string;
  /** What the member reads. Kept short enough to scan as a chip. */
  label: string;
}

export interface OnboardingQuestion {
  id: string;
  kind: PreferenceKind;
  /** The question itself, written against this member's world. */
  title: string;
  /** One line of context under the title. */
  helper: string;
  /**
   * Frequency is the one genuinely exclusive answer — "a few a day" and "monthly"
   * can't both be true — so the cadence question is single-select. Everything else
   * is multi.
   */
  select: "multi" | "single";
  options: OnboardingOption[];
}

export interface SelectedPreference {
  kind: PreferenceKind;
  value: string;
}

/**
 * The frequency question. Options are fixed in code rather than generated: their
 * values are the `people.intro_cadence` enum, and a model-invented string here
 * would silently fall back to the 'weekly' column default.
 *
 * Nothing here is ticked for the member. `helper` is where the generator's
 * reasoning goes — it can argue for a frequency in prose, but the member picks.
 */
export function cadenceQuestion(helper: string): OnboardingQuestion {
  const labels: Partial<Record<Cadence, string>> = {
    burst: "A few a day — I want momentum now",
    daily: "About one a day",
    weekly: "One a week",
    biweekly: "Every couple of weeks",
    monthly: "About one a month",
  };
  return {
    id: "cadence",
    kind: "timing",
    title: "How often do you want to meet someone new?",
    helper,
    select: "single",
    options: SELECTABLE_CADENCES.map((value) => ({ value, label: labels[value] ?? value })),
  };
}

/** Narrow an untrusted string to a cadence, defaulting to the pilot tier. */
export function toCadence(value: unknown): Cadence {
  return typeof value === "string" && (CADENCES as readonly string[]).includes(value)
    ? (value as Cadence)
    : "burst";
}
