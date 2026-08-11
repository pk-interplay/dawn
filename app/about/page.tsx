/**
 * /about is hidden for now. The pitch it used to render still exists — it is the
 * unauthenticated landing experience at `/` (see app/page.tsx and
 * app/components/AboutPage.tsx) — so this route redirects there rather than 404ing
 * on links already in the wild.
 *
 * To bring the route back: render <AboutPage /> here again and restore the two
 * entry points that were removed with it, the rail's About tab (DawnRail) and the
 * signed-in home screen's corner link (app/page.tsx).
 */

import { redirect } from "next/navigation";

export default function About() {
  redirect("/");
}
