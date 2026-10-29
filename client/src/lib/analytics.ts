type AnalyticsData = Record<string, string | number | boolean>;
type VslDeviceCategory = "mobile" | "desktop";

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

function getVslDeviceCategory(): VslDeviceCategory {
  return window.innerWidth < 768 ? "mobile" : "desktop";
}

export function createVslPlaybackTracker() {
  const deviceCategory = getVslDeviceCategory();
  let started = false;
  let completed = false;
  let lastObservedTime = 0;
  const reportedMilestones = new Set<number>();
  const milestones = [25, 50, 75, 90];

  return {
    onPlay(currentTime = lastObservedTime) {
      if (!started) {
        started = true;
        trackEvent("vsl_video_started", {
          video: "aroma_training",
          page: "vsl",
          device_category: deviceCategory,
        });
      }
      if (Number.isFinite(currentTime) && currentTime >= 0) {
        lastObservedTime = currentTime;
      }
    },
    onTimeUpdate(currentTime: number, duration: number, isSeeking: boolean) {
      if (
        !Number.isFinite(currentTime) ||
        currentTime < 0 ||
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        return;
      }

      if (isSeeking || currentTime < lastObservedTime) {
        lastObservedTime = currentTime;
        return;
      }

      for (const percent of milestones) {
        const thresholdTime = (duration * percent) / 100;
        if (
          lastObservedTime < thresholdTime &&
          currentTime >= thresholdTime &&
          !reportedMilestones.has(percent)
        ) {
          reportedMilestones.add(percent);
          trackEvent("vsl_video_progress", {
            video: "aroma_training",
            page: "vsl",
            progress_percent: percent,
            device_category: deviceCategory,
          });
        }
      }

      lastObservedTime = currentTime;
    },
    onSeeked(currentTime: number) {
      if (Number.isFinite(currentTime) && currentTime >= 0) {
        lastObservedTime = currentTime;
      }
    },
    onEnded() {
      if (completed) return;
      completed = true;
      trackEvent("vsl_video_completed", {
        video: "aroma_training",
        page: "vsl",
        device_category: deviceCategory,
      });
    },
  };
}
