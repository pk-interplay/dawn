/**
 * Dawn's front door, which is two different screens depending on who is at it.
 *
 * Signed out, `/` IS the pitch: the page that used to live at /about renders here,
 * because a visitor who has never seen Dawn needs the explanation and the sign-in
 * CTA, not a locked viewport with one button. /about itself is hidden for now — it
 * redirects here, and the links to it are gone (see app/about/page.tsx).
 *
 * Signed in, `/` stays the reference build's /Dawn/ home: a locked viewport holding
 * the wordmark lockup, a greeting, and a composer that opens the chat already saying
 * something. The composer replaced four fixed starter links — it takes anything,
 * including "here's what I'm working on now", which is how profile maintenance gets an
 * entry point at all (see HomeComposer, and the profile tools in src/lib/profile-tools).
 * Onboarding is not a third case — `/chat` sends anyone who hasn't finished it to
 * `/onboarding` itself, so nothing here has to know.
 *
 * A server component on purpose. Reading the session here means the right screen and
 * the correct rail render on the first paint; `useSession()` in the client would flash
 * the signed-out state on every load, on the one screen where that is most visible.
 */

import { auth } from "../src/auth";
import { isAdmin } from "./lib/admin-auth";
import { AboutPage } from "./components/AboutPage";
import { DawnMark } from "./components/DawnMark";
import { HomeComposer } from "./components/HomeComposer";
import { DawnShell } from "./components/DawnSidebar";

export default async function Home() {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);

  // Unauthenticated landing experience: the pitch, in full. AboutPage reads the
  // session and renders its own rail, so there is nothing to thread through.
  if (!signedIn) return <AboutPage />;

  // Gates the Admin rail item (see DawnSidebar).
  const admin = await isAdmin();

  // Google gives a full name; there is no separate first-name field to read.
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];

  return (
    <DawnShell signedIn isAdmin={admin}>
      {/* The corner About link is hidden along with /about; the greeting now has the
          top-right corner to itself. */}
      {firstName && (
        <div
          style={{ "--dawn-delay": "180ms" } as React.CSSProperties}
          className="dawn-enter fixed top-[22px] right-[26px] z-10 font-serif text-[22px] tracking-[0.3px] text-dawn-bone"
        >
          Hello {firstName}!
        </div>
      )}

      <main className="relative flex flex-1 flex-col items-center justify-center gap-8">
        <h1
          style={{ "--dawn-delay": "240ms" } as React.CSSProperties}
          className="dawn-enter flex items-center gap-4 leading-none text-dawn-bone sm:gap-[22px]"
        >
          <DawnMark idSuffix="home" className="h-12 shrink-0 select-none sm:h-[62px]" />
          <span className="font-serif text-[68px] leading-none tracking-[0.5px] sm:text-[88px]">
            Dawn
          </span>
        </h1>

        <HomeComposer />
      </main>

    </DawnShell>
  );
}
