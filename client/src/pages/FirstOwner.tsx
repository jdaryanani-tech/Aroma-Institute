import { FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "wouter";

type Availability = {
  available: boolean;
};

type SetupResult = {
  setupUrl: string;
  expiresAt: string;
};

async function readSafeMessage(response: Response, fallback: string) {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }
  } catch {
    // Return only a generic message if the response isn't valid JSON.
  }
  return fallback;
}

export default function FirstOwner() {
  const [availability, setAvailability] = useState<"checking" | "available" | "unavailable">("checking");
  const [phone, setPhone] = useState("");
  const [secret, setSecret] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SetupResult | null>(null);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/first-owner/status", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          setAvailability("unavailable");
          return;
        }
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          "available" in body &&
          body.available === true
        ) {
          setAvailability("available");
        } else {
          setAvailability("unavailable");
        }
      } catch {
        if (!controller.signal.aborted) setAvailability("unavailable");
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    setPhone("");
    setSecret("");
  }, []);

  const submitSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || availability !== "available" || result) return;
    setError("");
    setCopied(false);
    inFlight.current = true;
    setSubmitting(true);
    const submittedPhone = phone.trim();
    const submittedSecret = secret;
    setPhone("");
    setSecret("");

    try {
      const response = await fetch("/api/admin/first-owner", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: submittedPhone,
          secret: submittedSecret,
          confirmOwner: true,
        }),
      });
      if (response.status === 201) {
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          "setupUrl" in body &&
          typeof body.setupUrl === "string" &&
          "expiresAt" in body &&
          typeof body.expiresAt === "string"
        ) {
          setResult({
            setupUrl: body.setupUrl,
            expiresAt: body.expiresAt,
          });
        } else {
          setError("Setup could not be completed. Please try again later.");
        }
      } else {
        const defaults: Record<number, string> = {
          400: "The details could not be accepted. Check them and try again.",
          403: "This setup request was not authorized.",
          409: "Owner setup is no longer available.",
          429: "Too many attempts. Please wait before trying again.",
          503: "Owner setup is temporarily unavailable. Please try again later.",
        };
        setError(await readSafeMessage(response, defaults[response.status] ?? "Setup could not be completed. Please try again later."));
        if (response.status === 404 || response.status === 409) setAvailability("unavailable");
      }
    } catch {
      setError("We could not complete the setup request. Please try again later.");
    } finally {
      setPhone("");
      setSecret("");
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const copySetupUrl = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.setupUrl);
      setCopied(true);
    } catch {
      setError("Copy is unavailable in this browser. Select and copy the private link instead.");
    }
  };

  const clearResult = () => {
    setResult(null);
    setCopied(false);
    setAvailability("unavailable");
  };

  const disabled = availability !== "available" || submitting || Boolean(result);

  return (
    <main className="min-h-[100dvh] bg-[#100e0a] px-4 py-8 text-[#f4eee2] sm:flex sm:items-center sm:justify-center sm:py-12">
      <section className="mx-auto w-full max-w-xl overflow-hidden rounded-[1.75rem] border border-[#d9b66d]/20 bg-[#191610] shadow-[0_28px_90px_rgba(0,0,0,0.4)]">
        <div className="border-b border-[#d9b66d]/15 bg-[radial-gradient(ellipse_at_top_right,rgba(217,182,109,0.12),transparent_58%)] px-6 pb-7 pt-7 sm:px-9 sm:pt-9">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#e4c47f]">Aroma Institute · Admissions CRM</p>
          <h1 className="mt-4 font-serif text-3xl font-bold leading-tight sm:text-4xl">First owner setup</h1>
          <p className="mt-3 max-w-prose text-sm leading-6 text-[#c0b8a8]">
            A private, one-time step for the institute founder. The approved owner account is the only account this setup can create.
          </p>
        </div>

        <div className="px-6 py-6 sm:px-9 sm:py-8">
          {availability === "checking" && (
            <div className="space-y-4" role="status" aria-live="polite" aria-label="Checking owner setup availability">
              <div className="h-4 w-40 animate-pulse rounded bg-[#393327]" />
              <div className="h-12 animate-pulse rounded-lg bg-[#28241b]" />
              <div className="h-12 animate-pulse rounded-lg bg-[#28241b]" />
              <p className="text-sm text-[#aaa18f]">Checking whether secure owner setup is available…</p>
            </div>
          )}

          {availability === "unavailable" && (
            <div className="rounded-xl border border-[#d9b66d]/20 bg-[#242016] p-5" role="status">
              <p className="text-sm font-semibold text-[#eed08e]">Owner setup is unavailable</p>
              <p className="mt-2 text-sm leading-6 text-[#c0b8a8]">
                This private setup is only enabled during the approved production bootstrap window. It is not available in this environment.
              </p>
              <Link className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-[#d9b66d]/40 px-4 text-sm font-semibold text-[#eed08e] transition hover:bg-[#d9b66d]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4c47f]" href="/admin/login">
                Go to administrator sign in
              </Link>
            </div>
          )}

          {availability === "available" && !result && (
            <>
              <div className="mb-6 flex gap-3 rounded-xl border border-[#d9b66d]/20 bg-[#242016] p-4">
                <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#d9b66d]/45 text-xs text-[#e4c47f]">i</span>
                <p className="text-sm leading-6 text-[#c0b8a8]">
                  Enter the approved phone in international E.164 format. The bootstrap secret is temporary and must never be shared.
                </p>
              </div>

              {error && (
                <div className="mb-5 rounded-lg border border-[#cc7969]/35 bg-[#8f4033]/15 p-3.5 text-sm leading-6 text-[#f1c2b8]" role="alert">
                  {error}
                </div>
              )}

              <form className="space-y-5" onSubmit={submitSetup} autoComplete="off">
                <div>
                  <label className="mb-2 block text-sm font-medium text-[#e9e1d2]" htmlFor="first-owner-phone">Approved owner phone</label>
                  <input
                    id="first-owner-phone"
                    className="min-h-12 w-full rounded-lg border border-[#62583f] bg-[#100e0a] px-3.5 text-base text-[#f4eee2] outline-none transition placeholder:text-[#777060] focus:border-[#e4c47f] focus:ring-2 focus:ring-[#d9b66d]/20 disabled:opacity-60"
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder="+91…"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    required
                    disabled={disabled}
                  />
                  <p className="mt-1.5 text-xs leading-5 text-[#968e7e]">Type the full approved number yourself. It is not saved.</p>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-[#e9e1d2]" htmlFor="first-owner-secret">Bootstrap secret</label>
                  <input
                    id="first-owner-secret"
                    className="min-h-12 w-full rounded-lg border border-[#62583f] bg-[#100e0a] px-3.5 text-base text-[#f4eee2] outline-none transition focus:border-[#e4c47f] focus:ring-2 focus:ring-[#d9b66d]/20 disabled:opacity-60"
                    type="password"
                    autoComplete="off"
                    data-lpignore="true"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    required
                    disabled={disabled}
                  />
                </div>

                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#62583f]/70 p-3.5 text-sm leading-6 text-[#c0b8a8] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[#e4c47f]">
                  <input
                    className="mt-1 h-4 w-4 shrink-0 accent-[#d9b66d]"
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    disabled={disabled}
                  />
                  <span>I confirm I am the institute founder and approve setup for the configured owner account only.</span>
                </label>

                <button
                  className="min-h-12 w-full rounded-lg bg-[#d9b66d] px-4 py-3 font-bold text-[#211b10] transition hover:bg-[#e8ca88] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4c47f] disabled:cursor-not-allowed disabled:opacity-45"
                  type="submit"
                  disabled={!phone.trim() || !secret || !confirmed || submitting}
                >
                  {submitting ? "Preparing private setup…" : "Create one-time owner link"}
                </button>
              </form>
            </>
          )}

          {result && (
            <div>
              <div className="rounded-xl border border-[#8eaa80]/35 bg-[#263023] p-4" role="status">
                <p className="font-semibold text-[#c4d5b6]">Owner setup link is ready</p>
                <p className="mt-1.5 text-sm leading-6 text-[#c0c9b8]">
                  This link is shown only once and expires in 24 hours. Share it privately with the configured owner. Remove <code className="rounded bg-black/20 px-1.5 py-0.5 text-xs">ADMIN_BOOTSTRAP_SECRET</code> after successful setup.
                </p>
              </div>
              <label className="mb-2 mt-5 block text-sm font-medium text-[#e9e1d2]" htmlFor="owner-setup-url">Private setup link</label>
              <textarea
                id="owner-setup-url"
                className="min-h-28 w-full resize-y rounded-lg border border-[#62583f] bg-[#100e0a] p-3 font-mono text-sm leading-6 text-[#f4eee2] outline-none focus:border-[#e4c47f] focus:ring-2 focus:ring-[#d9b66d]/20"
                value={result.setupUrl}
                readOnly
                spellCheck={false}
                aria-describedby="owner-link-expiry"
              />
              <p id="owner-link-expiry" className="mt-2 text-xs leading-5 text-[#aaa18f]">
                Expires: <time dateTime={result.expiresAt}>{result.expiresAt}</time>
              </p>
              {error && <p className="mt-3 text-sm leading-6 text-[#f1c2b8]" role="alert">{error}</p>}
              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <button
                  className="min-h-11 flex-1 rounded-lg bg-[#d9b66d] px-4 py-2.5 font-bold text-[#211b10] transition hover:bg-[#e8ca88] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4c47f]"
                  type="button"
                  onClick={copySetupUrl}
                >
                  {copied ? "Copied to clipboard" : "Copy private link"}
                </button>
                <button
                  className="min-h-11 rounded-lg border border-[#62583f] px-4 py-2.5 text-sm font-semibold text-[#d4cbb8] transition hover:bg-[#28241b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4c47f]"
                  type="button"
                  onClick={clearResult}
                >
                  Hide link and clear output
                </button>
              </div>
              <p className="mt-4 text-xs leading-5 text-[#968e7e]">Once hidden, this screen cannot show the link again.</p>
            </div>
          )}

          <div className="mt-7 border-t border-[#d9b66d]/15 pt-5">
            <Link className="text-sm font-medium text-[#e4c47f] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#e4c47f]" href="/admin/login">
              Return to administrator sign in
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
