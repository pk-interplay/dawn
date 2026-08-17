/**
 * /privacy — the privacy policy, on its own URL so it can be linked from the
 * footer, from the Google OAuth consent screen (which requires a public privacy
 * policy URL for a verified app), and from anywhere a member asks what Dawn
 * reads.
 *
 * The copy is a standard professional-network privacy policy — the LinkedIn
 * shape: what we collect, how we use it, who sees it, what you can do about it —
 * narrowed to what this build actually does. Two sections are not boilerplate and
 * should not be edited casually:
 *
 *   §3.2 describes Google data exactly as src/lib/gmail-ingest.ts behaves:
 *   `format=metadata` headers only, six-month lookback (LOOKBACK_MONTHS), plus
 *   read-only Calendar. If ingest ever reads message bodies — SPEC step 4's
 *   extract_claims is the obvious candidate — this section and the scope list in
 *   src/lib/google-scopes.ts change together, and the OAuth verification posture
 *   changes with them (SPEC §3.3).
 *
 *   §5 is the Google API Services Limited Use disclosure. It is required
 *   verbatim-in-substance for any app holding gmail.readonly; do not trim it.
 *
 * Everything else follows the double-opt-in rule the send path enforces: nothing
 * about you reaches another member until both sides have said yes.
 */

import type { Metadata } from "next";

import { A, LegalPage, List, P, Section, Strong, SubHeading } from "@/app/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy — Dawn",
  description:
    "What Dawn collects, how it is used, who it is shared with, and the choices you have. Gmail is read as metadata only — never message content.",
};

const CONTACT = "pk@interplay.vc";

