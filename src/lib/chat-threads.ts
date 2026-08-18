import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage for the /chat conversation: thread list, history hydration, turn persistence.
 *
 * Every function here takes the SERVICE-ROLE client and an `entityId`, and every read
 * filters on that entity. The tables have RLS on with no policies (0034), so there is
 * no database-level backstop — the entity filter in these queries IS the authorization.
 * That is why the thread-scoped calls take `entityId` even where a `threadId` alone
 * would be enough to find the rows: it makes it impossible to write a call site that
 * forgets to check ownership.
 *
 * Shared by the chat page (server-rendered hydration), the chat route (persistence) and
 * the threads route (list/delete) so those three cannot drift apart.
 */

export interface ChatThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

/** The subset of the AI SDK's UIMessage we store and replay. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
}

const TITLE_MAX = 60;

/** Thread ids come off the wire from the client, so they are validated before use. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export async function listThreads(
  client: SupabaseClient,
  entityId: string,
  limit = 50,
): Promise<ChatThreadSummary[]> {
  const { data, error } = await client
    .from("chat_threads")
    .select("id, title, updated_at")
    .eq("entity_id", entityId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listThreads failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    title: (row.title as string | null) ?? null,
    updatedAt: row.updated_at as string,
  }));
}

/**
 * Load a thread's history, or null if it does not exist or is not this viewer's.
 *
 * The two cases are deliberately collapsed: callers turn null into "start a fresh
 * chat", which tells a stranger nothing about whether the id they guessed is real.
 */
export async function loadThreadMessages(
  client: SupabaseClient,
  entityId: string,
  threadId: string,
): Promise<StoredMessage[] | null> {
  const { data: thread, error: threadError } = await client
    .from("chat_threads")
    .select("id")
    .eq("id", threadId)
    .eq("entity_id", entityId)
    .maybeSingle();
  if (threadError) throw new Error(`loadThreadMessages failed: ${threadError.message}`);
  if (!thread) return null;

  // Newest 200, then re-reversed to chronological. Two reasons for the cap: an
  // unbounded select was silently clipped at PostgREST's 1000-row default anyway
  // (from the WRONG end — it kept the oldest rows), and a rendering surface does
  // not need a thread's full archaeology. The model sees an even tighter window
  // (see chat/route.ts).
  const { data, error } = await client
    .from("chat_messages")
    .select("id, role, parts")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`loadThreadMessages failed: ${error.message}`);

  return (data ?? []).reverse().map((row) => ({
    id: row.id as string,
    role: row.role as "user" | "assistant",
    parts: (row.parts as unknown[]) ?? [],
  }));
}

/**
 * Whether any thread has this id, regardless of whose it is.
 *
 * Only for telling "this id is free, the row appears on the first turn" apart from "this
 * id is already somebody else's" — a distinction `loadThreadMessages` collapses on
 * purpose. Callers must not surface the answer; it is used to pick a different id.
 */
export async function threadExists(
  client: SupabaseClient,
  threadId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("chat_threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (error) throw new Error(`threadExists failed: ${error.message}`);
  return data !== null;
}

/**
 * Claim a thread id for this viewer, or confirm they already own it.
 *
 * Returns false when the id belongs to somebody else — the caller must refuse to stream
 * in that case, since the turn would otherwise be appended to a stranger's history.
 * `on conflict do nothing` makes the first call and every later one identical.
 */
export async function ensureThreadOwned(
  client: SupabaseClient,
  entityId: string,
  threadId: string,
): Promise<boolean> {
  const { error } = await client
    .from("chat_threads")
    .upsert({ id: threadId, entity_id: entityId }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`ensureThreadOwned failed: ${error.message}`);

  const { data, error: readError } = await client
    .from("chat_threads")
    .select("entity_id")
    .eq("id", threadId)
    .maybeSingle();
  if (readError) throw new Error(`ensureThreadOwned failed: ${readError.message}`);

  return data?.entity_id === entityId;
}

/**
 * Persist one turn. Idempotent on the message id, so a client retry of a turn that did
 * land does not duplicate it.
 */
export async function saveMessage(
  client: SupabaseClient,
  threadId: string,
  message: StoredMessage,
): Promise<void> {
  const { error } = await client.from("chat_messages").upsert(
    {
      id: message.id,
      thread_id: threadId,
      role: message.role,
      parts: message.parts,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`saveMessage failed: ${error.message}`);
}

export async function touchThread(
  client: SupabaseClient,
  threadId: string,
): Promise<void> {
  const { error } = await client
    .from("chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);
  if (error) throw new Error(`touchThread failed: ${error.message}`);
}

/**
 * Name the thread after its opening question, once. `is("title", null)` does the
 * "once" — no read-then-write race, and no need to know whether this is turn one.
 */
export async function setThreadTitleIfUnset(
  client: SupabaseClient,
  threadId: string,
  firstUserText: string,
): Promise<void> {
  const title = summarizeTitle(firstUserText);
  if (!title) return;

  const { error } = await client
    .from("chat_threads")
    .update({ title })
    .eq("id", threadId)
    .is("title", null);
  if (error) throw new Error(`setThreadTitleIfUnset failed: ${error.message}`);
}

/** First line, clipped at a word boundary. Deliberately not an LLM call. */
export function summarizeTitle(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= TITLE_MAX) return flat;
  const clipped = flat.slice(0, TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

export async function deleteThread(
  client: SupabaseClient,
  entityId: string,
  threadId: string,
): Promise<void> {
  // Messages go with it via `on delete cascade`.
  const { error } = await client
    .from("chat_threads")
    .delete()
    .eq("id", threadId)
    .eq("entity_id", entityId);
  if (error) throw new Error(`deleteThread failed: ${error.message}`);
}

/** Pull the plain text out of a UIMessage's parts, for titling. */
export function textOf(message: { parts?: unknown[] } | undefined): string {
  if (!message?.parts) return "";
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join(" ");
}
