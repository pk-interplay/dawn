import type { GeneratedProfile } from "@/lib/member";

// Dawn's agent inbox. A new member introduces themselves by emailing here;
// Dawn's agent ingests the intro on the other side.
export const DAWN_EMAIL = "dawnagent@agentmail.to";

export interface EmailDraft {
  subject: string;
  body: string;
}

// Build a Gmail "compose" deep link that opens a prefilled draft in the web
// client. Body prefill works but long bodies can hit URL limits, so callers
// should also copy the body to the clipboard as a reliable fallback.
export function gmailComposeUrl({ to, subject, body }: { to: string } & EmailDraft): string {
  const params = new URLSearchParams({ view: "cm", fs: "1", to, su: subject, body });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

// Deterministic first-person intro used when the LLM draft call fails, so the
// send step never dead-ends.
export function introEmailFallback(profile: GeneratedProfile): EmailDraft {
  const goals = profile.goals?.filter(Boolean) ?? [];
  const paragraphs = [
    `Hi Dawn,`,
    `I'm ${profile.name}${profile.headline ? ` — ${profile.headline}` : ""}.`,
    profile.summary,
    goals.length
      ? `What I'm working toward:\n${goals.map((g) => `• ${g}`).join("\n")}`
      : "",
    profile.offering ? `What I can offer: ${profile.offering}` : "",
    profile.looking_for ? `What I'm looking for: ${profile.looking_for}` : "",
    `Looking forward to being introduced to the right people.`,
    `Thanks,\n${profile.name}`,
  ].filter(Boolean);

  return {
    subject: `Intro — ${profile.name}`,
    body: paragraphs.join("\n\n"),
  };
}
