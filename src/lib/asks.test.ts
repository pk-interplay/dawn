import { describe, expect, it } from "vitest";

import { parseAsks, MAX_ASKS } from "./asks";

describe("parseAsks", () => {
  it("splits on newlines and trims", () => {
    expect(parseAsks("  Seed-stage founders \n\n Climate LPs  ")).toEqual([
      "Seed-stage founders",
      "Climate LPs",
    ]);
  });

  it("strips the bullet leaders the box is seeded with", () => {
    // The old read-only list rendered "· item"; a user editing around it must not
    // store the bullet as part of their ask.
    expect(parseAsks("· Fintech founders\n- Growth investors\n• Design leads")).toEqual([
      "Fintech founders",
      "Growth investors",
      "Design leads",
    ]);
  });

  it("drops case-insensitive duplicates, keeping the first", () => {
    expect(parseAsks("Fintech founders\nfintech FOUNDERS")).toEqual(["Fintech founders"]);
  });

  it("returns nothing for blank or whitespace-only input", () => {
    expect(parseAsks("")).toEqual([]);
    expect(parseAsks("\n  \n\t\n")).toEqual([]);
  });

  it("caps the list so the box cannot become a backlog", () => {
    const many = Array.from({ length: MAX_ASKS + 5 }, (_, i) => `ask ${i}`).join("\n");
    expect(parseAsks(many)).toHaveLength(MAX_ASKS);
  });
});
