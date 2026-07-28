"use client";

import { supabaseBrowser } from "./supabase-browser";

// Fetch wrapper for the admin API. Attaches the current Supabase session token
// so requireAdmin() on the server can identify the caller.
//
// `json` switches the call to POST and sends the value as the request body —
// needed by /api/admin/intro, which triggers a real introduction and so must
// carry the same credential as the read-only monitor routes.
export async function adminFetch<T>(path: string, json?: unknown): Promise<T> {
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method: json === undefined ? "GET" : "POST",
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    cache: "no-store",
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}
