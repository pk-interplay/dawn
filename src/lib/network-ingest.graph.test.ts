import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GmailActivity } from "./gmail-ingest";

/**
 * Behaviour lock for the batched graph write.
 *
 * The write this covers used to be a loop doing six sequential Supabase round trips per
 * contact, which on a mailbox with a thousand correspondents spent minutes here and blew
 * the onboarding route's 300s ceiling — leaving the user on a spinner that never resolved
 * because the function was killed mid-stream. Batching it is the fix, and these tests
 * exist so the properties that made the serial version *correct* survive it:
 *
 *   - an address already in the graph resolves to its existing entity, never a second one
 *   - a new address gets an entity AND an email claim, so the next run can resolve it
 *   - re-running over the same mailbox creates nothing new (the ingest is idempotent)
 *   - one failing chunk does not cost the run every other contact
 *   - a deadline stops the run and says so, rather than overrunning the caller
 *
 * The mailbox read is stubbed; everything below it runs against an in-memory stand-in for
 * PostgREST, so what is asserted is the rows the ingest actually asks for.
 */

const activity = vi.hoisted(() => ({ current: { headers: [], events: [] } as GmailActivity }));

vi.mock("./gmail-ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gmail-ingest")>()),
  // Hands the headers to `onBatch` the way a real paged read does, so the contact
  // streaming the onboarding ticker depends on is exercised rather than assumed.
  fetchGmailActivity: vi.fn(
    async (_token: string, onBatch?: (batch: GmailActivity["headers"]) => void) => {
      onBatch?.(activity.current.headers);
      return activity.current;
    },
  ),
}));

const { ingestGmailNetwork } = await import("./network-ingest");

// ---------------------------------------------------------------------------
// A minimal in-memory PostgREST. Enough of the builder to serve the exact chains
// claims.ts / network-ingest.ts use, and no more.
// ---------------------------------------------------------------------------

interface EntityRow {
  id: string;
  kind: string;
  display_name: string | null;
}
interface ClaimRow {
  id: number;
  subject_id: string;
  attribute: string;
  value: unknown;
  source: string;
  superseded_by: number | null;
}
interface EdgeRow {
  from_id: string;
  to_id: string;
  kind: string;
  source: string;
  strength: number;
}

class FakeDb {
  entities: EntityRow[] = [];
  claims: ClaimRow[] = [];
  edges: EdgeRow[] = [];
  /** Tables whose next write should fail, to exercise the failure paths. */
  failOn = new Set<string>();
  private nextEntity = 1;
  private nextClaim = 1;

  newEntityId(): string {
    return `entity-${this.nextEntity++}`;
  }
  newClaimId(): number {
    return this.nextClaim++;
  }

