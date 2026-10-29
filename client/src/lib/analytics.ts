type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the app.
  }
}

export function createVslPlaybackTracker() {
  let started = false;
  let completed = false;

  return {
    onPlay() {
      if (started) return;
      started = true;
      trackEvent("vsl_video_started", {
        video: "aroma_training",
        page: "vsl",
      });
    },
    onEnded() {
      if (completed) return;
      completed = true;
      trackEvent("vsl_video_completed", {
        video: "aroma_training",
        page: "vsl",
      });
    },
  };
}
