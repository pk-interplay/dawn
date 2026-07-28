import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

export const anthropic = new Anthropic();

export function textOf(resp: Anthropic.Messages.Message): string {
  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!block) throw new Error("No text block in Claude response");
  return block.text;
}
