import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createDawnTools, type DawnScope } from "./network-tools";

/**
 * Guards the scope boundary.
 *
 * This matters more than a normal unit test because the boundary is enforced
 * STRUCTURALLY — `findWarmPath` is absent from the tool map in "mine" scope rather than
 * present-and-refusing — and a structural guarantee is exactly the kind that a later
 * refactor breaks silently. Nothing throws when a tool becomes reachable that shouldn't
 * be; the model simply gains access to every teammate's contacts.
 *
 * These tests are offline: they never touch Supabase, so they run in CI.
 */

const VIEWER = "11111111-1111-1111-1111-111111111111";

function fakeClient(): SupabaseClient {
  return {} as SupabaseClient;
}

function toolsFor(scope: DawnScope) {
  return createDawnTools({
    client: fakeClient(),
    writeClient: fakeClient(),
    viewerEntityId: VIEWER,
    viewerEmail: "viewer@example.com",
    scope,
  });
}

describe("createDawnTools scope boundary", () => {
  it("exposes no cross-member tool in 'mine' scope", () => {
    const names = Object.keys(toolsFor("mine"));
    expect(names).not.toContain("findWarmPath");
    expect(names.sort()).toEqual(
      ["getEntityProfile", "listTopConnections", "lookupByNameOrDomain", "searchNetwork"].sort(),
    );
  });

  it("adds findWarmPath in 'all' scope, and nothing else", () => {
    const mine = Object.keys(toolsFor("mine")).sort();
    const all = Object.keys(toolsFor("all")).sort();
    expect(all).toContain("findWarmPath");
    // The two scopes must differ by exactly one tool. If a future change adds a tool to
    // one scope only, this fails and the author has to say which scope it belongs to.
    expect(all.filter((n) => !mine.includes(n))).toEqual(["findWarmPath"]);
    expect(mine.filter((n) => !all.includes(n))).toEqual([]);
  });

  it("every tool has a description and an input schema", () => {
    // The descriptions carry load-bearing instructions — the saturation warning, and
    // "use lookupByNameOrDomain for a domain". A tool shipped without one degrades
    // answer quality in a way that is invisible until someone reads a transcript.
    for (const [name, def] of Object.entries(toolsFor("all"))) {
      expect(def.description, `${name} needs a description`).toBeTruthy();
      expect(def.inputSchema, `${name} needs an inputSchema`).toBeTruthy();
    }
  });

  it("takes viewer identity from context, never from tool input", () => {
    // The security property in one assertion: if any tool ever accepts something like
    // `viewerEntityId` or `scope` as an input, the model can set it.
    const forbidden = ["viewerentityid", "vieweremail", "scope", "connectorids", "userid"];
    for (const [name, def] of Object.entries(toolsFor("all"))) {
      const schema = def.inputSchema as unknown as { shape?: Record<string, unknown> };
      for (const key of Object.keys(schema.shape ?? {})) {
        expect(
          forbidden,
          `${name}.${key} would let the model choose whose data it reads`,
        ).not.toContain(key.toLowerCase());
      }
    }
  });
});