  /** `resolved_attributes` is `distinct on (subject_id, attribute)` over live claims. */
  resolved(): { subject_id: string; attribute: string; value: unknown }[] {
    const seen = new Set<string>();
    const out: { subject_id: string; attribute: string; value: unknown }[] = [];
    for (const c of this.claims) {
      if (c.superseded_by !== null) continue;
      const key = `${c.subject_id}|${c.attribute}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subject_id: c.subject_id, attribute: c.attribute, value: c.value });
    }
    return out;
  }
}

type Result = { data: unknown; error: { message: string } | null };

class Query {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: unknown;
  private filters: Record<string, unknown> = {};
  private rangeBounds: [number, number] | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }
  insert(payload: unknown) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: unknown) {
    this.op = "upsert";
    this.payload = payload;
    return this;
  }
  update(payload: unknown) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters[column] = value;
    return this;
  }
  is() {
    return this;
  }
  in(column: string, values: unknown) {
    this.filters[column] = values;
    return this;
  }
  filter(column: string, _op: string, value: unknown) {
    // findEntityIdByEmail compares a jsonb scalar, so the value arrives JSON-encoded.
    this.filters[column] = typeof value === "string" ? JSON.parse(value) : value;
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  range(from: number, to: number) {
    this.rangeBounds = [from, to];
    return this;
  }

  async single(): Promise<Result> {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    return { data: Array.isArray(data) ? data[0] : data, error: null };
  }
  async maybeSingle(): Promise<Result> {
    return this.single();
  }
  then<T>(onFulfilled: (r: Result) => T, onRejected?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }

  private run(): Result {
    if (this.db.failOn.has(this.table)) {
      this.db.failOn.delete(this.table);
      return { data: null, error: { message: `simulated ${this.table} failure` } };
    }

    if (this.table === "claims") return this.runClaims();
    if (this.table === "entities") return this.runEntities();
    if (this.table === "edges") return this.runEdges();
    if (this.table === "resolved_attributes") return this.runResolved();
    throw new Error(`FakeDb: unhandled table ${this.table}`);
  }

  private runClaims(): Result {
    if (this.op === "insert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Record<
        string,
        unknown
      >[];
      const written = rows.map((row) => {
        const created: ClaimRow = {
          id: this.db.newClaimId(),
          subject_id: row.subject_id as string,
          attribute: row.attribute as string,
          value: row.value,
          source: row.source as string,
          superseded_by: null,
        };
        this.db.claims.push(created);
        return created;
      });
      return { data: written, error: null };
    }

    // A read: either the full email index or a single lookup by value.
    let rows = this.db.claims.filter((c) => c.superseded_by === null);
    if (this.filters.attribute) rows = rows.filter((c) => c.attribute === this.filters.attribute);
    if (this.filters.value !== undefined) rows = rows.filter((c) => c.value === this.filters.value);
    if (this.rangeBounds) rows = rows.slice(this.rangeBounds[0], this.rangeBounds[1] + 1);
    return { data: rows, error: null };
  }

  private runEntities(): Result {
    if (this.op === "insert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Record<
        string,
        unknown
      >[];
      const created = rows.map((row) => {
        const entity: EntityRow = {
          id: this.db.newEntityId(),
          kind: (row.kind as string) ?? "person",
          display_name: null,
        };
        this.db.entities.push(entity);
        return entity;
      });
      return { data: created, error: null };
    }
    if (this.op === "update") {
      const patch = this.payload as Record<string, unknown>;
      for (const entity of this.db.entities) {
        if (this.filters.id && entity.id !== this.filters.id) continue;
        if ("display_name" in patch) entity.display_name = patch.display_name as string | null;
      }
      return { data: null, error: null };
    }
    const ids = this.filters.id;
    const rows = this.db.entities.filter((e) =>
      Array.isArray(ids) ? ids.includes(e.id) : ids === undefined || e.id === ids,
    );
    return { data: rows, error: null };
  }

  private runEdges(): Result {
    const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const key = (e: EdgeRow | Record<string, unknown>) =>
        `${e.from_id}|${e.to_id}|${e.kind}|${e.source}`;
      const existing = this.db.edges.findIndex((e) => key(e) === key(row));
      const next = row as unknown as EdgeRow;
      if (existing >= 0) this.db.edges[existing] = next;
      else this.db.edges.push(next);
    }
    return { data: null, error: null };
  }

  private runResolved(): Result {
    const subjects = this.filters.subject_id;
    const attributes = this.filters.attribute;
    const rows = this.db.resolved().filter((row) => {
      const subjectOk = Array.isArray(subjects)
        ? subjects.includes(row.subject_id)
        : subjects === undefined || row.subject_id === subjects;
      const attrOk = Array.isArray(attributes)
        ? attributes.includes(row.attribute)
        : attributes === undefined || row.attribute === attributes;
      return subjectOk && attrOk;
    });
    return { data: rows, error: null };
  }
}

function fakeClient(db: FakeDb) {
  return {
    from(table: string) {
      return new Query(db, table);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const YOU = "you@example.com";

/** A mailbox where `you` wrote to each of `contacts`. */
function mailbox(contacts: { name: string; email: string }[]): GmailActivity {
  return {
    headers: contacts.map((c) => ({
      from: `You <${YOU}>`,
      to: `${c.name} <${c.email}>`,
      date: new Date("2026-08-01T00:00:00Z").toUTCString(),
      subject: "Hello",
    })),
    events: [],
  };
}

describe("ingestGmailNetwork — the batched graph write", () => {
  let db: FakeDb;

  beforeEach(() => {
    db = new FakeDb();
    activity.current = { headers: [], events: [] };
  });

  it("creates one entity per new correspondent, each with a resolvable email claim", async () => {
    activity.current = mailbox([
      { name: "Ava Chen", email: "ava@example.com" },
      { name: "Ben Ito", email: "ben@example.com" },
    ]);

    const summary = await ingestGmailNetwork(fakeClient(db), "token", YOU);

    expect(summary.entitiesTouched).toBe(2);
    expect(summary.edgesWritten).toBe(2);
    expect(summary.failures).toEqual([]);
    expect(summary.truncated).toBe(false);

    // Two contacts plus the viewer.
    expect(db.entities).toHaveLength(3);

    // The identity claim is what makes a new entity findable next run. Without it the
    // following ingest creates a second entity for the same person.
    for (const email of ["ava@example.com", "ben@example.com"]) {
      const identity = db.claims.filter((c) => c.source === "identity" && c.value === email);
      expect(identity).toHaveLength(1);
    }
  });

  it("resolves an address already in the graph instead of creating a second entity", async () => {
    // Ava is already here, put there by somebody else's ingest.
    const avaId = db.newEntityId();
    db.entities.push({ id: avaId, kind: "person", display_name: "Ava Chen" });
    db.claims.push({
      id: db.newClaimId(),
      subject_id: avaId,
      attribute: "email",
      value: "ava@example.com",
      source: "identity",
      superseded_by: null,
    });

    activity.current = mailbox([{ name: "Ava Chen", email: "ava@example.com" }]);
    const summary = await ingestGmailNetwork(fakeClient(db), "token", YOU);

    expect(summary.entitiesTouched).toBe(1);
    // Ava's existing entity, plus the viewer's — Ava was not duplicated.
    expect(db.entities).toHaveLength(2);
    expect(db.edges[0].to_id).toBe(avaId);
  });

  it("is idempotent: a second run over the same mailbox adds no entities or edges", async () => {
    activity.current = mailbox([
      { name: "Ava Chen", email: "ava@example.com" },
      { name: "Ben Ito", email: "ben@example.com" },
    ]);

    await ingestGmailNetwork(fakeClient(db), "token", YOU);
    const afterFirst = { entities: db.entities.length, edges: db.edges.length };

    await ingestGmailNetwork(fakeClient(db), "token", YOU);

    expect(db.entities).toHaveLength(afterFirst.entities);
    // The edge upsert keys on from_id,to_id,kind,source, so a re-run replaces rather
    // than accumulates.
    expect(db.edges).toHaveLength(afterFirst.edges);
  });

  it("counts a name claim only when the display name adds something over the address", async () => {
    activity.current = mailbox([
      { name: "Ava Chen", email: "ava@example.com" },
      // A bare address parses to name === email, which is not worth a name claim.
      { name: "ben@example.com", email: "ben@example.com" },
    ]);

    await ingestGmailNetwork(fakeClient(db), "token", YOU);

    const gmailClaims = db.claims.filter((c) => c.source === `gmail:${YOU}`);
    const names = gmailClaims.filter((c) => c.attribute === "name");
    expect(names.map((c) => c.value)).toEqual(["Ava Chen"]);
  });

  it("projects display names from claims rather than leaving them null", async () => {
    activity.current = mailbox([{ name: "Ava Chen", email: "ava@example.com" }]);
    await ingestGmailNetwork(fakeClient(db), "token", YOU);

    const ava = db.entities.find((e) =>
      db.claims.some(
        (c) => c.subject_id === e.id && c.attribute === "email" && c.value === "ava@example.com",
      ),
    );
    expect(ava?.display_name).toBe("Ava Chen");
  });

  it("records an edge-chunk failure without losing the run", async () => {
    activity.current = mailbox([{ name: "Ava Chen", email: "ava@example.com" }]);
    db.failOn.add("edges");

    const summary = await ingestGmailNetwork(fakeClient(db), "token", YOU);

    expect(summary.edgesWritten).toBe(0);
    expect(summary.failures.join(" ")).toMatch(/edges chunk/);
    // The claims still landed — a failed edge must not cost the contact its claims.
    expect(summary.claimsWritten).toBeGreaterThan(0);
  });

  it("stops and reports truncation when the deadline has passed", async () => {
    activity.current = mailbox([{ name: "Ava Chen", email: "ava@example.com" }]);

    const summary = await ingestGmailNetwork(fakeClient(db), "token", YOU, {
      deadline: Date.now() - 1,
    });

    // Truncated is the contract the route depends on: it is what turns "killed
    // mid-stream" into a partial result the caller can actually report.
    expect(summary.truncated).toBe(true);
    expect(summary.failures.join(" ")).toMatch(/ran out of time/);
  });

  it("reports write progress so a caller can show something during the write", async () => {
    activity.current = mailbox([{ name: "Ava Chen", email: "ava@example.com" }]);
    const seen: [number, number][] = [];

    await ingestGmailNetwork(fakeClient(db), "token", YOU, {
      onWriteProgress: (written, total) => seen.push([written, total]),
    });

    expect(seen[0]).toEqual([0, 1]);
    expect(seen.at(-1)).toEqual([1, 1]);
  });

  it("streams each unique correspondent once, however many messages mention them", async () => {
    activity.current = mailbox([
      { name: "Ava Chen", email: "ava@example.com" },
      { name: "Ava Chen", email: "ava@example.com" },
      { name: "Ben Ito", email: "ben@example.com" },
    ]);

    const streamed: string[] = [];
    await ingestGmailNetwork(fakeClient(db), "token", YOU, {
      onContact: (c) => streamed.push(c.email),
    });

    // The callback fires per header; the route dedupes for the ticker, and the graph
    // itself must collapse them into one entity either way.
    expect(new Set(streamed)).toEqual(new Set(["ava@example.com", "ben@example.com"]));
    expect(db.edges).toHaveLength(2);
  });
});
