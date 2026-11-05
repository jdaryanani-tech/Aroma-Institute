import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { useLmsSession } from "@/hooks/use-lms";

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const DISMISS_KEY = "aroma-admin-install-dismissed";
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
const isApple = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export default function AdminInstallHelp() {
  const { data: session } = useLmsSession();
  const [visible, setVisible] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [prompt, setPrompt] = useState<PromptEvent | null>(null);
  const apple = isApple();
  const canUseAdminPwa = Boolean(session?.roles.some(role =>
    ["admin", "admissions", "academic_coordinator", "operations"].includes(role),
  ));

  useEffect(() => {
    if (!canUseAdminPwa) return;
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = "/admin.webmanifest";
    manifest.dataset.adminPwa = "true";
    document.head.appendChild(manifest);
    const icon = document.createElement("link");
    icon.rel = "apple-touch-icon";
    icon.href = "/admin-icon-192.png";
    icon.dataset.adminPwa = "true";
    document.head.appendChild(icon);
    const values: Array<[string, string]> = [
      ["theme-color", "#23594d"],
      ["apple-mobile-web-app-capable", "yes"],
      ["apple-mobile-web-app-title", "AICHM Admissions"],
      ["apple-mobile-web-app-status-bar-style", "default"],
    ];
    const previous = values.map(([name, content]) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      const added = !meta;
      const old = meta?.content ?? "";
      if (!meta) {
        meta = document.createElement("meta");
        meta.name = name;
        document.head.appendChild(meta);
      }
      meta.content = content;
      meta.dataset.adminPwa = "true";
      return { meta, added, old };
    });
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/admin-sw.js", { scope: "/admin" })
        .catch((error) => console.warn("Admin service worker registration failed", error));
    }
    const installed = () => setVisible(false);
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setPrompt(event as PromptEvent);
      if (!isStandalone() && !window.localStorage.getItem(DISMISS_KEY)) setVisible(true);
    };
    window.addEventListener("appinstalled", installed);
    window.addEventListener("beforeinstallprompt", beforeInstall);
    if (!isStandalone() && !window.localStorage.getItem(DISMISS_KEY) &&
      (apple || window.matchMedia("(max-width: 760px)").matches)) setVisible(true);
    return () => {
      window.removeEventListener("appinstalled", installed);
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      manifest.remove();
      icon.remove();
      previous.forEach(({ meta, added, old }) => {
        if (added) meta.remove();
        else { meta.content = old; delete meta.dataset.adminPwa; }
      });
    };
  }, [canUseAdminPwa]);

  if (!canUseAdminPwa) return null;

  if (!visible || isStandalone()) return null;
  const install = async () => {
    if (!prompt) { setInstructions((value) => !value); return; }
    await prompt.prompt();
    const result = await prompt.userChoice;
    setPrompt(null);
    if (result.outcome === "accepted") setVisible(false);
  };
  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, "yes");
    setVisible(false);
  };
  return (
    <aside className="crm-install" aria-label="Install admissions CRM">
      <span className="crm-install-mark" aria-hidden="true"><Download size={18} /></span>
      <div className="crm-install-copy">
        <strong>Add AICHM Admissions to your Home Screen</strong>
        <p>{instructions
          ? apple
            ? "In Safari, tap Share, then Add to Home Screen. Confirm with Add."
            : "Open your browser menu and choose Add to Home Screen or Install."
          : "Keep your admissions desk one tap away on this iPhone."}</p>
      </div>
      <button className="crm-install-action" onClick={install} type="button">
        {prompt ? "Install" : instructions ? "Got it" : "How"}
      </button>
      <button aria-label="Dismiss install help" className="crm-icon-button" onClick={dismiss} type="button"><X size={18} /></button>
    </aside>
  );
}
