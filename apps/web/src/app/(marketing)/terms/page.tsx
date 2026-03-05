import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service — Sandchest',
  description:
    'Terms of Service for the Sandchest sandbox platform. Read the terms governing your use of our services, SDKs, APIs, and related tools.',
  openGraph: {
    title: 'Terms of Service — Sandchest',
    description:
      'Terms of Service for the Sandchest sandbox platform. Read the terms governing your use of our services, SDKs, APIs, and related tools.',
    images: ['/og.png'],
    type: 'website',
  },
}

export default function TermsPage() {
  return (
    <article
      style={{
        padding: 'var(--vertical-padding) var(--padding)',
        maxWidth: '52rem',
      }}
    >
      <p
        className="text-text-weak font-semibold uppercase"
        style={{ fontSize: 13, letterSpacing: 0.5, marginBottom: 16 }}
      >
        Legal
      </p>

      <h1
        className="text-text-strong font-bold"
        style={{ fontSize: 38, lineHeight: 1.1, marginBottom: 8 }}
      >
        Terms of Service
      </h1>

      <p className="text-text-weak" style={{ marginBottom: 48 }}>
        Effective date: March 5, 2026
      </p>

      {/* ------------------------------------------------------------------ */}
      <Section title="1. Introduction">
        <p>
          These Terms of Service (&quot;Terms&quot;) are a binding agreement
          between you (&quot;Customer,&quot; &quot;you,&quot; or
          &quot;your&quot;) and Cap Software, Inc., doing business as Sandchest
          (&quot;Sandchest,&quot; &quot;we,&quot; &quot;us,&quot; or
          &quot;our&quot;), a Delaware corporation, and govern your
          access to and use of the Sandchest website at sandchest.com (the
          &quot;Site&quot;), the Sandchest cloud sandbox platform, all software
          development kits, application programming interfaces, command-line
          tools, MCP servers, and any related services (collectively, the
          &quot;Service&quot;).
        </p>
        <p>
          By accessing or using the Service you agree to be bound by these
          Terms. If you are using the Service on behalf of an organization, you
          represent and warrant that you have authority to bind that organization
          to these Terms, and &quot;Customer&quot; refers to that organization.
        </p>
        <p>
          If you do not agree to these Terms, do not access or use the Service.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="2. Definitions">
        <p>
          <strong className="text-text-strong">&quot;Account&quot;</strong> means
          the account you create to access the Service.
        </p>
        <p>
          <strong className="text-text-strong">&quot;Customer Content&quot;</strong>{' '}
          means any code, data, files, artifacts, memory snapshots, and other
          materials that you or your AI agents upload, create, or store within
          the Service.
        </p>
        <p>
          <strong className="text-text-strong">&quot;Sandbox&quot;</strong> means
          an isolated Firecracker microVM environment provisioned through the
          Service, including its compute resources, filesystem, network access,
          and any forked copies.
        </p>
        <p>
          <strong className="text-text-strong">&quot;Session Replay&quot;</strong>{' '}
          means the recorded log of commands, outputs, and events within a
          Sandbox session, accessible via a shareable URL subject to the
          retention policies described in Section 7.
        </p>
        <p>
          <strong className="text-text-strong">&quot;AI Agent&quot;</strong>{' '}
          means any automated software agent, AI model, or autonomous system
          that accesses the Service using your API keys or Account credentials.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="3. Service Description">
        <p>
          Sandchest provides a managed sandbox platform that allows AI Agents
          and human developers to execute code, run software, and store data in
          Sandboxes. The Service includes APIs, SDKs, a CLI, an MCP server, a
          web dashboard, and Session Replay functionality.
        </p>
        <p>
          The Service is subject to rate limits and usage quotas as documented on
          the Site. Sandchest may throttle or temporarily restrict access if
          usage exceeds applicable limits.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="4. Eligibility">
        <p>
          You must be at least 18 years old and capable of forming a binding
          contract to use the Service. By creating an Account, you represent
          that you meet these requirements.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="5. Accounts">
        <p>
          To access the Service you must create an Account. You agree to provide
          accurate and complete registration information and to keep your Account
          credentials confidential. You must promptly notify Sandchest of any
          unauthorized use of your Account.
        </p>
        <p>
          You are responsible for all activities that occur under your Account,
          including actions taken by AI Agents operating with your API keys.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="6. AI Agent Use">
        <p>
          The Service is designed for use by AI Agents operating autonomously.
          You acknowledge and agree that:
        </p>
        <ul>
          <li>
            You are solely responsible for all actions taken by AI Agents using
            your credentials, including code execution, network requests, data
            access, and resource consumption.
          </li>
          <li>
            Sandchest does not monitor, review, or validate code executed by AI
            Agents within Sandboxes.
          </li>
          <li>
            You must implement appropriate safeguards, supervision, and
            human-in-the-loop controls for autonomous agent operations.
          </li>
          <li>
            Sandchest is not liable for any output, side effect, or damage
            caused by AI-generated or AI-executed code within Sandboxes.
          </li>
          <li>
            Sandchest may suspend Sandboxes that exhibit harmful or abusive
            automated behavior without prior notice.
          </li>
        </ul>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="7. Session Replay and Recording">
        <p>
          All Sandbox sessions are recorded and may be replayed via shareable
          URLs as part of the Session Replay feature. Session Replay data is
          treated as Customer Content and subject to the same access controls,
          retention policies, and deletion timelines described in these Terms.
          Replay URLs remain accessible for as long as the underlying data is
          retained; they are not guaranteed to be available indefinitely.
        </p>
        <p>
          You are responsible for ensuring that sensitive credentials, secrets,
          or personal data are not entered into recorded sessions. Replay URLs
          are accessible only to members of your organization unless you
          explicitly share them.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="8. Sandbox Forking and Snapshots">
        <p>
          The Service supports sub-second forking of Sandboxes via memory
          snapshots. Memory snapshots contain the full in-memory state of the
          guest microVM at the time of the fork.
        </p>
        <p>
          Forked Sandboxes and their underlying memory snapshots are treated as
          Customer Content and are subject to the same retention and deletion
          policies. You acknowledge that snapshots are inherently sensitive and
          should be managed accordingly.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="9. Acceptable Use">
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>
            Violate any applicable law, regulation, or third-party right.
          </li>
          <li>
            Distribute malware, ransomware, or any other malicious software.
          </li>
          <li>
            Engage in cryptocurrency mining or similar resource-intensive
            activities not related to your legitimate development use case.
          </li>
          <li>
            Attempt to gain unauthorized access to other users&apos; Sandboxes,
            Accounts, or data.
          </li>
          <li>
            Interfere with or disrupt the Service or its underlying
            infrastructure.
          </li>
          <li>
            Use the Service to send spam, phishing messages, or other
            unsolicited communications.
          </li>
          <li>
            Circumvent any rate limits, usage quotas, or security controls.
          </li>
          <li>
            Store, process, or transmit content that is illegal, harmful, or
            infringes third-party intellectual property rights.
          </li>
        </ul>
        <p>
          You are responsible for all network activity originating from your
          Sandboxes, including outbound requests made by your code or AI Agents.
          Sandchest reserves the right to restrict network access in cases of
          abuse.
        </p>
        <p>
          We reserve the right to investigate and take appropriate action,
          including suspension or termination of your Account, for any violation
          of this section.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="10. Customer Content">
        <p>
          You retain all rights in your Customer Content. You grant Sandchest a
          limited, non-exclusive license to host, store, and transmit your
          Customer Content solely as necessary to provide and maintain the
          Service. Sandchest will not use your Customer Content for any other
          purpose, including training machine-learning models, deriving
          analytics, or creating aggregate data products.
        </p>
        <p>
          You are solely responsible for the legality, accuracy, and
          appropriateness of your Customer Content. Artifacts stored via the
          Service are retained for the duration of your active Account and
          deleted in accordance with Section 17 upon termination.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="11. Pricing and Payment">
        <p>
          Current fees for the Service are listed on the Site or in a mutually
          agreed written order form. Fees are credit-based: each Account
          receives a monthly credit allowance, and usage is deducted from that
          balance. Credits cover compute time and any other metered dimensions
          described on the Site. All fees are exclusive of taxes; you are
          responsible for all applicable taxes, duties, and levies, except taxes
          on Sandchest&apos;s net income.
        </p>
        <p>
          Compute usage is metered per minute of Sandbox uptime and deducted
          from your credit balance. Sandchest bills monthly in arrears for any
          overage beyond your credit allowance. All fees are non-refundable
          except as expressly stated in
          these Terms or required by applicable law. Refunds for termination
          without cause are described in Section 17.
        </p>
        <p>
          We may change our pricing upon thirty (30) days&apos; prior written
          notice sent to the email address associated with your Account. For
          customers on active order forms, pricing changes take effect at the
          next renewal period. Continued use of the Service after a price change
          takes effect constitutes acceptance of the new pricing.
        </p>
        <p>
          Overdue amounts accrue interest at the lesser of 1.5% per month or the
          maximum rate permitted by applicable law.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="12. Free Tier and Credits">
        <p>
          Sandchest may offer a free tier or promotional credits at its
          discretion. Free-tier usage is subject to the same Terms. We reserve
          the right to modify or discontinue free-tier offerings at any time
          with reasonable notice.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="13. Beta and Preview Services">
        <p>
          Sandchest may offer beta, preview, or early-access features
          (&quot;Beta Services&quot;). Beta Services are provided &quot;as
          is&quot; with no warranty or SLA, may change or be discontinued
          without notice, and should not be relied upon for production
          workloads. Sandchest has no liability for any harm arising from your
          use of Beta Services.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="14. Intellectual Property">
        <p>
          Sandchest and its licensors retain all right, title, and interest in
          the Service, including all software, APIs, SDKs, documentation,
          trademarks, and other intellectual property. Nothing in these Terms
          grants you any right to use Sandchest&apos;s trademarks or branding
          without prior written consent.
        </p>
        <p>
          The Service may include open-source software components, which are
          licensed under their respective open-source licenses.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="15. Copyright Infringement (DMCA)">
        <p>
          Sandchest respects intellectual property rights. If you believe that
          content hosted on the Service infringes your copyright, you may submit
          a notice to our designated DMCA agent at{' '}
          <a href="mailto:legal@sandchest.com" className="text-accent">
            legal@sandchest.com
          </a>{' '}
          containing: (a) identification of the copyrighted work; (b)
          identification of the infringing material and its location on the
          Service; (c) your contact information; (d) a statement of good-faith
          belief that the use is not authorized; (e) a statement under penalty
          of perjury that the information is accurate and you are authorized to
          act on behalf of the copyright owner; and (f) your physical or
          electronic signature.
        </p>
        <p>
          Upon receipt of a valid notice, Sandchest will act in accordance with
          the Digital Millennium Copyright Act, including removing or disabling
          access to the allegedly infringing material. Counter-notices may be
          submitted to the same address.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="16. Data Security and Privacy">
        <p>
          Sandchest implements commercially reasonable technical and
          organizational measures designed to protect Customer Content against
          unauthorized access, use, or disclosure. Each Sandbox runs in an
          isolated Firecracker microVM with VM-grade security boundaries.
        </p>
        <p>
          However, no method of electronic transmission or storage is 100%
          secure. You acknowledge that you are responsible for maintaining
          appropriate security measures for your own systems and credentials.
        </p>
        <p>
          In the event of a confirmed security breach that results in
          unauthorized access to your Customer Content, Sandchest will notify
          you without undue delay (and in any event within seventy-two (72)
          hours of confirmation) via the email address associated with your
          Account. The notification will describe the nature of the breach, the
          categories of data affected, and the measures taken or proposed to
          address it.
        </p>
        <p>
          Our collection and use of personal information is governed by our{' '}
          <Link href="/privacy" className="text-accent">
            Privacy Policy
          </Link>
          , which is incorporated into these Terms by reference. For customers
          subject to data protection laws (such as GDPR or CCPA), Sandchest
          will enter into a Data Processing Agreement upon request. Contact{' '}
          <a href="mailto:legal@sandchest.com" className="text-accent">
            legal@sandchest.com
          </a>{' '}
          to request a DPA.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="17. Suspension and Termination">
        <p>
          <strong className="text-text-strong">By you.</strong> You may
          terminate your Account at any time by contacting us or through the
          dashboard. Termination does not relieve you of any obligation to pay
          fees incurred before termination.
        </p>
        <p>
          <strong className="text-text-strong">By Sandchest for cause.</strong>{' '}
          We may suspend or terminate your access to the Service immediately
          if: (a) required by law or government request; (b) your use poses a
          security risk to the Service or other users; (c) your Account is
          overdue by thirty (30) days or more; (d) you breach these Terms.
        </p>
        <p>
          <strong className="text-text-strong">
            By Sandchest without cause.
          </strong>{' '}
          We may terminate your Account for any reason upon thirty (30)
          days&apos; prior written notice. If we terminate without cause, we
          will refund any prepaid fees or unused credit balance for the
          remaining portion of the then-current billing period.
        </p>
        <p>
          Upon termination, your right to use the Service ceases immediately. We
          will provide you with a means to export your Customer Content (such as
          API access or a downloadable archive) for thirty (30) days following
          termination, after which we may delete it.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="18. Service Availability">
        <p>
          Sandchest will use commercially reasonable efforts to make the Service
          available, but does not guarantee uninterrupted or error-free
          operation. The Service may be subject to scheduled maintenance,
          updates, and occasional downtime.
        </p>
        <p>
          We will use reasonable efforts to provide advance notice of planned
          maintenance that may materially affect the Service.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="19. Third-Party Services">
        <p>
          The Service may integrate with or enable access to third-party
          services, APIs, AI providers, or tools. Sandchest does not control and
          is not responsible for third-party services. Your use of third-party
          services is governed by their respective terms and policies. Sandchest
          disclaims all liability for any loss or damage arising from your use
          of third-party services in conjunction with the Service.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="20. Export Compliance">
        <p>
          The Service is subject to United States export control and trade
          sanctions laws, including the Export Administration Regulations (EAR)
          and regulations administered by the Office of Foreign Assets Control
          (OFAC). You represent and warrant that: (a) you are not located in, or
          a resident of, any country subject to U.S. trade sanctions; (b) you
          are not on any U.S. government denied-party list; and (c) you will not
          use the Service to export or re-export controlled technology in
          violation of applicable laws.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="21. Disclaimer of Warranties">
        <p>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS
          AVAILABLE.&quot; TO THE MAXIMUM EXTENT PERMITTED BY LAW, SANDCHEST
          DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT
          LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
        </p>
        <p>
          SANDCHEST DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED,
          ERROR-FREE, OR SECURE, OR THAT ANY DEFECTS WILL BE CORRECTED.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="22. Limitation of Liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL SANDCHEST,
          ITS AFFILIATES, OFFICERS, DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE
          FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
          DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, OR USE, ARISING OUT
          OF OR RELATED TO THESE TERMS OR THE SERVICE, REGARDLESS OF THE THEORY
          OF LIABILITY.
        </p>
        <p>
          SANDCHEST&apos;S TOTAL AGGREGATE LIABILITY UNDER THESE TERMS SHALL NOT
          EXCEED THE GREATER OF (A) THE AMOUNTS PAID BY YOU TO SANDCHEST IN THE
          TWELVE (12) MONTHS PRECEDING THE CLAIM, OR (B) ONE HUNDRED U.S.
          DOLLARS ($100).
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="23. Indemnification">
        <p>
          You agree to indemnify, defend, and hold harmless Sandchest and its
          affiliates, officers, directors, employees, and agents from and
          against any claims, liabilities, damages, losses, and expenses
          (including reasonable attorney&apos;s fees) arising out of or related
          to: (a) your use of the Service; (b) your Customer Content; (c)
          actions taken by your AI Agents; (d) your violation of these Terms; or
          (e) your violation of any third-party right.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="24. Dispute Resolution">
        <p>
          <strong className="text-text-strong">Informal Resolution.</strong>{' '}
          Before initiating any formal proceeding, you agree to contact us at{' '}
          <a href="mailto:legal@sandchest.com" className="text-accent">
            legal@sandchest.com
          </a>{' '}
          and attempt to resolve the dispute informally for at least sixty (60)
          days.
        </p>
        <p>
          <strong className="text-text-strong">Arbitration.</strong> If the
          dispute is not resolved informally, either party may elect to resolve
          it by binding arbitration administered by JAMS under its Streamlined
          Arbitration Rules. The arbitration will be conducted in English and
          held in Wilmington, Delaware (or remotely at either party&apos;s
          election). The arbitrator&apos;s decision is final and enforceable in
          any court of competent jurisdiction.
        </p>
        <p>
          <strong className="text-text-strong">Class Action Waiver.</strong> You
          agree that any dispute resolution proceeding will be conducted only on
          an individual basis and not as a class, consolidated, or
          representative action.
        </p>
        <p>
          <strong className="text-text-strong">Exceptions.</strong> Either party
          may seek injunctive relief in any court of competent jurisdiction for
          intellectual property infringement or other urgent equitable claims.
          Claims within the jurisdiction of a small-claims court may be brought
          there.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="25. Governing Law">
        <p>
          These Terms are governed by and construed in accordance with the laws
          of the State of Delaware, United States, without regard to its
          conflict of law principles.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="26. Modifications to Terms">
        <p>
          We may update these Terms from time to time. We will notify you of
          material changes by emailing the address associated with your Account
          and updating the &quot;Effective date&quot; above at least thirty (30)
          days before the changes take effect. Your continued use of the Service
          after such changes constitutes acceptance of the updated Terms.
        </p>
        <p>
          If you do not agree to the updated Terms, you must stop using the
          Service before the changes take effect.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="27. Modifications to Service">
        <p>
          Sandchest may modify, update, or discontinue any part of the Service
          at any time. We will use reasonable efforts to provide advance notice
          of material changes. Continued use of the Service after modifications
          constitutes acceptance of the modified Service.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="28. Notices">
        <p>
          Notices to you will be sent to the email address associated with your
          Account and are deemed received when sent. Notices to Sandchest must
          be sent to{' '}
          <a href="mailto:legal@sandchest.com" className="text-accent">
            legal@sandchest.com
          </a>{' '}
          and are deemed received upon confirmed delivery.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="29. General">
        <p>
          <strong className="text-text-strong">Entire Agreement.</strong> These
          Terms, together with the Privacy Policy, any Data Processing
          Agreement, and any order forms, constitute the entire agreement
          between you and Sandchest regarding the Service.
        </p>
        <p>
          <strong className="text-text-strong">Severability.</strong> If any
          provision of these Terms is held invalid or unenforceable, the
          remaining provisions shall remain in full force and effect.
        </p>
        <p>
          <strong className="text-text-strong">Waiver.</strong> Failure to
          enforce any right or provision of these Terms shall not constitute a
          waiver of that right or provision.
        </p>
        <p>
          <strong className="text-text-strong">Assignment.</strong> You may not
          assign these Terms without our prior written consent. Sandchest may
          assign these Terms in connection with a merger, acquisition, or sale
          of all or substantially all of its assets, with notice to you.
        </p>
        <p>
          <strong className="text-text-strong">Force Majeure.</strong> Neither
          party shall be liable for delays or failures in performance resulting
          from causes beyond its reasonable control, including acts of God,
          natural disasters, war, terrorism, labor disputes, or internet service
          disruptions.
        </p>
        <p>
          <strong className="text-text-strong">Survival.</strong> Sections 2
          (Definitions), 6 (AI Agent Use), 10 (Customer Content), 11 (Pricing
          and Payment), 14 (Intellectual Property), 15 (DMCA), 16 (Data
          Security and Privacy), 20 (Export Compliance), 21 (Disclaimer of
          Warranties), 22 (Limitation of Liability), 23 (Indemnification), 24
          (Dispute Resolution), 25 (Governing Law), and this Section 29 shall
          survive any termination or expiration of these Terms.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="30. Contact">
        <p>
          If you have questions about these Terms, contact us at{' '}
          <a href="mailto:legal@sandchest.com" className="text-accent">
            legal@sandchest.com
          </a>
          .
        </p>
      </Section>
    </article>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  const id = title.toLowerCase().replace(/\W+/g, '-')

  return (
    <section style={{ marginBottom: 40 }} aria-labelledby={id}>
      <h2
        id={id}
        className="text-text-strong font-semibold"
        style={{ fontSize: 20, marginBottom: 16 }}
      >
        {title}
      </h2>
      <div className="terms-body">{children}</div>
    </section>
  )
}
