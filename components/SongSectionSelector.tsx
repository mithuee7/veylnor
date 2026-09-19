"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Song } from "@/types";

type SongWithUrl = Song & { url: string | null };

type SongPick = { song: SongWithUrl; start: number; end: number } | null;

function fmt(t: number) {
  const safe = Math.max(0, Number.isFinite(t) ? t : 0);
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function parseSeconds(raw: string) {
  const cleaned = raw.trim().replace(/,/g, ".");
  if (cleaned === "" || cleaned === ".") return null;
  if (!/^\d+(?:\.\d*)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatInputSeconds(t: number) {
  if (!Number.isFinite(t)) return "0";
  return t.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export default function SongSectionSelector({
  songs,
  value,
  onSelect,
  onAnalyze,
  analyzing,
}: {
  songs: SongWithUrl[];
  value: SongPick;
  onSelect: (song: SongWithUrl, start: number, end: number) => void;
  onAnalyze: (start: number, end: number) => void;
  analyzing: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playingSelection, setPlayingSelection] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [startText, setStartText] = useState(formatInputSeconds(value?.start ?? 0));
  const [endText, setEndText] = useState(formatInputSeconds(value?.end ?? Math.min(15, Number(value?.song.duration ?? 15))));
  const [startError, setStartError] = useState("");
  const [endError, setEndError] = useState("");

  const song = value?.song ?? null;
  const start = value?.start ?? 0;
  const end = value?.end ?? Math.min(15, Number(song?.duration ?? 15));
  const duration = Math.max(0.25, Number(song?.duration ?? 30));

  useEffect(() => {
    setStartText(formatInputSeconds(start));
    setEndText(formatInputSeconds(end));
    setStartError("");
    setEndError("");
  }, [start, end, song?.id]);

  useEffect(() => {
    setCurrentTime(Math.min(duration, start));
    setPlayingSelection(false);
    setAudioPlaying(false);
    audioRef.current?.pause();
  }, [song?.id]);

  useEffect(() => {
    if (!song?.url) {
      setPeaks([]);
      return;
    }
    let cancelled = false;
    let ctx: AudioContext | null = null;
    (async () => {
      try {
        const res = await fetch(song.url!);
        if (!res.ok) throw new Error("Could not load waveform audio");
        const buf = await res.arrayBuffer();
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf.slice(0));
        const data = audio.getChannelData(0);
        const count = 180;
        const step = Math.max(1, Math.floor(data.length / count));
        const next: number[] = [];
        for (let i = 0; i < count; i++) {
          let max = 0;
          const a = i * step;
          const b = Math.min(data.length, a + step);
          for (let j = a; j < b; j += Math.max(1, Math.floor(step / 24))) {
            max = Math.max(max, Math.abs(data[j]));
          }
          next.push(max);
        }
        if (!cancelled) setPeaks(next);
      } catch {
        if (!cancelled) setPeaks([]);
      } finally {
        await ctx?.close().catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [song?.id, song?.url]);

  function publish(nextStart: number, nextEnd: number) {
    if (!song) return;
    onSelect(song, nextStart, nextEnd);
  }

  function setClampedStart(n: number) {
    const maxStart = Math.max(0, end - 0.05);
    const next = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, maxStart));
    setStartError("");
    publish(next, end);
  }

  function setClampedEnd(n: number) {
    const minEnd = Math.min(duration, start + 0.05);
    const next = Math.min(duration, Math.max(Number.isFinite(n) ? n : minEnd, minEnd));
    setEndError("");
    publish(start, next);
  }

  function commitStart(raw: string) {
    const n = parseSeconds(raw);
    if (n === null) {
      setStartError("Enter a valid number of seconds.");
      return;
    }
    const maxStart = Math.max(0, end - 0.05);
    if (n > maxStart) {
      setStartError(`Start can't be later than ${formatInputSeconds(maxStart)}s.`);
      return;
    }
    setStartError("");
    publish(n, end);
  }

  function commitEnd(raw: string) {
    const n = parseSeconds(raw);
    if (n === null) {
      setEndError("Enter a valid number of seconds.");
      return;
    }
    const minEnd = Math.min(duration, start + 0.05);
    if (n < minEnd) {
      setEndError(`End must be after ${formatInputSeconds(minEnd)}s.`);
      return;
    }
    if (n > duration) {
      setEndError(`End can't exceed the song duration (${formatInputSeconds(duration)}s).`);
      return;
    }
    setEndError("");
    publish(start, n);
  }

  function selectSong(songId: string) {
    const nextSong = songs.find((candidate) => candidate.id === songId);
    if (!nextSong) return;
    const nextEnd = Math.min(15, Number(nextSong.duration ?? 15));
    onSelect(nextSong, 0, nextEnd);
  }

  function playSelection() {
    const a = audioRef.current;
    if (!a || !song?.url) return;
    a.currentTime = start;
    setPlayingSelection(true);
    setAudioPlaying(true);
    void a.play().catch(() => setAudioPlaying(false));
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a || !song?.url) return;
    if (a.paused) {
      setPlayingSelection(false);
      setAudioPlaying(true);
      void a.play().catch(() => setAudioPlaying(false));
    } else {
      a.pause();
      setAudioPlaying(false);
    }
  }

  function handleTimeUpdate() {
    const a = audioRef.current;
    if (!a) return;
    setCurrentTime(a.currentTime);
    if (playingSelection && a.currentTime >= end - 0.01) {
      a.pause();
      a.currentTime = end;
      setPlayingSelection(false);
      setAudioPlaying(false);
      setCurrentTime(end);
    }
  }

  function handleSeek(raw: string) {
    const a = audioRef.current;
    const next = Math.max(0, Math.min(duration, Number(raw)));
    if (a) a.currentTime = next;
    setCurrentTime(next);
    setPlayingSelection(false);
  }

  const rangeStyle = useMemo(() => ({
    left: `${Math.max(0, Math.min(100, (start / duration) * 100))}%`,
    width: `${Math.max(0, Math.min(100, ((end - start) / duration) * 100))}%`,
  }), [start, end, duration]);

  return (
    <div className="card p-4 sm:p-5 space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <label className="label shrink-0">SONG</label>
          <select value={song?.id ?? ""} onChange={(e) => selectSong(e.target.value)} className="bg-base border border-panelBorder rounded px-3 py-2 text-sm min-w-0 w-full lg:w-[320px]">
            {songs.map((s) => <option key={s.id} value={s.id}>{s.filename}</option>)}
          </select>
        </div>
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <button onClick={togglePlay} disabled={!song?.url} className="w-9 h-9 rounded-full border border-panelBorder text-ink hover:border-gold shrink-0">{audioPlaying ? "Ⅱ" : "▶"}</button>
          <input aria-label="Song playback position" type="range" min="0" max={duration} step="0.001" value={Math.min(duration, currentTime)} onChange={(e) => handleSeek(e.target.value)} className="range flex-1" />
          <span className="text-[11px] font-mono text-muted tabular-nums whitespace-nowrap">{fmt(currentTime)}</span>
        </div>
      </div>

      {song?.url && <audio ref={audioRef} src={song.url} preload="metadata" className="hidden" onTimeUpdate={handleTimeUpdate} onEnded={() => { setPlayingSelection(false); setAudioPlaying(false); }} />}

      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-1 text-xs">
          <div className="text-muted">SONG SECTION <span className="text-ink font-mono">{fmt(start)} → {fmt(end)}</span></div>
          <div className="text-goldSoft font-mono">Selected {fmt(end - start)}</div>
        </div>
        <div className="relative h-28 bg-black rounded border border-panelBorder overflow-hidden select-none">
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-end gap-px px-2 h-20 opacity-80 pointer-events-none">
            {(peaks.length ? peaks : Array.from({ length: 180 }, () => 0.08)).map((p, i) => (
              <span key={i} className="flex-1 bg-goldSoft/70 rounded-full min-w-0" style={{ height: `${Math.max(4, p * 80)}%` }} />
            ))}
          </div>
          <div className="absolute top-0 bottom-0 bg-gold/10 border-x-2 border-goldSoft pointer-events-none" style={rangeStyle} />
          <div className="absolute top-0 bottom-0 w-px bg-ink/80 pointer-events-none" style={{ left: `${Math.max(0, Math.min(100, (currentTime / duration) * 100))}%` }} />

          <div
            className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <button
            type="button"
            aria-label={`Song start: ${formatInputSeconds(start)} seconds`}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, end - 0.05)}
            aria-valuenow={start}
            className="absolute top-1/2 z-20 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-goldSoft bg-gold shadow-lg cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-gold/50"
            style={{ left: `${Math.max(0, Math.min(100, (start / duration) * 100))}%`, touchAction: "none" }}
            onPointerDown={(event) => {
              event.preventDefault();
              const track = event.currentTarget.parentElement;
              if (!track) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              const update = (clientX: number) => {
                const rect = track.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                setClampedStart(ratio * duration);
              };
              const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up, { once: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setClampedStart(start - 0.01);
              if (event.key === "ArrowRight") setClampedStart(start + 0.01);
              if (event.key === "Home") setClampedStart(0);
              if (event.key === "End") setClampedStart(end - 0.05);
            }}
          >
            <span className="sr-only">START</span>
          </button>
          <button
            type="button"
            aria-label={`Song end: ${formatInputSeconds(end)} seconds`}
            role="slider"
            aria-valuemin={Math.min(duration, start + 0.05)}
            aria-valuemax={duration}
            aria-valuenow={end}
            className="absolute top-1/2 z-20 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-goldSoft bg-gold shadow-lg cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-gold/50"
            style={{ left: `${Math.max(0, Math.min(100, (end / duration) * 100))}%`, touchAction: "none" }}
            onPointerDown={(event) => {
              event.preventDefault();
              const track = event.currentTarget.parentElement;
              if (!track) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              const update = (clientX: number) => {
                const rect = track.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                setClampedEnd(ratio * duration);
              };
              const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up, { once: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setClampedEnd(end - 0.01);
              if (event.key === "ArrowRight") setClampedEnd(end + 0.01);
              if (event.key === "Home") setClampedEnd(start + 0.05);
              if (event.key === "End") setClampedEnd(duration);
            }}
          >
            <span className="sr-only">END</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs text-muted">Start (seconds)
            <input
              inputMode="decimal"
              type="text"
              value={startText}
              onChange={(e) => { setStartText(e.target.value); setStartError(""); }}
              onBlur={() => commitStart(startText)}
              onKeyDown={(e) => { if (e.key === "Enter") commitStart(startText); }}
              className={`block mt-1 w-full bg-base border rounded px-3 py-2 text-sm text-ink font-mono ${startError ? "border-red-500/70" : "border-panelBorder"}`}
            />
            {startError && <span className="block mt-1 text-[11px] text-red-300">{startError}</span>}
          </label>
          <label className="text-xs text-muted">End (seconds)
            <input
              inputMode="decimal"
              type="text"
              value={endText}
              onChange={(e) => { setEndText(e.target.value); setEndError(""); }}
              onBlur={() => commitEnd(endText)}
              onKeyDown={(e) => { if (e.key === "Enter") commitEnd(endText); }}
              className={`block mt-1 w-full bg-base border rounded px-3 py-2 text-sm text-ink font-mono ${endError ? "border-red-500/70" : "border-panelBorder"}`}
            />
            {endError && <span className="block mt-1 text-[11px] text-red-300">{endError}</span>}
            <span className="block mt-1 text-[10px] text-muted">Max: {formatInputSeconds(duration)}s</span>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={togglePlay} className="px-3 py-2 rounded border border-panelBorder text-sm text-ink hover:border-gold">{audioPlaying ? "Pause" : "Play"}</button>
        <button onClick={playSelection} className={`px-3 py-2 rounded border text-sm ${playingSelection ? "border-gold text-goldSoft" : "border-panelBorder text-ink hover:border-gold"}`}>Play selected</button>
        <button onClick={() => { const a = audioRef.current; if (a) a.currentTime = start; setCurrentTime(start); }} className="px-3 py-2 rounded border border-panelBorder text-sm text-ink hover:border-gold">Jump to start</button>
        <button onClick={() => song && onAnalyze(start, end)} disabled={!song || analyzing} className="ml-auto px-4 py-2 rounded border border-gold text-goldSoft text-sm hover:bg-gold/10 disabled:opacity-50">
          {analyzing ? "Analyzing beats…" : "Analyze selected section"}
        </button>
      </div>
    </div>
  );
}
