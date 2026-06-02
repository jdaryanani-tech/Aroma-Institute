import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Inquiry } from "@shared/schema";
import { LogOut, Download, Users, Mail, Phone, BookOpen, MessageSquare, Lock } from "lucide-react";

async function fetchInquiries(password: string): Promise<Inquiry[]> {
  const res = await fetch("/api/admin/inquiries", {
    headers: { "x-admin-password": password },
  });
  if (!res.ok) throw new Error("Unauthorized");
  return res.json();
}

function exportCSV(data: Inquiry[]) {
  const headers = ["ID", "Name", "Email", "Phone", "Program Interest", "Message"];
  const rows = data.map((r) => [
    r.id,
    r.name,
    r.email,
    r.phone,
    r.programInterest,
    r.message ?? "",
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aroma-leads-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const SESSION_KEY = "aroma_admin_session";

export default function Admin() {
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(() => sessionStorage.getItem(SESSION_KEY) ?? "");
  const [inputError, setInputError] = useState("");

  const { data, isLoading, isError } = useQuery<Inquiry[]>({
    queryKey: ["/api/admin/inquiries", submitted],
    queryFn: () => fetchInquiries(submitted),
    enabled: !!submitted,
    retry: false,
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setInputError("Please enter a password.");
      return;
    }
    setInputError("");
    sessionStorage.setItem(SESSION_KEY, password);
    setSubmitted(password);
  };

  const handleLogout = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setSubmitted("");
    setPassword("");
  };

  const isUnauthorized = isError && submitted;

  if (!submitted || isUnauthorized) {
    return (
      <div className="min-h-screen bg-[#0e0a07] flex items-center justify-center px-4" data-testid="page-admin-login">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center mx-auto mb-4">
              <Lock className="h-6 w-6 text-amber-400" />
            </div>
            <h1 className="text-white font-serif text-2xl font-bold">Admin Access</h1>
            <p className="text-white/45 text-sm mt-1">Aroma Institute — Leads Dashboard</p>
          </div>

          <form onSubmit={handleLogin} className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
            {isUnauthorized && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm text-center">
                Incorrect password. Please try again.
              </div>
            )}
            <div>
              <label className="text-white/60 text-xs font-medium uppercase tracking-wider block mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter admin password"
                className="w-full h-11 px-4 rounded-lg border border-white/20 bg-white/8 text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60 text-sm"
                data-testid="admin-input-password"
                autoFocus
              />
              {inputError && <p className="text-red-400 text-xs mt-1">{inputError}</p>}
            </div>
            <button
              type="submit"
              className="w-full h-11 bg-amber-400 hover:bg-amber-300 text-[#0e0a07] font-bold rounded-lg transition-colors text-sm"
              data-testid="admin-button-login"
            >
              View Leads
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white" data-testid="page-admin-dashboard">
      {/* Top bar */}
      <div className="border-b border-white/10 bg-[#0e0a07]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-serif font-bold text-lg text-white leading-none">Leads Dashboard</h1>
            <p className="text-white/40 text-xs mt-0.5">Aroma Institute of Cafe & Hospitality Management</p>
          </div>
          <div className="flex items-center gap-3">
            {data && data.length > 0 && (
              <button
                onClick={() => exportCSV(data)}
                className="flex items-center gap-2 bg-white/8 hover:bg-white/12 border border-white/15 text-white/80 text-sm px-4 py-2 rounded-lg transition-colors"
                data-testid="admin-button-export"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </button>
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-white/50 hover:text-white/80 text-sm px-3 py-2 rounded-lg transition-colors"
              data-testid="admin-button-logout"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Stats */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
            {[
              { icon: Users, label: "Total Leads", value: data.length },
              {
                icon: BookOpen,
                label: "Programs",
                value: new Set(data.map((d) => d.programInterest)).size,
              },
              {
                icon: MessageSquare,
                label: "With Message",
                value: data.filter((d) => d.message).length,
              },
              {
                icon: Mail,
                label: "Latest Lead",
                value: data[0]?.name?.split(" ")[0] ?? "—",
              },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-4" data-testid={`stat-${label.toLowerCase().replace(/ /g, "-")}`}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="h-4 w-4 text-amber-400" />
                  <span className="text-white/50 text-xs uppercase tracking-wide">{label}</span>
                </div>
                <p className="text-white font-bold text-xl">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="text-center py-20 text-white/40">Loading leads...</div>
        ) : data && data.length === 0 ? (
          <div className="text-center py-20 text-white/40">No leads yet.</div>
        ) : data ? (
          <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="admin-leads-table">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">#</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Name</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Email</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Phone</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Program</th>
                    <th className="text-left px-5 py-3.5 text-white/50 font-medium text-xs uppercase tracking-wide">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((lead, i) => (
                    <tr
                      key={lead.id}
                      className={`border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors`}
                      data-testid={`lead-row-${lead.id}`}
                    >
                      <td className="px-5 py-4 text-white/30 text-xs">{lead.id}</td>
                      <td className="px-5 py-4 font-medium text-white">{lead.name}</td>
                      <td className="px-5 py-4">
                        <a href={`mailto:${lead.email}`} className="text-amber-400/80 hover:text-amber-400 transition-colors flex items-center gap-1.5">
                          <Mail className="h-3 w-3 shrink-0" />
                          {lead.email}
                        </a>
                      </td>
                      <td className="px-5 py-4">
                        <a href={`tel:${lead.phone}`} className="text-white/70 hover:text-white transition-colors flex items-center gap-1.5">
                          <Phone className="h-3 w-3 shrink-0" />
                          {lead.phone}
                        </a>
                      </td>
                      <td className="px-5 py-4">
                        <span className="inline-block bg-amber-400/10 border border-amber-400/20 text-amber-400 text-xs px-2.5 py-1 rounded-full whitespace-nowrap">
                          {lead.programInterest}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-white/50 max-w-xs truncate">
                        {lead.message || <span className="text-white/20 italic">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
