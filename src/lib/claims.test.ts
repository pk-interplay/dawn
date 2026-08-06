import { describe, expect, it } from "vitest";
import { writeClaim, type ClaimInput } from "./claims";

// Behaviour lock for the claim writer — the only path into `claims`. Confidence
// clamping happens here, not just at the Postgres check constraint (SPEC §5.1:
// "The API does not enforce numeric/string constraints" for LLM output, so a
// model returning confidence=1.4 or NaN must be caught before it reaches the DB,
// not rely on the insert erroring).

function mockClient(capture: { row?: Record<string, unknown> }) {
  return {
    from(table: string) {
      expect(table).toBe("claims");
      return {
        insert(row: Record<string, unknown>) {
          capture.row = row;
          return {
            select() {
              return {
                async single() {
                  return { data: { id: 1, ...row }, error: null };
                },
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const baseInput: ClaimInput = {
  subjectId: "11111111-1111-1111-1111-111111111111",
  attribute: "role",
  value: "investor",
  source: "manual",
  method: "manual",
  confidence: 0.9,
  observedAt: "2026-08-01T00:00:00Z",
};

describe("writeClaim", () => {
  it("passes a valid confidence through unchanged", async () => {
    const capture: { row?: Record<string, unknown> } = {};
    await writeClaim(mockClient(capture), { ...baseInput, confidence: 0.75 });
    expect(capture.row?.confidence).toBe(0.75);
  });

  it("clamps confidence above 1 down to 1", async () => {
    const capture: { row?: Record<string, unknown> } = {};
    await writeClaim(mockClient(capture), { ...baseInput, confidence: 1.4 });
    expect(capture.row?.confidence).toBe(1);
  });

  it("clamps confidence below 0 up to 0", async () => {
    const capture: { row?: Record<string, unknown> } = {};
    await writeClaim(mockClient(capture), { ...baseInput, confidence: -0.2 });
    expect(capture.row?.confidence).toBe(0);
  });

  it("treats NaN confidence as 0 rather than writing an invalid row", async () => {
    const capture: { row?: Record<string, unknown> } = {};
    await writeClaim(mockClient(capture), { ...baseInput, confidence: NaN });
    expect(capture.row?.confidence).toBe(0);
  });

  it("never sets superseded_by — the writer only appends", async () => {
    const capture: { row?: Record<string, unknown> } = {};
    await writeClaim(mockClient(capture), baseInput);
    expect(capture.row).not.toHaveProperty("superseded_by");
  });

  it("defaults evidence to null when omitted", async () => {
    const capture: { row?: Record<string, unknown> } = {};
    await writeClaim(mockClient(capture), baseInput);
    expect(capture.row?.evidence).toBeNull();
  });
});
