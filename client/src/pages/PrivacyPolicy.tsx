import CompliancePageLayout from "@/components/CompliancePageLayout";

const privacyDescription =
  "Learn how Aroma Institute of Cafe & Hospitality Management handles information submitted through its website, enquiry forms, applications, and Meta/Facebook lead forms.";

export default function PrivacyPolicy() {
  return (
    <CompliancePageLayout
      title="Privacy Policy"
      description={privacyDescription}
    >
      <p>
        This Privacy Policy applies to the Aroma Institute of Cafe &amp; Hospitality
        Management website, enquiry and application forms, and information received
        through Meta/Facebook lead forms for the Institute&apos;s programmes.
      </p>

      <section aria-labelledby="information-we-receive" className="space-y-3">
        <h2 id="information-we-receive" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Information we may receive
        </h2>
        <p>
          Depending on how you contact us, we may receive your name, phone number,
          email address, programme interest, message or enquiry details, and relevant
          communications with the Institute. Website hosting and security systems may
          also process technical information as part of operating and protecting the site.
        </p>
      </section>

      <section aria-labelledby="how-we-use-information" className="space-y-3">
        <h2 id="how-we-use-information" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          How we use information
        </h2>
        <p>Information may be used to:</p>
        <ul className="list-disc space-y-2 pl-5 marker:text-primary">
          <li>Respond to enquiries and provide counselling or programme and admission information.</li>
          <li>Process applications and admissions.</li>
          <li>Coordinate training, internship, or placement support where relevant.</li>
          <li>Operate, maintain, and secure the website and the Institute&apos;s CRM and communications.</li>
          <li>Meet applicable legal obligations and address legitimate operational needs.</li>
        </ul>
      </section>

      <section aria-labelledby="access-and-sharing" className="space-y-3">
        <h2 id="access-and-sharing" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Access and sharing
        </h2>
        <p>
          Access to information is limited to Institute personnel who need it for their
          work. Service providers supporting hosting, CRM, communications, or other
          operations may process information as needed to provide those services.
        </p>
        <p>
          If you enroll or seek internship or placement support, limited relevant
          information may be shared with appropriate hospitality partners only when
          needed for that purpose and with appropriate notice or consent. An enquiry
          alone is not automatically shared with partners.
        </p>
      </section>

      <section aria-labelledby="meta-lead-forms" className="space-y-3">
        <h2 id="meta-lead-forms" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Meta/Facebook lead forms
        </h2>
        <p>
          Meta independently processes platform information under its own policies.
          When you submit a lead form for an Aroma Institute programme, the information
          you provide through that form is made available to the Institute so it can
          respond to your enquiry.
        </p>
      </section>

      <section aria-labelledby="cookies-and-technical-information" className="space-y-3">
        <h2 id="cookies-and-technical-information" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Cookies and technical information
        </h2>
        <p>
          The website and its hosting or security providers may use essential cookies
          and technical logs where used to operate, maintain, troubleshoot, and secure
          the site. The public admissions pages also support optional Meta marketing
          measurement when enabled and when you give consent; this may involve browser
          storage or cookies used for that measurement. You can reject or withdraw that
          optional consent through the Privacy settings shown on public admissions pages.
          The use of optional measurement depends on the site configuration and your
          preference.
        </p>
      </section>

      <section aria-labelledby="security-and-retention" className="space-y-3">
        <h2 id="security-and-retention" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Security and retention
        </h2>
        <p>
          The Institute uses reasonable safeguards intended to protect information.
          No method of storage or transmission can be guaranteed to be completely secure.
          Information is kept only for as long as reasonably needed for the purposes
          described here or to meet legal obligations.
        </p>
      </section>

      <section aria-labelledby="your-requests" className="space-y-3">
        <h2 id="your-requests" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Your requests
        </h2>
        <p>
          Where applicable, you may request access to, correction of, or deletion of
          your personal information, or withdraw consent. Email{" "}
          <a className="font-semibold text-primary underline underline-offset-4" href="mailto:admissions@aromainstitute.in?subject=Privacy%20Request">
            admissions@aromainstitute.in
          </a>{" "}
          with the subject line <strong className="text-foreground">Privacy Request</strong>.
          We may ask for information to reasonably verify your request. Some information
          may need to be retained where required by law or in connection with a dispute.
        </p>
      </section>

      <section aria-labelledby="contact" className="space-y-3">
        <h2 id="contact" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Contact
        </h2>
        <address className="not-italic">
          Aroma Institute of Cafe &amp; Hospitality Management
          <br />
          Gurukul Road, Memnagar, Ahmedabad, Gujarat, India
          <br />
          <a className="font-semibold text-primary underline underline-offset-4" href="tel:+919274868669">+91 9274868669</a>
          <br />
          <a className="font-semibold text-primary underline underline-offset-4" href="mailto:admissions@aromainstitute.in">admissions@aromainstitute.in</a>
        </address>
      </section>

      <p className="border-t border-border pt-5 text-sm text-muted-foreground">
        Last updated: 14 November 2026
      </p>
    </CompliancePageLayout>
  );
}
