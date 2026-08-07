import { defineConfig } from "vitest/config";

// Unit + eval tests for the Nexus build.
//
// Spec §7.3 requires every typed LLM function to be independently evaluable,
// with CI blocking merge on a regression. That needs a runner, and the repo had
// none — no vitest, no jest, no CI, no test files. This is that runner.
//
// Two kinds of test live here and they are deliberately separated by cost:
//
//   *.test.ts       pure, offline, no network. Runs on every commit.
//   *.eval.test.ts  calls the Anthropic API against a labeled fixture set.
//                   Costs money and needs ANTHROPIC_API_KEY, so it is opt-in
//                   via `npm run test:eval` and gated in CI on the key existing.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Eval tests are excluded from the default run. A contributor without an
    // API key should still be able to run `npm test` and get a green suite.
    exclude: ["**/node_modules/**", "src/**/*.eval.test.ts"],
    environment: "node",
  },
});
