"use client";

// Fetch wrapper for the admin API.
//
// This used to read the Supabase session and attach `Authorization: Bearer <token>`
// so requireAdmin() could identify the caller. Google-only auth makes that
// unnecessary: NextAuth's session cookie is sent automatically on same-origin
// requests, and requireAdmin() reads it via auth(). Nothing to attach.
//
// Kept as a wrapper rather than inlining `fetch` at each call site because the
// error unwrapping below is the actual value — the admin routes answer with
// `{ error }` and a status, and every tab wants that surfaced as a thrown Error
// with the server's own message rather than "Request failed (403)".
//
// `json` switches the call to POST and sends the value as the request body.
export async function adminFetch<T>(path: string, json?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
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
