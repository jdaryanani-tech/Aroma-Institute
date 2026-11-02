import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISMISS_KEY = "aroma-leap-install-dismissed-until";
const DISMISS_DURATION = 30 * 24 * 60 * 60 * 1000;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function isMobileDevice() {
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent) ||
    window.matchMedia("(max-width: 760px)").matches;
}

function isAppleMobileDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function canShowReminder() {
  if (isStandalone()) return false;
  const dismissedUntil = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
  return dismissedUntil <= Date.now();
}

export function PwaInstallPrompt() {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [appleDevice, setAppleDevice] = useState(false);

  useEffect(() => {
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = "/learn/manifest.webmanifest";
    document.head.appendChild(manifest);

    let themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const addedThemeColor = !themeColor;
    if (!themeColor) {
      themeColor = document.createElement("meta");
      themeColor.name = "theme-color";
      document.head.appendChild(themeColor);
    }
    const previousThemeColor = themeColor.content;
    themeColor.content = "#63361f";
    const appleMeta = [
      ["apple-mobile-web-app-capable", "yes"],
      ["apple-mobile-web-app-title", "Aroma LEAP"],
      ["apple-mobile-web-app-status-bar-style", "black-translucent"],
    ].map(([name, content]) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      const added = !meta;
      const previousContent = meta?.content ?? "";
      if (!meta) {
        meta = document.createElement("meta");
        meta.name = name;
        meta.content = content;
        document.head.appendChild(meta);
      }
      return { meta, added, previousContent };
    });
    const appleTouchIcon = document.createElement("link");
    appleTouchIcon.rel = "apple-touch-icon";
    appleTouchIcon.href = "/learn/icons/leap-192.png";
    document.head.appendChild(appleTouchIcon);

    const reminderAllowed = canShowReminder();
    const appleMobile = isAppleMobileDevice();
    setAppleDevice(appleMobile);
    if (reminderAllowed && (isMobileDevice() || appleMobile)) setVisible(true);

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
      if (reminderAllowed) setVisible(true);
    };
    const handleInstalled = () => {
      window.localStorage.setItem(DISMISS_KEY, String(Number.MAX_SAFE_INTEGER));
      setInstallEvent(null);
      setVisible(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker
        .register("/learn/sw.js", { scope: "/learn/" })
        .catch(error => console.error("Aroma LEAP service worker registration failed:", error));
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      manifest.remove();
      appleTouchIcon.remove();
      appleMeta.forEach(({ meta, added, previousContent }) => {
        if (added) meta.remove();
        else meta.content = previousContent;
      });
      if (addedThemeColor) themeColor?.remove();
      else if (themeColor) themeColor.content = previousThemeColor;
    };
  }, []);

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DURATION));
    setVisible(false);
  };

  const startInstall = async () => {
    if (!installEvent) {
      if (showInstructions) {
        setShowInstructions(false);
        return;
      }
      setShowInstructions(true);
      return;
    }

    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      setInstallEvent(null);
      if (choice.outcome === "accepted") setVisible(false);
    } catch (error) {
      console.error("Aroma LEAP install prompt failed:", error);
      setShowInstructions(true);
    }
  };

  if (!visible) return null;

  return (
    <aside className="lms-pwa-prompt" aria-label="Install Aroma LEAP">
      <div className="lms-pwa-icon" aria-hidden="true"><Download size={19} /></div>
      <div className="lms-pwa-copy">
        <strong>Add Aroma LEAP to your home screen</strong>
        {showInstructions ? (
          <p>
            {appleDevice
              ? "Tap Share in your browser, then choose Add to Home Screen."
              : "Open your browser menu and choose Install app or Add to Home screen."}
          </p>
        ) : (
          <p>Open your learning portal quickly from your device.</p>
        )}
      </div>
      <div className="lms-pwa-actions">
        <button className="lms-button lms-button-sm" type="button" onClick={startInstall}>
          {installEvent ? "Install" : showInstructions ? "Got it" : "Add"}
        </button>
        <button
          className="lms-pwa-dismiss"
          type="button"
          aria-label="Not now"
          onClick={dismiss}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
