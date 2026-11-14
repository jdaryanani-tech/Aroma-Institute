import CompliancePageLayout from "@/components/CompliancePageLayout";

const deletionDescription =
  "Instructions for requesting deletion of information submitted to Aroma Institute of Cafe & Hospitality Management through the website or Meta/Facebook lead forms.";

export default function DataDeletion() {
  return (
    <CompliancePageLayout
      title="Data Deletion Instructions"
      description={deletionDescription}
    >
      <p>
        You can ask Aroma Institute of Cafe &amp; Hospitality Management to review a
        request to delete personal information you submitted through this website or
        through a Meta/Facebook lead form for an Institute programme.
      </p>

      <section aria-labelledby="send-a-request" className="space-y-3">
        <h2 id="send-a-request" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Send a deletion request
        </h2>
        <p>
          Email us with the name and phone number or email address used in your enquiry.
          You may also mention the programme you asked about or the approximate date of
          the enquiry to help us identify the relevant record.
        </p>
        <a
          href="mailto:admissions@aromainstitute.in?subject=Data%20Deletion%20Request"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-3 text-center font-semibold text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Email a Data Deletion Request
        </a>
        <p>
          Email:{" "}
          <a className="font-semibold text-primary underline underline-offset-4" href="mailto:admissions@aromainstitute.in?subject=Data%20Deletion%20Request">
            admissions@aromainstitute.in
          </a>
        </p>
      </section>

      <section aria-labelledby="review-process" className="space-y-3">
        <h2 id="review-process" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Review of your request
        </h2>
        <p>
          The Institute will review the request and confirm the outcome. We may ask
          for reasonable identity verification before acting on it. A request does
          not mean information is deleted automatically.
        </p>
      </section>

      <section aria-labelledby="information-that-may-be-retained" className="space-y-3">
        <h2 id="information-that-may-be-retained" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Information that may need to be retained
        </h2>
        <p>
          Limited records may be retained where required by law, for legitimate
          accounting or compliance needs, to resolve disputes, or to protect the
          security of the Institute and its services.
        </p>
      </section>

      <section aria-labelledby="assistance" className="space-y-3">
        <h2 id="assistance" className="font-serif text-xl font-bold text-foreground sm:text-2xl">
          Need assistance?
        </h2>
        <p>
          Call{" "}
          <a className="font-semibold text-primary underline underline-offset-4" href="tel:+919274868669">
            +91 9274868669
          </a>{" "}
          if you need help sending your request.
        </p>
        <address className="not-italic">
          Gurukul Road, Memnagar, Ahmedabad, Gujarat, India
        </address>
      </section>
    </CompliancePageLayout>
  );
}
