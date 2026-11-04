import { FormEvent, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { getAdminLoginDestination } from "@shared/lms-auth-routing";
import { useLmsAuthStatus, useLmsPasswordLogin, useLmsSession } from "@/hooks/use-lms";

export default function AdminLogin() {
  const session = useLmsSession();
  const authStatus = useLmsAuthStatus();
  const login = useLmsPasswordLogin();
  const [, setLocation] = useLocation();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  const adminDestination = session.data
    ? getAdminLoginDestination(session.data.roles)
    : null;
  const isAdmin = Boolean(adminDestination);

  useEffect(() => {
    if (adminDestination) setLocation(adminDestination);
  }, [adminDestination, setLocation]);

  const signIn = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    login.mutate({ phone: phone.trim(), password }, {
      onSuccess: (user) => {
        const destination = getAdminLoginDestination(user.roles);
        if (destination) {
          setLocation(destination);
        } else {
          setFormError("Access denied. This account does not have Leads Dashboard administrator access.");
        }
      },
      onError: (error) => {
        setFormError(error instanceof Error ? error.message : "Phone number or password is incorrect.");
      },
    });
  };

  if (session.isLoading || isAdmin) {
    return (
      <main className="min-h-screen bg-[#0e0a07] flex items-center justify-center px-4 text-white">
        <p className="text-white/60">{isAdmin ? "Opening the Leads Dashboard…" : "Checking administrator access…"}</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0e0a07] flex items-center justify-center px-4 py-10 text-white">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-[#17120e] p-7 shadow-2xl sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">Aroma Institute</p>
        <h1 className="mt-3 font-serif text-3xl font-bold">Leads Dashboard sign in</h1>
        <p className="mt-2 text-sm leading-6 text-white/60">
          Use your Aroma Institute administrator phone number and password.
        </p>

        {session.data && !isAdmin && (
          <div className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100" role="alert">
            Access denied. This signed-in account does not have Leads Dashboard administrator access.
            Sign in below with an administrator account.
          </div>
        )}
        {session.isError && (
          <div className="mt-5 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100" role="alert">
            We could not check your current session. You can still try signing in.
          </div>
        )}
        {!authStatus.isLoading && authStatus.isError && (
          <div className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100" role="alert">
            Sign-in availability could not be checked. Please try again shortly.
          </div>
        )}
        {!authStatus.isLoading && !authStatus.isError && !authStatus.data?.available && (
          <div className="mt-5 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100" role="status">
            {authStatus.data?.message || "Password sign-in is currently unavailable. Contact your institute coordinator."}
          </div>
        )}
        {formError && (
          <div className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100" role="alert">
            {formError}
          </div>
        )}

        <form className="mt-6 space-y-4" onSubmit={signIn}>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/80" htmlFor="admin-login-phone">Phone number</label>
            <input
              id="admin-login-phone"
              className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2.5 text-white outline-none focus:border-amber-300"
              type="tel"
              autoComplete="tel"
              placeholder="+91 98765 43210"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/80" htmlFor="admin-login-password">Password</label>
            <input
              id="admin-login-password"
              className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2.5 text-white outline-none focus:border-amber-300"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <button
            className="w-full rounded-lg bg-amber-400 px-4 py-3 font-bold text-[#21140a] transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            type="submit"
            disabled={!phone.trim() || !password || login.isPending || !authStatus.data?.available}
          >
            {login.isPending ? "Signing in…" : "Sign in to Leads Dashboard"}
          </button>
        </form>

        <p className="mt-5 text-xs leading-5 text-white/45">
          Need a password setup or reset link? Contact your institute coordinator.
        </p>
        <a className="mt-5 inline-block text-sm font-medium text-amber-300 hover:text-amber-200" href="/learn">
          Go to the LEAP portal
        </a>
      </section>
    </main>
  );
}
