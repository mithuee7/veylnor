"use client";

import { useEffect, useRef, useState } from "react";
import RequireSupabaseConfig from "@/components/RequireSupabaseConfig";
import SongSectionSelector from "@/components/SongSectionSelector";
import ReferenceReel from "@/components/ReferenceReel";
import ReelPersonalization from "@/components/ReelPersonalization";
import SequenceEditor from "@/components/SequenceEditor";
import { analyzeSong } from "@/lib/beat-analysis";
import { applyBeatRateToInfo } from "@/lib/beat-grid";
import { BeatInfo, LoadedReference, SequenceItem, Song } from "@/types";

type SongWithUrl = Song & { url: string | null };

type BeatDensity = 1 | 2;

async function readJson(res: Response) {
  const text = await res.text();
  if (!text) throw new Error(`Server returned an empty response (HTTP ${res.status}).`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Server returned invalid JSON (HTTP ${res.status}).`); }
}

function RenderProgress({ progress, stage }: { progress: number; stage: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return <div className="space-y-3" aria-live="polite">
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted min-w-0 break-words">{stage || "Rendering…"}</span>
      <span className="text-sm font-mono text-goldSoft tabular-nums whitespace-nowrap shrink-0">{pct}%</span>
    </div>
    <div className="h-2.5 w-full rounded-full bg-panelBorder overflow-hidden">
      <div className="h-full bg-gold transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
    </div>
  </div>;
}

export default function GeneratePage() {
  return <RequireSupabaseConfig><GeneratePageContent /></RequireSupabaseConfig>;
}

function GeneratePageContent() {
  const [songs, setSongs] = useState<SongWithUrl[]>([]);
  const [songPick, setSongPick] = useState<{ song: SongWithUrl; start: number; end: number } | null>(null);
  const [beatInfo, setBeatInfo] = useState<BeatInfo | null>(null);
  const [beatDensity, setBeatDensity] = useState<BeatDensity>(1);
  const [references, setReferences] = useState<LoadedReference[]>([]);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [reelInstructions, setReelInstructions] = useState("");
  const [textOverlay, setTextOverlay] = useState({ enabled: false, text: "", size: 64, font: "EB Garamond" as "EB Garamond" | "Inter" | "Noto Sans" | "DejaVu Sans" });
  const [items, setItems] = useState<SequenceItem[]>([]);
  const [loadingSongs, setLoadingSongs] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStage, setRenderStage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const songPickRef = useRef<typeof songPick>(null);
  songPickRef.current = songPick;

  useEffect(() => {
    (async () => {
      try {
        const [songRes, preferenceRes] = await Promise.all([
          fetch("/api/songs"),
          fetch("/api/reel-preferences"),
        ]);
        const songJson = await readJson(songRes);
        if (!songRes.ok) throw new Error(songJson.error || "Could not load songs.");
        const loadedSongs = (songJson.songs ?? []) as SongWithUrl[];
        setSongs(loadedSongs);
        if (loadedSongs.length > 0 && !songPickRef.current) {
          const first = loadedSongs[0];
          setSongPick({ song: first, start: 0, end: Math.min(15, Number(first.duration ?? 15)) });
        }

        const preferenceJson = await readJson(preferenceRes);
        if (preferenceRes.ok) {
          setReelInstructions(String(preferenceJson.instructions ?? ""));
        } else {
          // Persistence is optional until the Supabase table is created.
          // Do not show a warning just because the page loaded.
        }
      } catch (e: any) {
        setError(e.message ?? "Could not load the generation page.");
      } finally {
        setLoadingSongs(false);
      }
    })();
  }, []);

  function handleSongChange(song: SongWithUrl, start: number, end: number) {
    const previous = songPickRef.current;
    const songChanged = previous?.song.id !== song.id;
    const rangeChanged = previous?.start !== start || previous?.end !== end;
    if (!songChanged && !rangeChanged) return;
    setSongPick({ song, start, end });
    setBeatInfo(null);
    setItems([]);
    setDownloadUrl("");
  }

  async function analyze(start: number, end: number) {
    if (!songPick?.song.url) return;
    setAnalyzing(true); setError("");
    try {
      const info = await analyzeSong(songPick.song.url, start, end, beatDensity);
      setSongPick({ ...songPick, start, end });
      setBeatInfo(info);
      setItems([]);
      setDownloadUrl("");
    } catch (e: any) {
      setError(e.message ?? "Beat analysis failed.");
    } finally {
      setAnalyzing(false);
    }
  }

  function changeBeatDensity(next: BeatDensity) {
    setBeatDensity(next);
    if (beatInfo) {
      setBeatInfo(applyBeatRateToInfo(beatInfo, next));
      setItems([]);
      setDownloadUrl("");
    }
  }

  async function generate(lockedOnly = false) {
    if (!songPick || !beatInfo) { setError("Select and analyze a song section first."); return; }
    setGenerating(true); setError("");
    try {
      const locked = lockedOnly ? items.filter(x => x.locked).map(x => ({
        position: x.position,
        clip_id: x.clip.id,
        category: x.category,
        role: x.role,
        sourceStart: x.sourceStart,
        sourceEnd: x.sourceEnd,
      })) : [];
      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beatInfo,
          references: references.map(reference => reference.analysis),
          reelInstructions,
          locked,
          avoidOrderClipIds: items.length ? [items.map(x => x.clip.id)] : [],
        }),
      });
      const j = await readJson(r);
      if (!r.ok || j.error) throw new Error(j.error || "AI generation failed.");
      setItems(j.clips);
      setDownloadUrl("");
      if (j.warning) setError(`Note: ${j.warning}`);
    } catch (e: any) {
      setError(e.message ?? "AI generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  async function render() {
    if (!songPick || !items.length) { setError("Select a song and generate a sequence first."); return; }
    setRendering(true); setRenderProgress(1); setRenderStage("Starting MP4 render…"); setError("");
    try {
      const r = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
        body: JSON.stringify({
          songId: songPick.song.id,
          songStart: songPick.start,
          songEnd: songPick.end,
          sequence: items.map(x => ({ clipId: x.clip.id, start: x.sourceStart, end: x.sourceEnd, targetDuration: x.targetDuration, hold: x.shortShot === true })),
          textOverlay,
        }),
      });
      const j = await readJson(r);
      if (!r.ok || j.error) throw new Error(j.error || `Render request failed (HTTP ${r.status}).`);
      if (!j.jobId) throw new Error("Render job was not created.");

      setRenderProgress(2); setRenderStage("Render job started…");
      let transientFailures = 0;
      const started = Date.now();
      while (Date.now() - started < 45 * 60 * 1000) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const statusRes = await fetch(`/api/render?jobId=${encodeURIComponent(j.jobId)}&_=${Date.now()}`, { cache: "no-store" });
          const status = await readJson(statusRes);
          transientFailures = 0;
          if (!statusRes.ok || status.error) throw new Error(status.error || `Could not read render status (HTTP ${statusRes.status}).`);
          setRenderProgress(Number(status.progress ?? 0));
          setRenderStage(status.stage ?? "Rendering…");
          if (status.status === "complete" && status.url) {
            setDownloadUrl(status.url);
            return;
          }
          if (status.status === "failed") throw new Error(status.error || "FFmpeg render failed.");
        } catch (pollError: any) {
          transientFailures++;
          if (transientFailures >= 5) throw pollError;
          setRenderStage("Reconnecting to render job…");
        }
      }
      throw new Error("Render exceeded the 45-minute safety timeout. No MP4 was returned.");
    } catch (e: any) {
      setError(e.message ?? "FFmpeg render failed.");
    } finally {
      setRendering(false); setRenderStage("");
    }
  }

  const songDuration = beatInfo?.duration ?? (songPick ? songPick.end - songPick.start : 0);
  const visualDuration = items.reduce((a, b) => a + b.targetDuration, 0);
  const durationDelta = visualDuration - songDuration;
  const beatInterval = beatInfo ? 60 / beatInfo.bpm / beatInfo.clipsPerBeat : 0;

  return <div className="space-y-7">
    <div>
      <p className="label mb-2">VEYLNOR · V2 PRODUCTION</p>
      <h1 className="font-display text-3xl text-ink mb-1">Build a Reel</h1>
      <p className="text-muted text-sm">Song section → beat-locked structure → references → exact footage → real MP4.</p>
    </div>

    {error && <div className="card border-red-900/60 p-3 text-sm text-red-300">{error}</div>}

    <section className="space-y-3">
      <div className="step">01 <span>SONG + EXACT SECTION</span></div>
      {loadingSongs ? <p className="text-sm text-muted">Loading songs…</p> :
       songs.length === 0 ? <p className="text-sm text-muted">Upload songs in the Songs page first.</p> :
       <SongSectionSelector songs={songs} value={songPick} onSelect={handleSongChange} onAnalyze={analyze} analyzing={analyzing} />}
    </section>

    <ReelPersonalization value={reelInstructions} onChange={setReelInstructions} />

    <section className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="label">TEXT OVERLAY</p>
          <p className="text-sm text-muted mt-1">Optional centered text baked into the final MP4.</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={textOverlay.enabled}
            onChange={e => setTextOverlay(prev => ({ ...prev, enabled: e.target.checked }))}
            className="accent-gold"
          />
          Add text
        </label>
      </div>
      {textOverlay.enabled && <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-[1fr_auto_auto]">
          <div className="space-y-2">
            <label className="label">TEXT</label>
            <input
              value={textOverlay.text}
              maxLength={120}
              onChange={e => setTextOverlay(prev => ({ ...prev, text: e.target.value }))}
              placeholder="our future"
              className="w-full rounded border border-panelBorder bg-black/10 px-3 py-2.5 text-sm text-ink outline-none focus:border-gold"
            />
            <p className="text-[11px] text-muted">Centered horizontally and vertically for the full reel.</p>
          </div>
          <div className="space-y-2">
            <label className="label">SIZE</label>
            <select
              value={textOverlay.size}
              onChange={e => setTextOverlay(prev => ({ ...prev, size: Number(e.target.value) }))}
              className="rounded border border-panelBorder bg-black/10 px-3 py-2.5 text-sm text-ink outline-none focus:border-gold"
            >
              <option value={48}>Small · 48</option>
              <option value={64}>Medium · 64</option>
              <option value={80}>Large · 80</option>
              <option value={96}>XL · 96</option>
              <option value={112}>XXL · 112</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="label">FONT</label>
            <select
              value={textOverlay.font}
              onChange={e => setTextOverlay(prev => ({ ...prev, font: e.target.value as typeof textOverlay.font }))}
              className="rounded border border-panelBorder bg-black/10 px-3 py-2.5 text-sm text-ink outline-none focus:border-gold"
            >
              <option value="EB Garamond">EB Garamond · elegant</option>
              <option value="Inter">Inter · clean</option>
              <option value="Noto Sans">Noto Sans · neutral</option>
              <option value="DejaVu Sans">DejaVu Sans · fallback</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[180px_1fr] items-start">
          <div>
            <p className="label mb-2">LIVE PREVIEW</p>
            <div className="mx-auto aspect-[9/16] w-[180px] overflow-hidden rounded-lg border border-panelBorder bg-[radial-gradient(circle_at_50%_35%,rgba(201,162,75,0.16),transparent_45%),#08080a] relative">
              <div
                className="absolute inset-0 flex items-center justify-center px-4 text-center whitespace-pre-wrap break-words"
                style={{
                  fontFamily: textOverlay.font === "EB Garamond" ? '"EB Garamond Local", Georgia, serif' : textOverlay.font,
                  fontSize: `${Math.max(40, Math.min(112, textOverlay.size)) / 5.8}px`,
                  lineHeight: 1.05,
                  textShadow: "0 2px 7px rgba(0,0,0,.8)",
                }}
              >
                {textOverlay.text || "our future"}
              </div>
            </div>
            <p className="text-[11px] text-muted text-center mt-2">9:16 center placement</p>
          </div>

          <div className="space-y-3">
            <div>
              <p className="label">SIZE PREVIEW</p>
              <p className="text-[11px] text-muted mt-1">These samples use the same font and show how each render size will look.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {[48, 64, 80, 96, 112].map(size => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setTextOverlay(prev => ({ ...prev, size }))}
                  className={`rounded-lg border px-3 py-2 text-left transition ${textOverlay.size === size ? "border-gold bg-gold/5" : "border-panelBorder hover:border-gold/40"}`}
                >
                  <span className="label">{size}px</span>
                  <span
                    className="block mt-1 truncate"
                    style={{ fontFamily: textOverlay.font === "EB Garamond" ? '"EB Garamond Local", Georgia, serif' : textOverlay.font, fontSize: `${Math.max(14, size / 2.8)}px`, lineHeight: 1.1 }}
                  >
                    {textOverlay.text || "our future"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>}
    </section>

    {beatInfo && <section className="card p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="label">02 · BEAT GRID</p>
          <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm mt-2">
            <div><p className="label">BPM</p><p className="text-ink">{beatInfo.bpm}</p></div>
            <div><p className="label">CLIP INTERVAL</p><p className="text-ink">{beatInterval.toFixed(3)}s</p></div>
            <div><p className="label">DURATION</p><p className="text-ink">{beatInfo.duration.toFixed(3)}s</p></div>
            <div><p className="label">CLIPS</p><p className="text-ink">{beatInfo.numCuts}</p></div>
          </div>
        </div>
        <div className="rounded-lg border border-panelBorder p-1 flex items-center bg-black/10">
          <button onClick={() => changeBeatDensity(1)} className={`px-3 py-2 rounded text-xs transition ${beatDensity === 1 ? "bg-gold text-base" : "text-muted hover:text-ink"}`}>1× · 1 per beat</button>
          <button onClick={() => changeBeatDensity(2)} className={`px-3 py-2 rounded text-xs transition ${beatDensity === 2 ? "bg-gold text-base" : "text-muted hover:text-ink"}`}>2× · 2 per beat</button>
        </div>
      </div>
      <p className="text-xs text-muted">Default: one clip changes on each beat. 2× splits every beat into two equal visual slots. The grid is derived directly from the song BPM.</p>
      <p className="text-xs text-muted font-mono break-words">Beat cuts: {beatInfo.cutTimestamps.map(x => x.toFixed(3)).join(" · ")}</p>
    </section>}

    {beatInfo && <section className="space-y-3">
      <div className="step">03 <span>REFERENCE REELS</span></div>
      <ReferenceReel value={references} onChange={setReferences} onBusyChange={setReferenceBusy} />
    </section>}

    {beatInfo && <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="label">04 · AI SEQUENCE</p>
          <p className="text-sm text-muted mt-1">
            {references.length ? `${references.length} reference reel${references.length === 1 ? "" : "s"} active. ` : ""}
            {reelInstructions.trim() ? "Saved personal instructions are active. " : ""}
            AI uses the beat grid and your live clip taxonomy.
          </p>
        </div>
        <button onClick={() => generate(false)} disabled={generating || referenceBusy} className="px-5 py-2.5 rounded border border-gold text-goldSoft text-sm hover:bg-gold/10 disabled:opacity-50">{generating ? "Generating…" : referenceBusy ? "Finishing references…" : "Generate sequence"}</button>
      </div>
    </section>}

    {items.length > 0 && <section className="space-y-5">
      <SequenceEditor items={items} onChange={next => { setItems(next); setDownloadUrl(""); }} onRegenerate={() => generate(true)} regenerating={generating} />
      <div className="card p-5 space-y-4">
        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="label">05 · FINAL RENDER</p>
            <p className="text-sm text-muted">{visualDuration.toFixed(3)}s visual · {songDuration.toFixed(3)}s selected audio · delta {durationDelta >= 0 ? "+" : ""}{durationDelta.toFixed(3)}s</p>
          </div>
        </div>
        {rendering && <div className="space-y-2"><RenderProgress progress={renderProgress} stage={renderStage} /><p className="text-[11px] text-muted">Rendering one clip at a time to stay within the 512 MB memory limit.</p></div>}

        {downloadUrl && !rendering && <div className="space-y-3">
          <div className="rounded-lg overflow-hidden border border-panelBorder bg-black">
            <video key={downloadUrl} src={downloadUrl} controls playsInline className="w-full max-h-[70vh] bg-black" />
          </div>
          <a href={downloadUrl} target="_blank" rel="noreferrer" className="inline-flex px-4 py-2 rounded border border-panelBorder text-sm text-ink hover:border-gold">Open / download MP4</a>
        </div>}

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => render()} disabled={rendering} className="px-5 py-2.5 rounded bg-gold text-base text-sm font-medium hover:opacity-90 disabled:opacity-50">{rendering ? "Rendering…" : downloadUrl ? "Render again" : "Generate MP4"}</button>
        </div>
      </div>
    </section>}
  </div>;
}
