/**
 * The shell and prose primitives behind /privacy and /terms.
 *
 * Both documents are long, static, and read the same way, so they share one
 * chrome: the AboutPage top bar (wordmark home link + the single sign-in pill),
 * a title block with the effective date, numbered sections, and the same footer
 * that now carries the legal links. Nothing here is page-specific — the two
 * routes supply only their own copy.
 *
 * Kept visually quieter than the pitch on purpose: no hero type, no pill CTAs in
 * the body, narrower measure (`max-w-[720px]`) than AboutPage's sections, because
 * this is a document to read rather than a page to be sold by. Type scale still
 * comes from the same palette and font variables, so it reads as the same site.
 *
 * Server components throughout — the copy is static and the rail wants the
 * session on first paint, exactly as on AboutPage.
 */

import Link from "next/link";

import { auth } from "@/src/auth";
import { Button } from "@/components/ui/button";
import { isAdmin } from "@/app/lib/admin-auth";
import { startGoogleSignIn } from "@/app/lib/auth-actions";
import { DawnMark } from "./DawnMark";
import { DawnShell } from "./DawnSidebar";

/** Matches AboutPage: 88px of right padding past 900px clears the fixed rail. */
const GUTTER = "px-8 max-[820px]:px-5 min-[900px]:pr-[88px]";

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-12 first:mt-10">
      <h2 className="mb-4 font-serif text-[26px] leading-tight font-normal tracking-[0.2px] text-dawn-bone max-[820px]:text-[22px]">
        {title}
      </h2>
      <div className="flex flex-col gap-4 text-[15.5px] leading-[1.7] text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

export function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-3 text-[15.5px] leading-[1.5] font-medium text-dawn-bone">{children}</h3>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p>{children}</p>;
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className="ml-5 flex list-disc flex-col gap-2 marker:text-dawn-head">{children}</ul>;
}

export function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-medium text-dawn-bone">{children}</strong>;
}

/** Inline link styling shared by both documents, internal and external alike. */
export function A({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http") || href.startsWith("mailto:");
  const className = "text-dawn-bone underline underline-offset-4 transition-colors hover:text-white";
  return external ? (
    <a href={href} className={className} target={href.startsWith("mailto:") ? undefined : "_blank"} rel="noreferrer">
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-15 bg-background">
      <div className={`mx-auto flex max-w-[980px] items-center justify-between py-3.5 ${GUTTER}`}>
        <Link
          href="/"
          className="inline-flex items-center gap-3 font-serif text-[26px] tracking-[0.3px] text-dawn-bone"
        >
          <DawnMark idSuffix="brand" className="h-[26px] shrink-0" />
          Dawn
        </Link>
        <form action={startGoogleSignIn}>
          <Button type="submit" variant="pill" size="pill-sm">
            Continue with Gmail
          </Button>
        </form>
      </div>
    </header>
  );
}

function LegalFooter() {
  return (
    <footer className="mt-20 flex items-center justify-between gap-4 border-t border-border pt-8 pb-5 text-[13px] text-dawn-head max-[820px]:flex-col max-[820px]:items-start">
      <p>© Dawn — built quietly.</p>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-dawn-bone">
          Home
        </Link>
        <span aria-hidden>·</span>
        <Link href="/privacy" className="transition-colors hover:text-dawn-bone">
          Privacy
        </Link>
        <span aria-hidden>·</span>
        <Link href="/terms" className="transition-colors hover:text-dawn-bone">
          Terms
        </Link>
      </div>
    </footer>
  );
}

export async function LegalPage({
  title,
  effective,
  summary,
  children,
}: {
  title: string;
  /** Rendered verbatim, e.g. "August 17, 2026". */
  effective: string;
  /** One-paragraph plain-English gloss above the document proper. */
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);
  const admin = signedIn && (await isAdmin());

  return (
    <DawnShell signedIn={signedIn} isAdmin={admin}>
      <div className="h-full overflow-y-auto">
        <TopBar />
        <main className={`mx-auto max-w-[980px] pb-[120px] max-[820px]:pb-20 ${GUTTER}`}>
          <div className="max-w-[720px]">
            <header className="pt-14 max-[820px]:pt-10">
              <h1 className="font-serif text-[48px] leading-[1.1] font-normal tracking-[0.3px] text-dawn-bone max-[820px]:text-[34px]">
                {title}
              </h1>
              <p className="mt-4 text-[11px] tracking-[2.4px] text-dawn-head uppercase">
                Effective {effective}
              </p>
              <div className="mt-7 border-l-2 border-dawn-bone bg-dawn-bone/8 px-6 py-5 text-[15.5px] leading-[1.7] text-dawn-bone max-[820px]:px-5">
                {summary}
              </div>
            </header>

            {children}
          </div>

          <LegalFooter />
        </main>
      </div>
    </DawnShell>
  );
}
