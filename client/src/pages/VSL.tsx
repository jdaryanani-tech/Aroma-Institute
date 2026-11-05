import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import {
  VSL_WHATSAPP_CONSENT_TEXT,
  VSL_WHATSAPP_CONSENT_VERSION,
} from "@shared/vsl-consent";

export default function VSL() {
  const [, setLocation] = useLocation();
  const [isGateOpen, setIsGateOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsappAdmissionsConsent, setWhatsappAdmissionsConsent] = useState(false);
  const [whatsappConsentAvailable, setWhatsappConsentAvailable] = useState(false);
  const [consentVersion, setConsentVersion] = useState(VSL_WHATSAPP_CONSENT_VERSION);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState("");

  useEffect(() => {
    let isCurrent = true;
    fetch("/api/vsl/registration-options", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) throw new Error("Registration options unavailable");
        return response.json();
      })
      .then((options: { whatsappConsentAvailable?: boolean; consentVersion?: string }) => {
        if (!isCurrent) return;
        if (typeof options.consentVersion === "string" && options.consentVersion.length > 0) {
          setConsentVersion(options.consentVersion);
        }
        setWhatsappConsentAvailable(options.whatsappConsentAvailable === true);
      })
      .catch(() => {
        if (isCurrent) setWhatsappConsentAvailable(false);
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (!isGateOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) setIsGateOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isGateOpen, isSubmitting]);

  const submitLead = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmissionError("");

    if (name.trim().length < 2) {
      setSubmissionError("Apna poora naam darj karein.");
      return;
    }
    if (!normalizeIndianMobile(phone)) {
      setSubmissionError("Sahi phone number darj karein.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest("POST", "/api/vsl/registrations", {
        name: name.trim(),
        phone: phone.trim(),
        entryPath: window.location.pathname === "/" ? "/" : "/vsl",
        whatsappAdmissionsConsent: whatsappConsentAvailable && whatsappAdmissionsConsent,
        consentVersion,
      });
      setLocation("/vsl-video");
    } catch {
      setSubmissionError("Details submit nahi ho paaye. Kripya dobara koshish karein.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0e0a07] text-white" data-testid="page-vsl">
      <section
        className="flex min-h-screen items-center justify-center px-5 py-12"
        data-testid="section-vsl-hero"
      >
        <div className="mx-auto w-full max-w-4xl text-center">
          <p className="mb-3 text-sm font-bold uppercase tracking-[0.16em] text-amber-400">
            AROMA LEAP
          </p>
          <p className="mx-auto mb-7 max-w-2xl text-sm text-white/60 sm:text-base">
            Ahmedabad aur Gujarat ke aspiring Baristas ke liye
          </p>
          <h1 className="font-serif text-3xl font-bold leading-tight sm:text-4xl lg:text-5xl">
            3 Mahine Mein Apna{" "}
            <span className="text-amber-400 italic">Professional Barista Career</span>{" "}
            Shuru Karo
          </h1>
          <p className="mt-5 text-base font-semibold text-amber-200 sm:text-lg">
            Bina Pehle Se Coffee Knowledge Ya Café Experience Ke
          </p>
          <p className="mx-auto mt-5 max-w-3xl text-base leading-relaxed text-white/70 sm:text-lg">
            Professional Barista Skills Seekho. Real Café Experience Lo. Apne Career Ke Liye Prepare Karo.
          </p>
          <p className="mt-7 text-sm font-semibold leading-relaxed text-white/85 sm:text-base">
            Neeche Click Karo Aur Apna FREE Career Counselling Session Book Karo.
          </p>
          <button
            type="button"
            onClick={() => {
              setSubmissionError("");
              setIsGateOpen(true);
            }}
            className="mt-5 inline-flex min-h-14 w-full max-w-3xl items-center justify-center rounded-xl bg-amber-400 px-8 py-4 text-base font-bold text-[#0e0a07] shadow-lg shadow-amber-400/20 transition-colors hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200 sm:text-lg"
            data-testid="button-cta-hero"
          >
            GET STARTED
          </button>
          <p className="mt-5 text-xs tracking-wide text-white/45">
            LEARN. EARN. ADVANCE. PAY.
          </p>
        </div>
      </section>
      {isGateOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm"
          onClick={() => !isSubmitting && setIsGateOpen(false)}
          data-testid="modal-video-gate"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="lead-form-title"
            className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-[#1a1109] p-6 shadow-2xl sm:p-8"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsGateOpen(false)}
              disabled={isSubmitting}
              aria-label="Close form"
              className="absolute right-4 top-4 rounded p-1 text-white/55 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50"
              data-testid="modal-close"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="mb-6 pr-7">
              <h2 id="lead-form-title" className="text-xl font-bold leading-snug text-center">FREE Training Dekhne K Liye Apni Details Bhariye</h2>
              <p className="mt-3 text-sm leading-relaxed text-white/75 text-center">
                Janiye 3 Mahine Mein Apna Professional Barista Career Kaise Shuru Karein
              </p>
              <p className="mt-2 text-sm text-white/60 text-center">
                Bina Kisi Coffee Knowledge Ya Café Experience Ke.
              </p>
            </div>
            <form onSubmit={submitLead} className="space-y-4">
              <div>
                <label htmlFor="lead-name" className="mb-1.5 block text-sm font-medium text-white/85 text-left">
                  Name
                </label>
                <input
                  id="lead-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  required
                  minLength={2}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 w-full rounded-lg border border-white/20 bg-white/[0.08] px-4 text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                  placeholder="Aapka poora naam"
                  data-testid="gate-input-name"
                />
              </div>
              <div>
                <label htmlFor="lead-phone" className="mb-1.5 block text-sm font-medium text-white/85">
                  Phone number
                </label>
                <input
                  id="lead-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                  required
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  className="h-12 w-full rounded-lg border border-white/20 bg-white/[0.08] px-4 text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                  placeholder="+91 98765 43210"
                  data-testid="gate-input-phone"
                />
              </div>
              <div>
                <label
                  htmlFor="lead-whatsapp-consent"
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg py-2 text-left text-sm leading-relaxed text-white/80"
                >
                  <input
                    id="lead-whatsapp-consent"
                    name="whatsappAdmissionsConsent"
                    type="checkbox"
                    disabled={!whatsappConsentAvailable}
                    checked={whatsappAdmissionsConsent}
                    onChange={(event) => setWhatsappAdmissionsConsent(event.target.checked)}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:opacity-45"
                    data-testid="gate-checkbox-whatsapp-consent"
                  />
                  <span>{VSL_WHATSAPP_CONSENT_TEXT}</span>
                </label>
                <p className="ml-8 text-xs leading-relaxed text-white/55">
                  {whatsappConsentAvailable
                    ? "Optional. You can watch the free training whether or not you select this."
                    : "Optional. Consent saving is not enabled yet; you can still watch the free training."}
                </p>
              </div>
              {submissionError && (
                <p className="text-sm text-red-300" role="alert" data-testid="gate-error">
                  {submissionError}
                </p>
              )}
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex h-12 w-full items-center justify-center rounded-lg bg-amber-400 px-4 font-bold text-[#0e0a07] transition-colors hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
                data-testid="gate-button-submit"
              >
                {isSubmitting ? "Submitting..." : "WATCH NOW FOR FREE!"}
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
