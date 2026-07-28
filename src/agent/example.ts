import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { findPeopleTool, runFindPeople, type FindInput } from "./findTool";

// Minimal agent loop that knows how to use the find_people tool.
// Run: DAWN_API_URL=http://localhost:3000 tsx src/agent/example.ts "who can help me hire a founding engineer?"

const SYSTEM = `You are a connector for the Dawn network. When a user needs to meet
someone — an advisor, hire, investor, design partner, or expert — use the find_people
tool to search real members, then summarize the best 2-3 matches in plain language,
naming each person and explaining specifically why they fit. If nothing fits, say so
honestly rather than stretching. Never invent people who aren't in the tool results.`;

const client = new Anthropic();

async function run(userPrompt: string) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

  // Loop until the model produces a final text answer with no more tool calls.
  for (let turn = 0; turn < 5; turn++) {
    const resp = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1500,
      system: SYSTEM,
      tools: [findPeopleTool],
      messages,
    });

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      console.log("\n" + text);
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === "find_people") {
        console.error(`→ find_people(${JSON.stringify(tu.input)})`);
        const result = await runFindPeople(tu.input as FindInput);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }
}

const prompt = process.argv.slice(2).join(" ") || "Who can help me with payments compliance?";
run(prompt).catch((err) => {
  console.error(err);
  process.exit(1);
});
