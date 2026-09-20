"use client";

import { BeatInfo, Clip } from "@/types";

interface SequenceItem {
  position: number;
  category: string;
  clip: Clip & { url: string | null };
}

interface Props {
  songName: string;
  beatInfo: BeatInfo;
  items: SequenceItem[];
}

export default function SequenceResult({ songName, beatInfo, items }: Props) {
  return (
    <div className="space-y-6">
      <div className="card p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <p className="label">Song</p>
          <p className="text-sm text-ink truncate">{songName}</p>
        </div>
        <div>
          <p className="label">BPM</p>
          <p className="text-sm text-ink">{beatInfo.bpm}</p>
        </div>
        <div>
          <p className="label">Cuts</p>
          <p className="text-sm text-ink">{beatInfo.numCuts}</p>
        </div>
        <div>
          <p className="label">Window</p>
          <p className="text-sm text-ink">
            {beatInfo.windowStart.toFixed(1)}s – {beatInfo.windowEnd.toFixed(1)}s
          </p>
        </div>
        <div className="col-span-2 sm:col-span-4">
          <p className="label mb-1">Cut timestamps (s)</p>
          <p className="text-xs text-muted font-mono break-words">
            {beatInfo.cutTimestamps.map((t) => t.toFixed(2)).join(", ")}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {items.map((item) => (
          <div key={item.clip.id} className="card overflow-hidden relative">
            <span className="absolute top-2 left-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-base/90 border border-gold text-goldSoft text-xs font-display">
              {item.position}
            </span>
            <div className="aspect-[9/16] bg-black">
              {item.clip.url && (
                <video
                  src={item.clip.url}
                  muted
                  preload="metadata"
                  className="w-full h-full object-cover"
                />
              )}
            </div>
            <div className="p-2">
              <p className="text-xs text-ink truncate">{item.clip.filename}</p>
              <p className="text-xs text-goldSoft capitalize">{item.category}</p>
              <p className="text-xs text-muted">
                {item.clip.duration ? `${item.clip.duration.toFixed(1)}s` : "—"}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
