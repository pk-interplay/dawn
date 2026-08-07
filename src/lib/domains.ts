/**
 * Email-domain helpers shared by profile synthesis (synthesize-profile.ts) and
 * company reconciliation (reconcile-companies.ts). Both need the same answer to
 * "what domain is this address at, and does it say anything about who someone
 * works with" — factored out here so the two never drift on what counts as a
 * free-mail / infrastructure domain (a company entity must never be materialised
 * for gmail.com).
 */

/** Free-mail and infrastructure domains say nothing about who someone works with. */
export const GENERIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

/** The domain part of an email, lowercased, or null for a malformed address. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}
