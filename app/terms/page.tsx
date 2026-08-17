/**
 * /terms — the terms of service, on its own URL for the footer, the Google OAuth
 * consent screen (which takes a terms URL alongside the privacy policy URL), and
 * anywhere the rules of the road need citing.
 *
 * Standard professional-network terms — the LinkedIn shape: eligibility, account,
 * acceptable use, content licence, disclaimers, liability cap, governing law —
 * narrowed to what Dawn actually is. The sections that are Dawn-specific rather
 * than boilerplate:
 *
 *   §5 (Introductions) states the double opt-in as a promise, because the send
 *   path enforces it and members should be able to hold us to it.
 *   §6 (Acceptable use) bans the two abuses this product invites in particular:
 *   working the intro flow as a lead-generation channel, and passing on what you
 *   learn about the other side of an introduction.
 *   §11 says Dawn is early and offered as-is, which is currently true.
 *
 * Governing law is Delaware. Change it here and in nothing else if the operating
 * entity's jurisdiction differs.
 */

import type { Metadata } from "next";

import { A, LegalPage, List, P, Section, Strong } from "@/app/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service — Dawn",
  description:
    "The rules for using Dawn: who can join, what you can and cannot do, how introductions work, and the legal terms behind the service.",
};

const CONTACT = "pk@interplay.vc";