export default function PrivacyPolicy() {
  return (
    <LegalPage
      title="Privacy Policy"
      effective="August 17, 2026"
      summary={
        <>
          The short version: Dawn reads who you email and meet — the headers and
          attendee lists, never the contents of your messages — to work out who you
          already know and what you are looking for. Nothing about you is shown to
          another person until you have both agreed to an introduction. We do not sell
          your data, we do not run ads against it, and you can delete it at any time.
          The rest of this page is the detail behind that.
        </>
      }
    >
      <Section title="1. Who we are">
        <P>
          Dawn is a professional connection service operated by Interplay (&ldquo;Dawn&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;). This policy explains what personal information we
          collect when you use Dawn, why we collect it, who we share it with, and the
          choices you have. It applies to the Dawn website, the introductions Dawn sends
          by email, and everything you tell Dawn in chat.
        </P>
        <P>
          For questions about this policy, or to exercise any of the rights described in
          section 9, write to <A href={`mailto:${CONTACT}`}>{CONTACT}</A>.
        </P>
      </Section>

      <Section title="2. Information you give us">
        <SubHeading>Account information</SubHeading>
        <P>
          You sign in with Google. We receive your name, email address, profile picture,
          and Google account identifier from that sign-in. We do not receive or store your
          Google password.
        </P>

        <SubHeading>Profile and asks</SubHeading>
        <P>
          Your professional profile — role, company, background, focus, location — and the
          things you tell Dawn you are looking for: a hire, a check, a customer, a
          co-founder, advice. This includes anything you say to Dawn in chat, which Dawn
          may use to update your profile on your behalf. Treat your profile as information
          you are prepared to have shown to someone Dawn introduces you to.
        </P>

        <SubHeading>Communications with us</SubHeading>
        <P>
          Messages you send to Dawn, replies you send to introduction emails, and any
          support correspondence.
        </P>
      </Section>

      <Section title="3. Information we collect from connected accounts">
        <P>
          When you sign in, you grant Dawn read-only access to your Google account. What
          Dawn does with that access is narrower than what the permission technically
          allows, and it is worth being precise about:
        </P>

        <SubHeading>Gmail — metadata only</SubHeading>
        <P>
          Dawn reads message <Strong>headers</Strong>: sender, recipients, cc, date,
          subject line, and Gmail&rsquo;s own message and thread identifiers. Dawn does{" "}
          <Strong>not</Strong> read, store, or transmit the body of your emails, and does
          not access attachments. Dawn looks back roughly six months and does not read your
          full mail history.
        </P>

        <SubHeading>Google Calendar — read only</SubHeading>
        <P>
          Event times, titles, and attendee lists, used for the same purpose as mail
          headers: working out who you actually know and how recently.
        </P>

        <SubHeading>What that is for</SubHeading>
        <P>
          Both feeds build one thing — a private map of your professional network, held for
          you. Two people having emailed each other is a signal that they know each other;
          that is the whole of what Dawn takes from it. Your network map is not published,
          not shown to other members, and not used to let anyone browse your contacts.
        </P>

        <SubHeading>Technical information</SubHeading>
        <P>
          Standard server and security logs — IP address, browser type, timestamps, pages
          requested — kept to operate the service, debug it, and defend it from abuse. Dawn
          uses cookies only for what is necessary to keep you signed in. There are no
          advertising or third-party tracking cookies.
        </P>
      </Section>

      <Section title="4. How we use your information">
        <List>
          <li>To create and maintain your profile and keep it current as you tell Dawn things.</li>
          <li>
            To find candidate matches — people whose goals line up with yours — and to
            screen those matches for fit and legitimacy before proposing anything.
          </li>
          <li>
            To send you introduction proposals, and to send introductions once both sides
            have agreed.
          </li>
          <li>To send service messages: sign-in, security, changes to this policy.</li>
          <li>
            To operate, secure, debug, and improve the service, including preventing spam,
            fraud, and abuse.
          </li>
          <li>To comply with legal obligations and enforce our Terms.</li>
        </List>
        <P>
          We do not use your information to build advertising profiles, and we do not sell
          or rent it. Our legal bases, where the GDPR or UK GDPR applies, are performance of
          our contract with you (providing the service you signed up for), your consent
          (connecting your Google account, which you can withdraw at any time), and our
          legitimate interests in operating and securing the service.
        </P>
      </Section>

      <Section title="5. Google user data — Limited Use">
        <P>
          Dawn&rsquo;s use of information received from Google APIs adheres to the{" "}
          <A href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </A>
          , including the Limited Use requirements. Specifically:
        </P>
        <List>
          <li>
            Google user data is used only to provide and improve the user-facing features
            described in this policy — building your network map and matching you to people.
          </li>
          <li>Google user data is never transferred or sold to advertisers, data brokers, or information resellers.</li>
          <li>Google user data is never used for advertising, retargeting, or personalised advertising.</li>
          <li>
            No human reads your Google user data, except with your explicit consent, where
            it is necessary for security or to resolve a support issue you have raised, to
            comply with applicable law, or where the data has been aggregated and anonymised.
          </li>
          <li>
            Google user data is never used to train generalised or general-purpose AI models.
          </li>
        </List>
        <P>
          You can review or revoke Dawn&rsquo;s access to your Google account at any time at{" "}
          <A href="https://myaccount.google.com/permissions">
            myaccount.google.com/permissions
          </A>
          .
        </P>
      </Section>

      <Section title="6. When your information is shared with other people">
        <P>
          This is the part of Dawn worth reading twice, because it is the part that involves
          other humans.
        </P>
        <List>
          <li>
            <Strong>Nothing is shared until both sides say yes.</Strong> When Dawn thinks two
            people should meet, it emails each of you separately with context about the
            other and asks. Only when both of you agree does Dawn make the introduction and
            put you in touch. If either side declines or ignores it, the other side is not
            told who they were.
          </li>
          <li>
            <Strong>What the other person sees</Strong> is your name, your professional
            profile, and the ask that made the match relevant — the kind of information you
            would expect on a professional profile or in an intro email. Dawn does not share
            your contact list, your calendar, your email subject lines, or the raw signals
            behind the match.
          </li>
          <li>
            <Strong>Once you are introduced</Strong>, the other person has your email address
            and whatever you choose to say to them. That part is an ordinary email
            conversation, and it is outside our control.
          </li>
        </List>
      </Section>

      <Section title="7. Service providers and other disclosures">
        <P>
          We share information with a small number of vendors who process it on our behalf,
          under contract, only for the purposes we set:
        </P>
        <List>
          <li><Strong>Hosting and infrastructure</Strong> — running the website and its servers.</li>
          <li><Strong>Database and storage</Strong> — holding your profile, network map, and message history.</li>
          <li>
            <Strong>AI model providers</Strong> — Anthropic and OpenAI, which process profile
            text and match context to draft introductions, summarise profiles, and rank
            candidates. These providers act as processors and do not use your data to train
            their models.
          </li>
          <li><Strong>Email delivery</Strong> — sending introduction emails and receiving your replies.</li>
          <li><Strong>Analytics and error reporting</Strong> — understanding faults and usage in aggregate.</li>
        </List>
        <P>
          We may also disclose information where we are legally required to, to enforce our
          Terms, to protect the rights or safety of people using Dawn, or in connection with
          a merger, acquisition, or sale of assets — in which case we will tell you before
          your information becomes subject to a different privacy policy.
        </P>
      </Section>

      <Section title="8. How long we keep it">
        <P>
          We keep your profile and network map for as long as your account is open. If you
          delete your account, we delete or anonymise your personal information within 30
          days, except where we must keep something to comply with a legal obligation,
          resolve a dispute, or enforce our agreements. Emails already sent — including
          introductions — exist in the recipients&rsquo; mailboxes and cannot be recalled by us.
          Server logs are kept for a limited period for security purposes.
        </P>
      </Section>

      <Section title="9. Your choices and rights">
        <List>
          <li>
            <Strong>See and correct your profile.</Strong> Your profile is visible to you in
            the app and you can edit it directly, or just tell Dawn what changed.
          </li>
          <li>
            <Strong>Disconnect Google.</Strong> Revoke Dawn&rsquo;s access at{" "}
            <A href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</A>.
            Dawn stops receiving new mail and calendar signals immediately.
          </li>
          <li>
            <Strong>Stop the introductions.</Strong> Every introduction email has an
            unsubscribe link, and you can tell Dawn to pause at any time. We do not send
            marketing email you have not asked for.
          </li>
          <li>
            <Strong>Delete your account and data.</Strong> Email{" "}
            <A href={`mailto:${CONTACT}`}>{CONTACT}</A> and we will delete it.
          </li>
          <li>
            <Strong>Access, portability, objection, and restriction.</Strong> If you are in
            the EEA, the UK, or Switzerland, you have the right to access, correct, delete,
            port, object to, or restrict our processing of your personal data, and to
            complain to your local supervisory authority.
          </li>
          <li>
            <Strong>California residents.</Strong> You may request the categories and
            specific pieces of personal information we have collected, request deletion or
            correction, and are entitled not to be discriminated against for exercising
            those rights. We do not sell or share personal information for cross-context
            behavioural advertising.
          </li>
        </List>
        <P>
          We answer these requests within the timeframes the applicable law requires, and we
          may need to verify your identity first.
        </P>
      </Section>

      <Section title="10. Security">
        <P>
          Data is encrypted in transit and at rest, access to production systems is limited
          to people who need it, and Google credentials are stored as revocable tokens rather
          than passwords. No system is perfectly secure, and we cannot guarantee absolute
          security — but if a breach affects your personal information, we will notify you
          and the relevant regulators as the law requires.
        </P>
      </Section>

      <Section title="11. International transfers">
        <P>
          Dawn is operated from the United States, and your information is processed there.
          If you are outside the United States, using Dawn involves transferring your
          information across borders. Where required, we rely on the European Commission&rsquo;s
          Standard Contractual Clauses or another approved transfer mechanism.
        </P>
      </Section>

      <Section title="12. Children">
        <P>
          Dawn is for working professionals and is not directed at anyone under 18. We do
          not knowingly collect personal information from children. If you believe a minor
          has given us information, write to <A href={`mailto:${CONTACT}`}>{CONTACT}</A> and
          we will delete it.
        </P>
      </Section>

      <Section title="13. Changes to this policy">
        <P>
          We may update this policy as Dawn changes. If a change is material — particularly
          one that widens what we collect or who sees it — we will notify you by email or in
          the app before it takes effect. The effective date at the top of this page always
          reflects the current version.
        </P>
      </Section>

      <Section title="14. Contact">
        <P>
          Interplay — <A href={`mailto:${CONTACT}`}>{CONTACT}</A>. See also our{" "}
          <A href="/terms">Terms of Service</A>.
        </P>
      </Section>
    </LegalPage>
  );
}
