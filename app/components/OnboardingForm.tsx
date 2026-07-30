"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Check, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  Cadence,
  OnboardingQuestion,
  SelectedPreference,
} from "@/lib/onboarding";
import { toCadence } from "@/lib/onboarding";
import type { GeneratedProfile } from "@/lib/member";

/**
 * The whole of onboarding after the upload: one form, five questions.
 *
 * Everything is on one screen on purpose. The previous flow asked one question per
 * turn with no visible end, so a member couldn't tell whether they were two
 * questions in or ten. Here the length of the commitment is legible before they
 * answer anything.
 *
 * Nothing is preselected. Every ticked chip becomes a `person_preferences` row that
 * is read verbatim into the matching prompt, so a guess the member never corrected
 * would be indistinguishable from something they told us. The one exception is
 * frequency: it's a column on `people` with a default, so leaving it blank would
 * silently pick a cadence for them — the submit button waits for it instead.
 *
 * The form animates in rather than appearing at once. A member has just waited
 * several seconds on a model call, and five questions landing in one frame reads
 * as a wall; arriving in sequence reads as Dawn working through their profile.
 */

/** One tick of the stagger. Short enough that the last question isn't a wait. */
const STEP = 0.06;

/** Rise-and-fade, used for every block on the page. */
const enter = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0 },
};
export function OnboardingForm({
  profile,
  questions,
  saving,
  error,
  onSubmit,
}: {
  profile: GeneratedProfile;
  questions: OnboardingQuestion[];
  saving: boolean;
  error: string | null;
  onSubmit: (answers: { preferences: SelectedPreference[]; cadence: Cadence }) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const firstName = profile.name.trim().split(/\s+/)[0] || "there";
  const totalSelected = useMemo(
    () => Object.values(selected).reduce((sum, values) => sum + values.length, 0),
    [selected],
  );
  const hasCadence = (selected.cadence ?? []).length > 0;

  function toggle(question: OnboardingQuestion, value: string) {
    setSelected((prev) => {
      const current = prev[question.id] ?? [];
      if (question.select === "single") {
        return { ...prev, [question.id]: [value] };
      }
      return {
        ...prev,
        [question.id]: current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value],
      };
    });
  }

  function submit() {
    if (saving || !hasCadence) return;

    const preferences: SelectedPreference[] = [];
    let cadence: Cadence = "burst";

    for (const question of questions) {
      const values = selected[question.id] ?? [];
      if (question.id === "cadence") {
        // Frequency is a column on `people`, not a preference row — it drives the
        // cron that actually sends intros.
        cadence = toCadence(values[0]);
        continue;
      }
      for (const value of values) {
        preferences.push({ kind: question.kind, value });
      }
    }

    onSubmit({ preferences, cadence });
  }

  return (
    // reducedMotion="user" hands the whole page to the OS setting: transforms are
    // dropped and opacity is kept, so the stagger degrades to a plain fade.
    <MotionConfig reducedMotion="user">
      <motion.main
        initial="hidden"
        animate="shown"
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-4 py-12"
      >
        <motion.header variants={enter} className="space-y-3">
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <Sparkles className="size-4" /> Dawn
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Here&apos;s what I picked up, {firstName}
          </h1>
          <p className="text-muted-foreground leading-relaxed">
            {profile.headline}. Now tell me who you want to meet — pick what fits and
            skip what doesn&apos;t.
          </p>
        </motion.header>

        <div className="space-y-8">
          {questions.map((question, index) => {
            const values = selected[question.id] ?? [];
            return (
              <motion.section
                key={question.id}
                variants={enter}
                // Each question trails the one above it. The header holds slot 0.
                transition={{ delay: (index + 1) * STEP }}
                className="space-y-3"
              >
                <div className="space-y-1">
                  <h2 className="font-medium tracking-tight">
                    <span className="text-muted-foreground mr-1.5 tabular-nums">
                      {index + 1}.
                    </span>
                    {question.title}
                  </h2>
                  {question.helper && (
                    <p className="text-muted-foreground pl-5 text-sm leading-relaxed">
                      {question.helper}
                      {question.select === "multi" && " Pick as many as apply."}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 pl-5">
                  {question.options.map((option) => {
                    const on = values.includes(option.value);
                    return (
                      <motion.button
                        key={option.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(question, option.value)}
                        whileTap={{ scale: 0.96 }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        className={[
                          "focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-full border px-3 py-1.5",
                          "text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none",
                          on
                            ? "border-foreground bg-foreground text-background"
                            : "border-input hover:bg-muted text-foreground",
                        ].join(" ")}
                      >
                        {/* The tick grows into place instead of snapping the label
                            sideways — the chip still reflows, but it reads as one
                            motion rather than a jump. */}
                        <AnimatePresence initial={false}>
                          {on && (
                            <motion.span
                              initial={{ width: 0, opacity: 0 }}
                              animate={{ width: "auto", opacity: 1 }}
                              exit={{ width: 0, opacity: 0 }}
                              transition={{ duration: 0.15 }}
                              className="flex shrink-0 overflow-hidden"
                            >
                              <Check className="size-3.5 shrink-0" />
                            </motion.span>
                          )}
                        </AnimatePresence>
                        {option.label}
                      </motion.button>
                    );
                  })}
                </div>
              </motion.section>
            );
          })}
        </div>

        <AnimatePresence>
          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-destructive text-sm"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <motion.div
          variants={enter}
          transition={{ delay: (questions.length + 1) * STEP }}
          className="space-y-3 border-t pt-6"
        >
          <Button
            size="lg"
            className="w-full"
            disabled={saving || !hasCadence}
            onClick={submit}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {saving ? "Setting you up…" : "Join Dawn"}
          </Button>
          <p className="text-muted-foreground text-center text-xs leading-relaxed">
            {hasCadence
              ? `${totalSelected} selected.`
              : "Pick how often you want to meet someone to continue."}{" "}
            Dawn will start emailing you introductions at the frequency you picked, and
            will always ask before sharing your details with anyone. Reply
            &ldquo;unsubscribe&rdquo; to any email to stop.
          </p>
        </motion.div>
      </motion.main>
    </MotionConfig>
  );
}
