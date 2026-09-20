"use client";

import { useEffect, useRef } from "react";
import { Clip } from "@/types";

export default function ClipPlayerModal({
  clip,
  onClose,
}: {
  clip: Clip & { url: string | null };
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm p-4 md:p-8 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-3xl max-h-[92vh] card overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-panelBorder flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-ink truncate">{clip.filename}</p>
            <p className="text-[11px] text-muted mt-0.5">{clip.category} · {clip.duration != null ? `${Number(clip.duration).toFixed(2)}s` : "duration unknown"}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close player" className="h-8 w-8 rounded border border-panelBorder text-muted hover:text-ink hover:border-gold/60">×</button>
        </div>
        <div className="bg-black flex-1 min-h-0 flex items-center justify-center p-3 md:p-6">
          {clip.url ? (
            <video ref={videoRef} src={clip.url} controls autoPlay playsInline className="max-h-[72vh] max-w-full w-auto h-auto object-contain" />
          ) : (
            <p className="text-sm text-muted">Preview unavailable.</p>
          )}
        </div>
      </div>
    </div>
  );
}