export default function TermsOfService() {
  return (
    <LegalPage
      title="Terms of Service"
      effective="August 17, 2026"
      summary={
        <>
          The short version: be who you say you are, keep your asks honest, and treat the
          people Dawn introduces you to like people rather than leads. Dawn tries to find
          you good introductions but cannot promise any particular one, or any particular
          outcome from one. If you use Dawn to spam, scrape, or misrepresent yourself, we
          will close your account.
        </>
      }
    >
      <Section title="1. The agreement">
        <P>
          These Terms are a contract between you and Interplay (&ldquo;Dawn&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;) covering your use of the Dawn website, the
          introductions Dawn sends by email, and everything else we offer under the Dawn
          name (the &ldquo;Service&rdquo;). By signing in, you agree to them. If you do not
          agree, do not use the Service.
        </P>
        <P>
          Our <A href="/privacy">Privacy Policy</A> explains what we collect and how we use
          it, and is part of this agreement.
        </P>
      </Section>

      <Section title="2. Who can use Dawn">
        <P>
          You must be at least 18 years old and legally able to enter into a contract. You
          must not have been previously removed from the Service, and you must not be barred
          from using it under applicable law or sanctions. Dawn is a service for individual
          professionals: one account per person, registered under your real name, and not
          shared with anyone else.
        </P>
      </Section>

      <Section title="3. Your account">
        <P>
          You sign in with Google. You are responsible for keeping access to that Google
          account secure and for everything that happens under your Dawn account. Tell us
          promptly at <A href={`mailto:${CONTACT}`}>{CONTACT}</A> if you believe someone else
          has gained access.
        </P>
        <P>
          You agree to give accurate information about yourself and to keep it accurate.
          Dawn works by taking your profile and your asks at face value; a profile that is
          not true wastes other members&rsquo; time, and is grounds for us to close your account.
        </P>
      </Section>

      <Section title="4. What Dawn does, and what it does not">
        <P>
          Dawn builds a picture of your professional network and what you are looking for,
          then proposes introductions to people whose goals appear to line up with yours.
          Dawn screens matches for fit and legitimacy, but we do not perform background
          checks, verify credentials, or vouch for anyone.
        </P>
        <List>
          <li>
            We do not guarantee that you will receive any introductions, that any particular
            person will be introduced to you, or that an introduction will lead to a job, an
            investment, a hire, a customer, or anything else.
          </li>
          <li>
            Dawn is not an employment agency, a recruiter, a broker-dealer, an investment
            adviser, or a placement agent, and nothing it sends you is legal, financial,
            investment, tax, or employment advice.
          </li>
          <li>
            Your dealings with anyone Dawn introduces you to are between you and them. We are
            not a party to those conversations or to anything that results from them, and we
            are not responsible for the conduct of other members.
          </li>
        </List>
      </Section>

      <Section title="5. Introductions and consent">
        <P>
          Introductions are double opt-in. When Dawn identifies a match, it contacts each
          side separately with context about the other and asks. Dawn puts you in touch only
          if you both agree. If you decline or ignore a proposal, the other side is not told
          who you were.
        </P>
        <P>
          By using the Service you agree to receive introduction proposals, introduction
          emails, follow-ups on an open introduction, and service messages about your account
          — at the email address on your Google account. Every introduction email has an
          unsubscribe link, and you can tell Dawn to pause or stop at any time.
        </P>
        <P>
          When you accept an introduction, the other person receives your name, professional
          profile, ask, and email address. Accepting is your consent to that. If you would
          rather they did not have it, decline.
        </P>
      </Section>

      <Section title="6. Acceptable use">
        <P>You agree not to:</P>
        <List>
          <li>
            Misrepresent yourself, your role, your company, your credentials, or your reason
            for wanting an introduction — including impersonating anyone or implying an
            affiliation you do not have.
          </li>
          <li>
            <Strong>Use introductions as a bulk sales channel.</Strong> Approaching someone
            Dawn introduced you to about the thing you were introduced for is the point.
            Adding them to a marketing list, a CRM sequence, a newsletter, or an automated
            outreach campaign without their consent is not, and is a breach of these Terms
            and possibly of anti-spam law.
          </li>
          <li>
            <Strong>Pass on what you learn about the other side.</Strong> Information about a
            person Dawn proposes to you — including that they are looking for something, or
            that they exist in Dawn at all — is for deciding whether to accept, not for
            resale, publication, recruiting databases, or forwarding to third parties.
          </li>
          <li>
            Harass, threaten, defraud, discriminate against, or otherwise abuse anyone you
            meet through the Service.
          </li>
          <li>
            Scrape, crawl, harvest, copy, or bulk-export data from the Service; access it by
            any automated means; or attempt to reconstruct another member&rsquo;s network,
            contacts, or profile data.
          </li>
          <li>
            Reverse engineer, decompile, interfere with, overload, or probe the Service or
            its security, or bypass any access control or rate limit.
          </li>
          <li>
            Resell, sublicense, or commercially exploit the Service or the introductions it
            produces, or charge anyone for access to them.
          </li>
          <li>
            Upload malware, post unlawful content, infringe anyone&rsquo;s intellectual property
            or privacy rights, or use the Service to violate any applicable law.
          </li>
        </List>
        <P>
          We may investigate suspected breaches and may suspend or close accounts, remove
          content, and report conduct to the authorities where appropriate.
        </P>
      </Section>

      <Section title="7. Your content">
        <P>
          Your profile, your asks, and anything else you give Dawn remain yours. You grant us
          a worldwide, non-exclusive, royalty-free licence to host, store, process, adapt, and
          display that content for the purpose of operating the Service — which includes
          summarising it, matching on it, and showing it to a person you have agreed to be
          introduced to. That licence ends when you delete the content or your account,
          except for copies already sent in email and for backups pending deletion.
        </P>
        <P>
          You confirm you have the right to give us the content you provide, including any
          information about your employer or third parties, and that sharing it with us does
          not breach a confidentiality obligation you owe someone else.
        </P>
      </Section>

      <Section title="8. Third-party services">
        <P>
          Dawn depends on services we do not control — Google for sign-in and for the mail
          and calendar signals you authorise, and email infrastructure for delivery. Your use
          of those services is governed by their own terms, and we are not responsible for
          their availability or their acts. Revoking Dawn&rsquo;s access to your Google account
          will stop parts of the Service from working.
        </P>
      </Section>

      <Section title="9. Our intellectual property">
        <P>
          The Service, including its software, design, and the Dawn name and marks, belongs
          to us and our licensors. These Terms grant you a limited, personal, non-transferable,
          revocable licence to use the Service as intended, and nothing more.
        </P>
      </Section>

      <Section title="10. Feedback">
        <P>
          If you send us suggestions about the Service, we may use them without restriction
          or obligation to you. Please do not send us anything you consider confidential.
        </P>
      </Section>

      <Section title="11. Availability, changes, and fees">
        <P>
          Dawn is an early product. We may add, change, suspend, or discontinue features —
          or the whole Service — at any time, and we may impose limits on use. We will give
          reasonable notice of a material change where we can.
        </P>
        <P>
          The Service is currently free. If we introduce fees, we will tell you before they
          apply to you, and you can stop using the Service instead of paying them.
        </P>
      </Section>

      <Section title="12. Termination">
        <P>
          You can stop using Dawn and delete your account at any time by emailing{" "}
          <A href={`mailto:${CONTACT}`}>{CONTACT}</A>. We may suspend or terminate your access
          if you breach these Terms, if we are required to by law, or if we discontinue the
          Service. Sections that by their nature should survive termination — content licence
          for what was already shared, disclaimers, limitation of liability, indemnity, and
          governing law — do.
        </P>
      </Section>

      <Section title="13. Disclaimers">
        <P>
          The Service is provided <Strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</Strong>,
          without warranties of any kind, express or implied, including implied warranties of
          merchantability, fitness for a particular purpose, title, and non-infringement. We
          do not warrant that the Service will be uninterrupted, secure, or error-free, that
          matches will be accurate or relevant, or that information provided by other members
          is true. Some jurisdictions do not allow certain disclaimers, in which case they
          apply to the extent permitted.
        </P>
      </Section>

      <Section title="14. Limitation of liability">
        <P>
          To the fullest extent permitted by law, we are not liable for indirect, incidental,
          special, consequential, exemplary, or punitive damages, or for lost profits, lost
          business, lost opportunities, lost data, or damage to reputation, arising out of or
          relating to the Service — even if we were advised such damages were possible. Our
          total liability for all claims relating to the Service is limited to the greater of
          the amount you paid us in the twelve months before the claim, or US$100.
        </P>
        <P>
          Nothing in these Terms limits liability that cannot be limited under applicable law,
          including liability for fraud, death, or personal injury caused by negligence.
        </P>
      </Section>

      <Section title="15. Indemnification">
        <P>
          You agree to indemnify and hold us harmless from claims, damages, losses, and
          reasonable legal fees arising out of your use of the Service, your content, your
          conduct toward other members, or your breach of these Terms or of any law.
        </P>
      </Section>

      <Section title="16. Governing law and disputes">
        <P>
          These Terms are governed by the laws of the State of Delaware, United States,
          without regard to its conflict-of-laws rules. You and we agree to the exclusive
          jurisdiction of the state and federal courts located in Delaware for any dispute
          that is not resolved informally. If you are a consumer resident in the EEA or the
          UK, nothing here deprives you of the protection of the mandatory laws of your
          country of residence, or of the right to bring proceedings there.
        </P>
        <P>
          Before filing anything, please write to <A href={`mailto:${CONTACT}`}>{CONTACT}</A>{" "}
          — most disputes are faster to resolve that way.
        </P>
      </Section>

      <Section title="17. General">
        <P>
          These Terms, together with the <A href="/privacy">Privacy Policy</A>, are the entire
          agreement between us about the Service. If a provision is found unenforceable, the
          rest stays in force. Our not enforcing a provision is not a waiver of it. You may
          not assign these Terms; we may assign them in connection with a merger, acquisition,
          or sale of assets.
        </P>
      </Section>

      <Section title="18. Changes to these Terms">
        <P>
          We may update these Terms. If a change is material, we will notify you by email or
          in the app before it takes effect, and continuing to use the Service after that
          means you accept the updated Terms. The effective date at the top of this page
          always reflects the current version.
        </P>
      </Section>

      <Section title="19. Contact">
        <P>
          Interplay — <A href={`mailto:${CONTACT}`}>{CONTACT}</A>.
        </P>
      </Section>
    </LegalPage>
  );
}
