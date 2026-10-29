import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play } from "lucide-react";
import type Hls from "hls.js";
import vslThumbnail from "@assets/Barista_Career_in_Three_Months_1793184531131.png";
import { createVslPlaybackTracker } from "@/lib/analytics";

const VSL_PLAYLIST_URL = "/api/vsl/media/index.m3u8";
const MEDIA_ERROR_MESSAGE = "Video load nahi ho saka. Kripya page refresh karke dobara koshish karein.";
const EXPONENTIAL_DECAY = 4;

function getExponentialProgress(currentTime: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const timeRatio = Math.max(0, Math.min(1, currentTime / duration));
  return (
    (1 - Math.exp(-EXPONENTIAL_DECAY * timeRatio)) /
    (1 - Math.exp(-EXPONENTIAL_DECAY))
  );
}

export default function VSLVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFrameRef = useRef<HTMLDivElement>(null);
  const playbackTrackerRef = useRef<ReturnType<typeof createVslPlaybackTracker> | null>(null);
  if (!playbackTrackerRef.current) {
    playbackTrackerRef.current = createVslPlaybackTracker();
  }
  const playbackRequestedRef = useRef(false);
  const codecUnavailableRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [showCounsellingCta, setShowCounsellingCta] = useState(true);
  const [videoError, setVideoError] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) setIsMaximized(true);
      else setIsMaximized(false);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | undefined;
    let cancelled = false;
    playbackRequestedRef.current = false;
    codecUnavailableRef.current = false;
    setVideoError(false);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = VSL_PLAYLIST_URL;
      return () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    void import("hls.js")
      .then(({ default: HlsPlayer }) => {
        if (cancelled) return;
        if (!HlsPlayer.isSupported()) {
          setVideoError(true);
          return;
        }

        hls = new HlsPlayer();
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            if (
              data.details === "bufferAddCodecError" ||
              data.details === "bufferAppendError"
            ) {
              codecUnavailableRef.current = true;
              hls?.destroy();
              return;
            }
            console.error("Fatal HLS playback error", data.type, data.details);
            video.pause();
            setIsPlaying(false);
            setVideoError(true);
          }
        });
        hls.loadSource(VSL_PLAYLIST_URL);
        hls.attachMedia(video);
      })
      .catch(() => {
        if (!cancelled) setVideoError(true);
      });

    return () => {
      cancelled = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, []);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video || videoError) return;

    if (video.paused) {
      playbackRequestedRef.current = true;
      if (codecUnavailableRef.current) {
        setVideoError(true);
        return;
      }
      try {
        await video.play();
      } catch {
        setVideoError(true);
      }
    } else {
      video.pause();
    }
  };

  const toggleMaximized = async () => {
    const frame = videoFrameRef.current;
    if (!frame) return;

    if (isMaximized) {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen().catch(() => setIsMaximized(false));
      } else {
        setIsMaximized(false);
      }
      return;
    }

    setIsMaximized(true);
    if (frame.requestFullscreen) {
      try {
        await frame.requestFullscreen();
      } catch {
        // Keep the CSS full-viewport view on browsers without Fullscreen API support.
      }
    }
  };

  const updateProgress = (video: HTMLVideoElement) => {
    setProgress(getExponentialProgress(video.currentTime, video.duration));
    if (
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      video.currentTime / video.duration >= 0.5
    ) {
      setShowCounsellingCta(true);
    }
  };

  const progressPercent = Math.round(progress * 100);
  const videoFrameClassName = isMaximized
    ? "fixed inset-0 z-50 flex h-[100dvh] w-screen max-w-none items-center justify-center overflow-hidden rounded-none border-0 bg-[#0e0a07] p-4 shadow-none"
    : "relative aspect-video w-full max-w-6xl overflow-hidden rounded-lg border border-amber-400/25 bg-[#1a1109] shadow-2xl shadow-amber-950/20 sm:rounded-xl";

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-5 bg-[#0e0a07] p-4 text-white sm:gap-6 sm:p-6"
      data-testid="page-vsl-video"
    >
      <header className="flex items-center justify-center gap-3">
        <h1 className="max-w-[20rem] text-center font-serif text-lg font-bold leading-snug text-amber-200 sm:max-w-3xl sm:text-2xl">
          <span className="text-amber-400">Aroma Institute</span> of Cafe &amp; Hospitality Management
        </h1>
      </header>
      <div
        ref={videoFrameRef}
        className={videoFrameClassName}
        data-testid="vsl-video-frame"
      >
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-contain"
          poster={vslThumbnail}
          playsInline
          preload="metadata"
          controls={false}
          controlsList="nodownload noplaybackrate noremoteplayback"
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          aria-label="Aroma LEAP free barista training video"
          data-testid="vsl-video"
          onPlay={(event) => {
            setIsPlaying(true);
            playbackTrackerRef.current?.onPlay(event.currentTarget.currentTime);
          }}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={(event) => {
            updateProgress(event.currentTarget);
            playbackTrackerRef.current?.onTimeUpdate(
              event.currentTarget.currentTime,
              event.currentTarget.duration,
              event.currentTarget.seeking,
            );
          }}
          onDurationChange={(event) => updateProgress(event.currentTarget)}
          onEnded={() => {
            setIsPlaying(false);
            setProgress(1);
            playbackTrackerRef.current?.onEnded();
          }}
          onError={(event) => {
            const errorCode = event.currentTarget.error?.code;
            if (!playbackRequestedRef.current && errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
              codecUnavailableRef.current = true;
              return;
            }
            console.error("VSL video element error", errorCode);
            setVideoError(true);
          }}
          onContextMenu={(event) => event.preventDefault()}
        />

        {!isPlaying && !videoError && (
          <button
            type="button"
            onClick={togglePlayback}
            aria-label="Play training video"
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-amber-400 text-[#0e0a07] shadow-xl transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white sm:h-20 sm:w-20"
            data-testid="vsl-play-button"
          >
            <Play className="ml-1 h-8 w-8 sm:h-9 sm:w-9" fill="currentColor" />
          </button>
        )}

        {isPlaying && (
          <button
            type="button"
            onClick={togglePlayback}
            aria-label="Pause training video"
            className="absolute bottom-4 left-4 flex h-11 w-11 items-center justify-center rounded-full bg-black/65 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            data-testid="vsl-pause-button"
          >
            <Pause className="h-5 w-5" fill="currentColor" />
          </button>
        )}

        <button
          type="button"
          onClick={toggleMaximized}
          aria-label={isMaximized ? "Minimize video" : "Maximize video"}
          className="absolute bottom-3 right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/65 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          data-testid="vsl-maximize-button"
        >
          {isMaximized ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
        </button>

        {showCounsellingCta && isMaximized && (
          <a
            href="/counselling"
            className="absolute bottom-14 left-1/2 z-10 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 rounded-xl bg-amber-400 px-4 py-3 text-center text-sm font-bold text-[#0e0a07] shadow-lg transition-colors hover:bg-amber-300 sm:text-base"
            data-testid="video-counselling-cta"
          >
            BOOK A FREE CAREER COUNSELLING SESSION
          </a>
        )}

        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 bg-white/20"
          role="progressbar"
          aria-label="Video progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          data-testid="vsl-progress"
        >
          <div
            className="h-full bg-amber-400"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {videoError && (
          <p
            className="absolute inset-x-4 bottom-8 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-white"
            role="alert"
            data-testid="vsl-media-error"
          >
            {MEDIA_ERROR_MESSAGE}
          </p>
        )}
      </div>
      {showCounsellingCta && !isMaximized && (
        <a
          href="/counselling"
          className="w-full max-w-6xl rounded-xl bg-amber-400 px-5 py-4 text-center text-sm font-bold text-[#0e0a07] shadow-lg transition-colors hover:bg-amber-300 sm:text-base"
          data-testid="video-counselling-cta"
        >
          BOOK A FREE CAREER COUNSELLING SESSION
        </a>
      )}
    </main>
  );
}
