import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyProfilePatch,
  FIELD_LABELS,
  loadEditableProfile,
  LIST_FIELDS,
  ProfilePatchSchema,
  refreshProfileEmbedding,
  SCALAR_FIELDS,
} from "./profile-edit";

/**
 * The two tools that let Dawn maintain your profile from inside a conversation.
 *
 * Everything in network-tools.ts reads. These write, and that difference is the whole
 * design here:
 *
 *   - The SUBJECT is never an input. Like `viewerEntityId` in the network tools, it is
 *     closed over per request from the session, so there is no argument the model can
 *     produce that edits anybody else's profile. It cannot even name a subject.
 *   - The write client is passed in separately from the read client. Chat reads through
 *     the publishable key so RLS stays live on every graph query (see app/api/chat);
 *     only these two tools get the service-role handle, and only for one entity's own
 *     attributes.
 *   - The vocabulary is closed. `ProfilePatchSchema` is `.strict()`, so the model can
 *     write `headline` and `goals` and nothing else — it cannot invent an attribute and
 *     put it in the controlled vocabulary that matching reads as ground truth.
 *
 * Writes land as `self_reported` claims, which is honest: the user said it, in their own
 * words, in a conversation. The prompt is what keeps that true — the model is told to
 * only record what the user actually stated, never its own inference from the chat.
 */

export interface ProfileToolContext {
  /** Service-role, and used for nothing but this one entity's own claims. */
  writeClient: SupabaseClient;
  viewerEntityId: string;
}

const FIELD_GUIDE = [...SCALAR_FIELDS, ...LIST_FIELDS]
  .map((field) => `- ${field}: ${FIELD_LABELS[field]}`)
  .join("\n");

export function createProfileTools(ctx: ProfileToolContext): ToolSet {
  const getMyProfile = tool({
    description:
      "Read the profile of the person you are talking to — what they've said about " +
      "themselves, what they're working on, and what they're asking for. Call this " +
      "BEFORE updating anything, so you're editing the list they actually have.",
    inputSchema: z.object({}),
    execute: async () => {
      const profile = await loadEditableProfile(ctx.writeClient, ctx.viewerEntityId);
      return { name: profile.name, ...profile.scalars, ...profile.lists };
    },
  });

  const updateMyProfile = tool({
    description:
      "Record something the person told you about themselves. Only include the fields " +
      "they actually spoke to; anything you leave out is untouched.\n\n" +
      `Fields:\n${FIELD_GUIDE}\n\n` +
      "List fields are REPLACED wholesale, not appended to — call getMyProfile first " +
      "and send the full list you want them to end up with, or you will silently drop " +
      "the items you didn't repeat. Send an empty list to clear one.\n\n" +
      "Record only what they stated. Do not write your own inferences about them, and " +
      "do not tidy their wording into something they didn't say. If what they said is " +
      "vague ('I want to meet more people'), ask what they mean before writing it.",
    inputSchema: ProfilePatchSchema,
    execute: async (patch) => {
      const result = await applyProfilePatch(ctx.writeClient, {
        entityId: ctx.viewerEntityId,
        patch,
        source: "chat",
      });

      if (!result.written && !result.retired) {
        return { changed: {}, note: "Nothing changed — their profile already said that." };
      }

      // Their new description is what the rest of the network will find them by, so the
      // embedding is refreshed before the turn ends rather than on some later cron.
      await refreshProfileEmbedding(ctx.writeClient, ctx.viewerEntityId);
      return { changed: result.changed };
    },
  });

  return { getMyProfile, updateMyProfile };
}
