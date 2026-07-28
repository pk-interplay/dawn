import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../../../../src/lib/anthropic";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are Dawn — a warm, sharp career agent welcoming a new member.

Your job in this conversation is to understand the person well enough to build their profile: who they are, their career background, and above all what they are trying to become — their goals. This is a conversation, not a form. Ask ONE thoughtful question at a time, react to what they say, and keep your messages short (1-3 sentences).

If the member uploads a LinkedIn export or resume PDF, read it and use it to fill in their background — then confirm what you learned and ask about their goals rather than re-asking things the document already answered.

Once you understand (1) their background, (2) what they want next / their goals, and (3) roughly what they can offer others, call the build_profile tool to generate their profile. Keep it brief — two or three good exchanges is plenty, and you can infer or fill gaps rather than asking about everything. Never mention the tool by name to the member.`;

const BUILD_PROFILE_TOOL: Anthropic.Messages.Tool = {
  name: "build_profile",
  description:
    "Generate the member's Dawn profile once you understand their background, goals, and what they can offer.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The member's name (or a friendly placeholder if unknown)." },
      headline: { type: "string", description: "A crisp one-line headline for who they are." },
      summary: { type: "string", description: "2-3 sentence narrative summary of the member." },
      goals: {
        type: "array",
        items: { type: "string" },
        description: "Their concrete career goals / what they want next.",
      },
      background: {
        type: "array",
        items: { type: "string" },
        description: "Key points of their career background and experience.",
      },
      offering: { type: "string", description: "What they can offer others in the network." },
      looking_for: { type: "string", description: "What they are looking for from the network." },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "3-6 short topical tags (e.g. fintech, product, seed-stage).",
      },
    },
    required: ["name", "headline", "summary", "goals", "background", "offering", "looking_for", "tags"],
  },
};

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

interface RequestBody {
  messages: IncomingMessage[];
  pdf?: { data: string; mediaType?: string };
}

export async function POST(req: Request) {
  try {
    const { messages, pdf } = (await req.json()) as RequestBody;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }

    // Find the last user message so we can attach an uploaded PDF to it.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    const apiMessages: Anthropic.Messages.MessageParam[] = messages.map((m, i) => {
      if (i === lastUserIdx && pdf?.data) {
        const content: Anthropic.Messages.ContentBlockParam[] = [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: (pdf.mediaType as "application/pdf") ?? "application/pdf",
              data: pdf.data,
            },
          },
          { type: "text", text: m.content || "Here is my LinkedIn / resume export." },
        ];
        return { role: "user", content };
      }
      return { role: m.role, content: m.content };
    });

    const resp = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      tools: [BUILD_PROFILE_TOOL],
      messages: apiMessages,
    });

    const toolUse = resp.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === "build_profile",
    );

    if (toolUse) {
      return NextResponse.json({ type: "profile", profile: toolUse.input });
    }

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return NextResponse.json({ type: "message", text: text || "Tell me a bit more about yourself." });
  } catch (err) {
    console.error("[join/chat] error", err);
    const message = err instanceof Error ? err.message : "Something went wrong";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
