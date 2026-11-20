"use client";

import { useEffect, useRef, useState } from "react";

export type ScopeBotMood = "idle" | "thinking";

/**
 * Transparent-video ScopeBot.
 *
 * The clips were keyed offline (scripts/scopebot) into two alpha formats:
 *  - HEVC with alpha (.mov): Safari on macOS and every iOS browser (WebKit),
 *    which cannot play VP9 alpha.
 *  - VP9 with alpha (.webm): Chrome, Edge, Firefox, Android.
 * Picking one in JS (rather than <source> order) avoids Chrome on macOS
 * choosing the HEVC file, which it decodes without alpha.
 *
 * Both moods stay mounted and crossfade, so switching never flashes a reload;
 * only the visible clip plays. Reduced-motion users get the still image.
 */
function pickFormat(): "mov" | "webm" {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(ua);
  if (iOS || safari) return "mov";
  return document.createElement("video").canPlayType('video/webm; codecs="vp9"') ? "webm" : "mov";
}

const MOODS: ScopeBotMood[] = ["idle", "thinking"];

export function ScopeBot({
  mood,
  size = 160,
  className = "",
}: {
  mood: ScopeBotMood;
  size?: number;
  className?: string;
}) {
  const [format, setFormat] = useState<"mov" | "webm" | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [ready, setReady] = useState<Record<ScopeBotMood, boolean>>({ idle: false, thinking: false });
  const refs = useRef<Record<ScopeBotMood, HTMLVideoElement | null>>({ idle: null, thinking: null });

  useEffect(() => {
    setFormat(pickFormat());
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Play only the visible clip; restart "thinking" from the top each time.
  useEffect(() => {
    for (const m of MOODS) {
      const v = refs.current[m];
      if (!v) continue;
      if (m === mood) {
        if (m === "thinking") v.currentTime = 0;
        void v.play().catch(() => undefined); // autoplay can be refused; the poster stays visible
      } else {
        v.pause();
      }
    }
  }, [mood, format]);

  const showVideo = format !== null && !reducedMotion;

  return (
    <div
      className={`pointer-events-none relative select-none ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* Still frame: shown until the active clip has data, and for reduced motion. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/scopebot/scopebot.webp"
        alt=""
        width={size}
        height={size}
        className={`absolute inset-0 h-full w-full transition-opacity duration-300 ${
          showVideo && ready[mood] ? "opacity-0" : "opacity-100"
        }`}
      />
      {showVideo &&
        MOODS.map((m) => (
          <video
            key={`${m}-${format}`}
            ref={(el) => {
              refs.current[m] = el;
            }}
            src={`/scopebot/scopebot-${m}.${format}`}
            muted
            loop
            playsInline
            autoPlay={m === mood}
            preload="auto"
            disablePictureInPicture
            disableRemotePlayback
            onLoadedData={() => setReady((r) => ({ ...r, [m]: true }))}
            className={`absolute inset-0 h-full w-full transition-opacity duration-300 ${
              m === mood && ready[m] ? "opacity-100" : "opacity-0"
            }`}
          />
        ))}
    </div>
  );
}

/** Typewriter speech bubble. `tail` points toward ScopeBot. */
export function SpeechBubble({
  text,
  tail = "right",
  className = "",
  animate = true,
}: {
  text: string;
  tail?: "right" | "bottom" | "none";
  className?: string;
  animate?: boolean;
}) {
  const [shown, setShown] = useState(animate ? "" : text);

  useEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(text);
      return;
    }
    setShown("");
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, 22);
    return () => window.clearInterval(id);
  }, [text, animate]);

  return (
    <div
      className={`relative rounded-3xl bg-white px-5 py-3 font-[family-name:var(--font-typewriter)] text-[15px] leading-snug text-gray-900 shadow-xl ${className}`}
      role="status"
      aria-live="polite"
    >
      {/* Full text reserves the final size so the bubble doesn't grow while typing. */}
      <span className="invisible">&ldquo;{text}&rdquo;</span>
      <span className="absolute inset-0 px-5 py-3">&ldquo;{shown}&rdquo;</span>
      {tail === "right" && (
        <span className="absolute top-1/2 -right-2 h-4 w-4 -translate-y-1/2 rotate-45 bg-white" />
      )}
      {tail === "bottom" && (
        <span className="absolute -bottom-2 left-1/2 h-4 w-4 -translate-x-1/2 rotate-45 bg-white" />
      )}
    </div>
  );
}
