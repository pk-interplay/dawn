import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../../../../src/lib/anthropic";
import { DAWN_EMAIL } from "@/lib/email";
import type { GeneratedProfile } from "@/lib/member";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are Dawn's writing assistant. Draft a short introduction email that the member is sending to Dawn (${DAWN_EMAIL}) so Dawn can start opening doors for them.

Write in the member's own first-person voice — warm, natural, and concise (a few short paragraphs, plain text). Cover who they are, what they're working toward, and what they can offer / are looking for from the network. Sign off with the member's name.

Do not use markdown, bullet characters, brackets, or placeholders like "[Name]" — the email must be ready to send as-is. Call the draft_email tool with the finished subject and body.`;

const DRAFT_EMAIL_TOOL: Anthropic.Messages.Tool = {
  name: "draft_email",
  description: "Return the finished introduction email the member will send to Dawn.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "A short, specific subject line for the intro email." },
      body: {
        type: "string",
        description: "The full email body in the member's first-person voice, signed with their name.",
      },
    },
    required: ["subject", "body"],
  },
};

interface RequestBody {
  profile: GeneratedProfile;
}

export async function POST(req: Request) {
  try {
    const { profile } = (await req.json()) as RequestBody;

    if (!profile?.name) {
      return NextResponse.json({ error: "No profile provided" }, { status: 400 });
    }

    const resp = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      tools: [DRAFT_EMAIL_TOOL],
      tool_choice: { type: "tool", name: "draft_email" },
      messages: [
        {
          role: "user",
          content: `Here is my profile. Please draft my introduction email to Dawn.\n\n${JSON.stringify(profile, null, 2)}`,
        },
      ],
    });

    const toolUse = resp.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "draft_email",
    );

    if (!toolUse) {
      return NextResponse.json({ error: "Couldn't draft the email" }, { status: 500 });
    }

    const { subject, body } = toolUse.input as { subject: string; body: string };
    return NextResponse.json({ subject, body });
  } catch (err) {
    console.error("[join/intro-email] error", err);
    const message = err instanceof Error ? err.message : "Something went wrong";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
