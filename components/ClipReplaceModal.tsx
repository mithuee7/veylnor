"use client";

import { useEffect, useMemo, useState } from "react";
import { SequenceItem } from "@/types";

type Category = { id: string; name: string };
type ClipOption = SequenceItem["clip"];

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) throw new Error(`Server returned an empty response (HTTP ${response.status}).`);
  try { return JSON.parse(text); } catch { throw new Error(`Server returned invalid JSON (HTTP ${response.status}).`); }
}

export default function ClipReplaceModal({
  item,
  excludedClipIds,
  onConfirm,
  onClose,
}: {
  item: SequenceItem;
  excludedClipIds: string[];
  onConfirm: (clip: ClipOption) => void;
  onClose: () => void;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState(item.category);
  const [clips, setClips] = useState<ClipOption[]>([]);
  const [selected, setSelected] = useState<ClipOption | null>(null);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [loadingClips, setLoadingClips] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const pageSize = 24;

  const excluded = useMemo(() => new Set(excludedClipIds.filter((id) => id !== item.clip.id)), [excludedClipIds, item.clip.id]);
  const targetDuration = Number(item.targetDuration);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/categories", { cache: "no-store" });
        const data = await readJson(response);
        if (!response.ok) throw new Error(data.error || "Could not load clip folders.");
        if (cancelled) return;
        const next = data.categories ?? [];
        setCategories(next);
        if (!next.some((candidate: Category) => candidate.name === item.category) && next[0]) setCategory(next[0].name);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Could not load clip folders.");
      } finally {
        if (!cancelled) setLoadingCategories(false);
      }
    })();
    return () => { cancelled = true; };
  }, [item.category]);

  useEffect(() => {
    if (!category) return;
    let cancelled = false;
    (async () => {
      setLoadingClips(true);
      setError("");
      try {
        const response = await fetch(`/api/clips?category=${encodeURIComponent(category)}&limit=${pageSize}&offset=${page * pageSize}`, { cache: "no-store" });
        const data = await readJson(response);
        if (!response.ok) throw new Error(data.error || "Could not load clips.");
        if (cancelled) return;
        setClips(data.clips ?? []);
        setHasMore(Boolean(data.hasMore));
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Could not load clips.");
      } finally {
        if (!cancelled) setLoadingClips(false);
      }
    })();
    return () => { cancelled = true; };
  }, [category, page]);

  function chooseCategory(next: string) {
    setCategory(next);
    setPage(0);
    setSelected(null);
  }

  const availableClips = clips.filter((clip) => clip.id === item.clip.id || (!excluded.has(clip.id) && Number(clip.duration ?? 0) + 0.01 >= targetDuration));

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-4">
      <div className="card w-full max-w-6xl max-h-[94vh] overflow-hidden flex flex-col">
        <div className="p-4 sm:p-5 border-b border-panelBorder flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="label">REPLACE CLIP · SCENE {item.position}</p>
            <h2 className="font-display text-xl text-ink truncate">Choose footage for this slot</h2>
            <p className="text-xs text-muted mt-1">Fixed scene duration: <span className="font-mono text-goldSoft">{targetDuration.toFixed(3)}s</span>. The rest of the reel stays unchanged.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink shrink-0" aria-label="Close">✕</button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_320px] min-h-0 flex-1">
          <div className="p-4 border-b lg:border-b-0 lg:border-r border-panelBorder overflow-y-auto">
            <p className="label mb-2">FOLDER</p>
            {loadingCategories ? <p className="text-xs text-muted">Loading…</p> : (
              <div className="space-y-1">
                {categories.map((candidate) => (
                  <button key={candidate.id} onClick={() => chooseCategory(candidate.name)} className={`w-full text-left px-3 py-2 rounded text-sm ${candidate.name === category ? "bg-white/6 text-goldSoft" : "text-ink hover:bg-white/5"}`}>
                    {candidate.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div><p className="label">CLIPS</p><p className="text-xs text-muted">Only clips long enough to fill this scene are selectable.</p></div>
              <span className="text-[11px] font-mono text-muted">{category || "—"}</span>
            </div>
            {error && <div className="card border-red-900/60 p-3 text-xs text-red-300 mb-3">{error}</div>}
            {loadingClips ? <p className="text-sm text-muted">Loading clips…</p> : availableClips.length === 0 ? <p className="text-sm text-muted">No eligible clips in this folder for a {targetDuration.toFixed(3)}s slot.</p> : (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                {availableClips.map((clip) => {
                  const active = selected?.id === clip.id;
                  return (
                    <button key={clip.id} onClick={() => setSelected(clip)} className={`text-left rounded border overflow-hidden ${active ? "border-gold" : "border-panelBorder hover:border-gold/50"}`}>
                      <div className="aspect-[9/16] bg-black">
                        {clip.url ? <video src={clip.url} muted playsInline preload="metadata" className="w-full h-full object-cover" /> : <div className="h-full flex items-center justify-center text-xs text-muted">Preview unavailable</div>}
                      </div>
                      <div className="p-2 bg-panel">
                        <p className="text-xs text-ink truncate">{clip.filename}</p>
                        <p className="text-[11px] text-muted font-mono">{Number(clip.duration ?? 0).toFixed(2)}s</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-panelBorder">
              <button disabled={page === 0 || loadingClips} onClick={() => { setPage((current) => Math.max(0, current - 1)); setSelected(null); }} className="px-3 py-2 rounded border border-panelBorder text-xs disabled:opacity-40">Previous</button>
              <span className="text-[11px] text-muted">Page {page + 1}</span>
              <button disabled={!hasMore || loadingClips} onClick={() => { setPage((current) => current + 1); setSelected(null); }} className="px-3 py-2 rounded border border-panelBorder text-xs disabled:opacity-40">Next</button>
            </div>
          </div>

          <div className="p-4 border-t lg:border-t-0 lg:border-l border-panelBorder flex flex-col min-h-0">
            <p className="label mb-2">PREVIEW</p>
            <div className="aspect-video bg-black rounded overflow-hidden">
              {selected?.url ? <video key={selected.id} src={selected.url} controls muted playsInline preload="metadata" className="w-full h-full object-contain" /> : <div className="h-full flex items-center justify-center text-xs text-muted px-6 text-center">Select a clip to preview it before replacing Scene {item.position}.</div>}
            </div>
            <div className="mt-3 min-h-0">
              <p className="text-sm text-ink truncate">{selected?.filename ?? "No clip selected"}</p>
              <p className="text-xs text-muted mt-1">{selected ? `${selected.category} · ${Number(selected.duration ?? 0).toFixed(2)}s source` : ""}</p>
            </div>
            <div className="flex justify-end gap-2 mt-auto pt-4">
              <button onClick={onClose} className="px-4 py-2 rounded border border-panelBorder text-sm text-ink">Cancel</button>
              <button onClick={() => selected && onConfirm(selected)} disabled={!selected} className="px-4 py-2 rounded border border-gold text-goldSoft text-sm disabled:opacity-40">Use This Clip</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
